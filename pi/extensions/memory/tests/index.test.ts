import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryExtension, safelySchedule } from "../index.ts";
import { DEFAULT_INJECTION_MAX_CHARS, DEFAULT_LIMITS, type MemoryConfig } from "../config.ts";
import type { TargetSnapshot } from "../store.ts";

// The test runner can inherit Pi's child marker; ordinary lifecycle cases require a top-level process.
delete process.env.PI_SUBAGENT_CHILD;

const config: MemoryConfig = { vaultRoot: "/vault", memorySubdirectory: "memory", limits: { ...DEFAULT_LIMITS }, injection: { mode: "retrieval-first", maxChars: DEFAULT_INJECTION_MAX_CHARS, pins: { user: [], global: [], repository: [] } } };
const enabled: MemoryConfig = { ...config, autoConsolidation: { enabled: true } };
const reviewEnabled: MemoryConfig = { ...config, autoReview: { enabled: true } };
const snapshot = { identity: { scope: "cwd-0123456789abcdef", directory: "repo-01234567" }, user: [], global: [], repository: [], text: "<memory-context>\nfrozen\n</memory-context>" };
const candidate: TargetSnapshot = { target: "global", entries: ["x".repeat(1800)], serialized: `${"x".repeat(1800)}\n`, usage: 1801, limit: 2200, path: "/vault/memory/MEMORY.md" };

function harness(overrides: any = {}) {
  const handlers = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>(), calls: string[] = [];
  const pi: any = { on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command) };
  createMemoryExtension({
    loadConfig: async () => config, loadSnapshot: async () => snapshot,
    viewMemory: async (_config: any, _cwd: string, target: string) => ({ entries: target === "user" ? ["Saved preference."] : [], usage: 18, limit: 1375 }),
    mutateMemory: async (_config: any, _cwd: string, target: string, action: string) => { calls.push(`${target}:${action}`); return { entries: ["Updated preference."], usage: 20, limit: 1375 }; },
    selectConsolidationTarget: async () => candidate,
    consolidateSnapshot: async () => ({ code: "committed", message: "global memory consolidated" }),
    ...overrides,
  })(pi);
  return { handlers, tools, commands, calls };
}

const later = () => new Promise(resolve => setImmediate(resolve));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const ended = async (x: ReturnType<typeof harness>, user: string, assistant: string) => x.handlers.get("agent_end")({ messages: [{ role: "user", content: user }, { role: "assistant", content: assistant }] });

test("session-start snapshot is appended to the existing system prompt while the manual tool reads and writes live memory", { timeout: 5000 }, async () => {
  const x = harness(), ctx: any = { cwd: "/repo", hasUI: false };
  await x.handlers.get("session_start")({}, ctx);
  await later();
  const supplied = async () => (await x.handlers.get("before_agent_start")({ prompt: "q", systemPrompt: "base prompt", systemPromptOptions: {} }, ctx)).systemPrompt;
  assert.equal(await supplied(), `base prompt\n\n${snapshot.text}`);
  const tool = x.tools.get("memory");
  assert.deepEqual((await tool.execute("view", { action: "view", target: "user" }, undefined, undefined, ctx)).details.entries, ["Saved preference."]);
  assert.equal((await tool.execute("add", { action: "add", target: "user", content: "Updated preference." }, undefined, undefined, ctx)).details.code, "ok");
  assert.deepEqual(x.calls, ["user:add"]);
  // Live writes never mutate the frozen snapshot supplied to the model.
  assert.equal(await supplied(), `base prompt\n\n${snapshot.text}`);
});

test("automatic consolidation runs only after settlement when explicitly enabled", { timeout: 5000 }, async () => {
  let calls = 0;
  const x = harness({ loadConfig: async () => enabled, consolidateSnapshot: async () => { calls++; return { code: "committed", message: "done" }; } });
  const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
  await x.handlers.get("session_start")({}, ctx);
  assert.equal(calls, 0);
  await x.handlers.get("agent_settled")({}, ctx); await later(); await later();
  assert.equal(calls, 1);
});

test("disabled automatic review makes zero review model calls", { timeout: 5000 }, async () => {
  let calls = 0;
  const x = harness({ reviewExchange: async () => { calls++; return { code: "no_changes", message: "none" }; } });
  const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
  await x.handlers.get("session_start")({}, ctx);
  await ended(x, "remember this", "okay");
  await x.handlers.get("agent_settled")({}, ctx);
  await later(); await later();
  assert.equal(calls, 0);
});

test("review queue drops oldest pending exchanges and reports the count", { timeout: 5000 }, async () => {
  let calls = 0;
  const x = harness({ loadConfig: async () => reviewEnabled, reviewExchange: async () => { calls++; return { code: "no_changes", message: "none" }; } });
  const notices: string[] = [];
  const ctx: any = { cwd: "/repo", hasUI: true, ui: { notify: (message: string) => notices.push(message) }, modelRegistry: {} };
  await x.handlers.get("session_start")({}, ctx);
  const events: Promise<unknown>[] = [];
  for (let index = 0; index < 7; index++) {
    events.push(ended(x, `u${index}`, `a${index}`), x.handlers.get("agent_settled")({}, ctx));
  }
  await Promise.all(events);
  await later(); await later(); await later();
  assert.equal(calls, 5);
  await x.commands.get("memory-status").handler("", ctx);
  assert.match(notices.join("\n"), /dropped reviews: 2/);
});

test("throwing review work cannot become an unhandled rejection", { timeout: 5000 }, async () => {
  let unhandled = false;
  const listener = () => { unhandled = true; };
  process.on("unhandledRejection", listener);
  try {
    const x = harness({ loadConfig: async () => reviewEnabled, reviewExchange: async () => { throw new Error("provider exploded"); } });
    const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
    await x.handlers.get("session_start")({}, ctx);
    await ended(x, "u", "a");
    await x.handlers.get("agent_settled")({}, ctx);
    await later(); await later();
    assert.equal(unhandled, false);
  } finally { process.off("unhandledRejection", listener); }
});

test("manual compaction skips an empty store without a model call", { timeout: 5000 }, async () => {
  let modelCalls = 0;
  const x = harness({ selectConsolidationTarget: async () => undefined, consolidateSnapshot: async () => { modelCalls++; return { code: "committed", message: "unexpected" }; } });
  await x.commands.get("memory-compact").handler("", { cwd: "/repo", hasUI: false, modelRegistry: {} });
  assert.equal(modelCalls, 0);
});

test("shutdown returns while an abort-ignoring consolidation is unresolved", { timeout: 5000 }, async () => {
  const x = harness({ consolidateSnapshot: async () => new Promise<never>(() => {}) });
  const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
  const compact = x.commands.get("memory-compact").handler("", ctx);
  await later();
  await x.handlers.get("session_shutdown")({}, ctx);
  assert.equal(await Promise.race([compact.then(() => "settled"), delay(100).then(() => "timed_out")]), "settled");
});

test("an abort-ignoring call cannot produce a second concurrent model call and reports in_progress", { timeout: 5000 }, async () => {
  let calls = 0;
  // Ignores its AbortSignal entirely, exactly like a provider that never honors abort.
  const x = harness({ loadConfig: async () => enabled, consolidateSnapshot: async () => { calls++; return new Promise<never>(() => {}); } });
  const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
  await x.handlers.get("session_start")({}, ctx);
  await x.handlers.get("agent_settled")({}, ctx); await later(); await later();
  assert.equal(calls, 1);
  // The first call is still pending; the abort race settling must not free the gate.
  await x.handlers.get("session_shutdown")({}, ctx); await later(); await later();
  await x.handlers.get("session_start")({}, ctx);
  await x.handlers.get("agent_settled")({}, ctx); await later(); await later();
  assert.equal(calls, 1, "an unresolved model call must not be joined by a second concurrent call");
  const notices: string[] = [];
  await x.commands.get("memory-compact").handler("", { ...ctx, hasUI: true, ui: { notify: (message: string) => notices.push(message) } });
  assert.equal(calls, 1, "manual compaction must not start a second concurrent call either");
  assert.match(notices.join(" "), /in_progress/);
});

test("session_start after session_shutdown restores injection and consolidation", { timeout: 5000 }, async () => {
  let calls = 0;
  const x = harness({ loadConfig: async () => enabled, consolidateSnapshot: async () => { calls++; return { code: "committed", message: "done" }; } });
  const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
  await x.handlers.get("session_start")({}, ctx); await later();
  await x.handlers.get("session_shutdown")({}, ctx);
  // Simulates /new or /resume: the extension instance is reused for the next session.
  await x.handlers.get("session_start")({}, ctx); await later();
  assert.equal((await x.handlers.get("before_agent_start")({ prompt: "q", systemPrompt: "base prompt", systemPromptOptions: {} }, ctx)).systemPrompt, `base prompt\n\n${snapshot.text}`, "injection must work again after a shutdown");
  await x.handlers.get("agent_settled")({}, ctx); await later(); await later();
  assert.equal(calls, 1, "automatic consolidation must work again after a shutdown");
});

test("a stale detached load from a previous generation cannot overwrite the current snapshot", { timeout: 5000 }, async () => {
  let release: ((value: any) => void) | undefined;
  const stale = { ...snapshot, text: "<memory-context>\nSTALE\n</memory-context>" };
  let call = 0;
  const x = harness({
    loadSnapshot: async () => {
      call++;
      // The first session's load hangs until after the second session has started.
      if (call === 1) return new Promise(resolve => { release = resolve; });
      return snapshot;
    },
  });
  const ctx: any = { cwd: "/repo", hasUI: false };
  await x.handlers.get("session_start")({}, ctx);
  await x.handlers.get("session_shutdown")({}, ctx);
  await x.handlers.get("session_start")({}, ctx); await later(); await later();
  // The first session's load now resolves, far too late to be valid.
  release?.(stale);
  await later(); await later();
  assert.equal((await x.handlers.get("before_agent_start")({ prompt: "q", systemPrompt: "base prompt", systemPromptOptions: {} }, ctx)).systemPrompt, `base prompt\n\n${snapshot.text}`, "a stale load must not overwrite the newer session's snapshot");
});

test("stale settlement work cannot call a model or commit into a new session", { timeout: 5000 }, async () => {
  let calls = 0;
  const x = harness({ loadConfig: async () => enabled, consolidateSnapshot: async () => {
    calls++;
    return { code: "committed", message: "unexpected stale commit" };
  } });
  const ctx: any = { cwd: "/repo", hasUI: false, modelRegistry: {} };
  await x.handlers.get("session_start")({}, ctx);
  await x.handlers.get("agent_settled")({}, ctx);
  await x.handlers.get("session_shutdown")({}, ctx);
  await x.handlers.get("session_start")({}, ctx);
  await later(); await later();
  assert.equal(calls, 0);
});

test("background work cannot become an unhandled rejection", { timeout: 5000 }, async () => {
  let unhandled = false, observed = false;
  const listener = () => { unhandled = true; };
  process.on("unhandledRejection", listener);
  try {
    safelySchedule(async () => { throw new Error("boom"); }, () => { observed = true; });
    await later(); await later();
    assert.equal(observed, true); assert.equal(unhandled, false);
  } finally { process.off("unhandledRejection", listener); }
});

test("session-start does not block, and a slow initial load injects nothing after its bounded wait", { timeout: 5000 }, async () => {
  const never = new Promise<never>(() => {});
  const x = harness({ loadConfig: async () => never });
  const ctx: any = { cwd: "/repo", hasUI: false };
  const started = Date.now();
  await x.handlers.get("session_start")({}, ctx);
  assert.ok(Date.now() - started < 50, "session_start must not wait for memory I/O");
  const turn = x.handlers.get("before_agent_start")({}, ctx);
  assert.equal(await Promise.race([turn.then(() => "settled"), delay(2_500).then(() => "timed_out")]), "settled");
  assert.equal(await turn, undefined);
});

test("session-start and injection degrade safely for exotic rejection reasons", { timeout: 5000 }, async () => {
  const x = harness({ loadConfig: async () => { throw Object.create(null); } });
  const ctx: any = { cwd: "/repo", hasUI: true, ui: { notify: () => { throw Object.create(null); } } };
  await assert.doesNotReject(() => x.handlers.get("session_start")({}, ctx));
  await later();
  await assert.doesNotReject(() => x.handlers.get("before_agent_start")({}, ctx));
  assert.equal(await x.handlers.get("before_agent_start")({}, ctx), undefined);
});

test("child processes register no tool, commands, or consolidation", { timeout: 5000 }, async () => {
  const previous = process.env.PI_SUBAGENT_CHILD; process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const x = harness();
    assert.equal(x.tools.size, 0); assert.equal(x.commands.size, 0); assert.deepEqual([...x.handlers.keys()], ["context"]);
    assert.deepEqual((await x.handlers.get("context")({ messages: [{ role: "custom", customType: "pi-memory-context" }, { role: "user", content: "keep" }] })).messages, [{ role: "user", content: "keep" }]);
    await assert.doesNotReject(() => x.handlers.get("context")({ messages: null }));
    assert.equal(await x.handlers.get("context")({}), undefined);
  } finally { if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous; }
});


const runBeforeAgentStart = async (x: ReturnType<typeof harness>, basePrompt: string, ctx: any, otherHandlers: any[] = []) => {
  let forced: string | undefined;
  for (const handler of [...otherHandlers.slice(0, 1), x.handlers.get("before_agent_start"), ...otherHandlers.slice(1)]) {
    const result = await handler({ prompt: "q", get systemPrompt() { return forced ?? basePrompt; }, systemPromptOptions: {} }, ctx);
    if (result?.systemPrompt !== undefined) forced = result.systemPrompt;
  }
  return forced;
};
const forcedProjection = async (x: ReturnType<typeof harness>, messages: any[], forced: string, ctx: any) => {
  const leadingSystem = messages.find(message => message.role === "system");
  const visible = messages.filter(message => message.role !== "system");
  const cleaned = await x.handlers.get("context")({ messages: visible }, ctx);
  return [{ role: "system", content: forced }, ...(cleaned?.messages ?? visible)];
};

test("memory chains with forced prompts and remains stable through automatic compaction", { timeout: 5000 }, async () => {
  const x = harness(), ctx: any = { cwd: "/repo", hasUI: false };
  await x.handlers.get("session_start")({}, ctx);
  await later();
  const routing = async (event: any) => ({ systemPrompt: `${event.systemPrompt}\n\n<subagent-routing-hints>route</subagent-routing-hints>` });
  const claudeStyle = async (event: any) => ({ systemPrompt: `${event.systemPrompt}\n\n<claude-style>style</claude-style>` });
  const forced = await runBeforeAgentStart(x, "base prompt", ctx, [routing, claudeStyle]);
  assert.equal(forced, `base prompt\n\n<subagent-routing-hints>route</subagent-routing-hints>\n\n${snapshot.text}\n\n<claude-style>style</claude-style>`);
  const first = await forcedProjection(x, [{ role: "system", content: "base prompt" }, { role: "user", content: "first" }, { role: "assistant", content: "tool call" }, { role: "toolResult", content: "tool result" }], forced!, ctx);
  assert.equal(first[0].content, forced);
  assert.deepEqual(first.slice(1), [{ role: "user", content: "first" }, { role: "assistant", content: "tool call" }, { role: "toolResult", content: "tool result" }]);
  // Pi retains forceSystemPrompt for the active run, so its forced projection runs again after automatic compaction.
  const automatic = await forcedProjection(x, [{ role: "system", content: "base prompt" }, { role: "compactionSummary", summary: "automatic summary" }, { role: "user", content: "kept automatic tail" }], forced!, ctx);
  assert.equal(automatic[0].content, forced);
  assert.equal((automatic[0].content.match(/<memory-context>/g) ?? []).length, 1);
  assert.deepEqual(automatic.slice(1), [{ role: "compactionSummary", summary: "automatic summary" }, { role: "user", content: "kept automatic tail" }]);
});

test("a fresh manual-compaction follow-up rebuilds one forced system snapshot and legacy customs are removed", { timeout: 5000 }, async () => {
  const x = harness(), ctx: any = { cwd: "/repo", hasUI: false };
  await x.handlers.get("session_start")({}, ctx);
  await later();
  const forced = await runBeforeAgentStart(x, "base prompt", ctx);
  const legacy = { role: "custom", customType: "pi-memory-context", content: "<memory-context>\nOLD\n</memory-context>", display: false };
  const manual = await forcedProjection(x, [{ role: "system", content: "base prompt" }, { role: "compactionSummary", summary: "manual summary" }, legacy, { role: "user", content: "fresh prompt" }], forced!, ctx);
  assert.equal(manual[0].content, `base prompt\n\n${snapshot.text}`);
  assert.equal((manual[0].content.match(/<memory-context>/g) ?? []).length, 1);
  assert.deepEqual(manual.slice(1), [{ role: "compactionSummary", summary: "manual summary" }, { role: "user", content: "fresh prompt" }]);
});

test("no forced memory snapshot is supplied when startup loading fails", { timeout: 5000 }, async () => {
  const x = harness({ loadSnapshot: async () => { throw new Error("vault unavailable"); } }), ctx: any = { cwd: "/repo", hasUI: false };
  await x.handlers.get("session_start")({}, ctx);
  await later();
  assert.equal(await runBeforeAgentStart(x, "base prompt", ctx), undefined);
});
