import assert from "node:assert/strict";
import test from "node:test";
import { SUMMARY_MODEL_CANDIDATES, parseCategories, selectSummaryModel } from "../daily-summary.ts";
import { GenerationFailure } from "../daily-cleanup.ts";

interface FakeCall { provider: string; model: string }
function runtime(options: { authed: string[]; known?: string[]; answers: Record<string, string | Error> }, calls: FakeCall[]) {
  const known = options.known ?? [...SUMMARY_MODEL_CANDIDATES.map(candidate => `${candidate.provider}/${candidate.model}`)];
  return {
    hasConfiguredAuth: (provider: string) => options.authed.includes(provider),
    getModel: (provider: string, model: string) => (known.includes(`${provider}/${model}`) ? { provider, id: model } : undefined),
    complete: async (model: { provider: string; id: string }, _context?: unknown, requestOptions: Record<string, unknown> = {}) => {
      assert.equal("maxTokens" in requestOptions, false, "summary requests must not cap model output");
      calls.push({ provider: model.provider, model: model.id });
      const answer = options.answers[`${model.provider}/${model.id}`];
      if (answer instanceof Error) throw answer;
      return { content: [{ type: "text", text: answer ?? "" }] };
    },
  };
}

test("the first candidate is used while it answers, without contacting later providers", async () => {
  const calls: FakeCall[] = [];
  const model = selectSummaryModel(runtime({ authed: ["openai-codex", "anthropic"], answers: { "openai-codex/gpt-6.1-sol": "[]" } }, calls) as never);
  assert.equal(await model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), "[]");
  assert.deepEqual(calls, [{ provider: "openai-codex", model: "gpt-6.1-sol" }]);
});

test("a provider usage-limit failure falls back to the configured Claude candidate", async () => {
  const calls: FakeCall[] = [];
  const model = selectSummaryModel(runtime({
    authed: ["openai-codex", "anthropic"],
    answers: { "openai-codex/gpt-6.1-sol": new Error("Codex error: The usage limit has been reached"), "anthropic/claude-haiku-4-5": "[]" },
  }, calls) as never);
  assert.equal(await model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), "[]");
  assert.deepEqual(calls.map(call => call.provider), ["openai-codex", "anthropic"]);
});

test("an empty provider response also falls back instead of failing the target", async () => {
  const calls: FakeCall[] = [];
  const model = selectSummaryModel(runtime({
    authed: ["openai-codex", "anthropic"],
    answers: { "openai-codex/gpt-6.1-sol": "", "anthropic/claude-haiku-4-5": "[]" },
  }, calls) as never);
  assert.equal(await model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), "[]");
  assert.deepEqual(calls.map(call => call.provider), ["openai-codex", "anthropic"]);
});

test("a provider that hangs and ignores abort is cut off and the next candidate answers", async () => {
  const calls: FakeCall[] = [];
  const base = runtime({ authed: ["openai-codex", "anthropic"], answers: { "anthropic/claude-haiku-4-5": "[]" } }, calls);
  const hanging = { ...base, complete: async (model: { provider: string; id: string }) => model.provider === "openai-codex" ? (calls.push({ provider: model.provider, model: model.id }), new Promise<never>(() => {})) : base.complete(model) };
  const model = selectSummaryModel(hanging as never, { requestTimeoutMs: 50 });
  assert.equal(await model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), "[]");
  assert.deepEqual(calls.map(call => call.provider), ["openai-codex", "anthropic"]);
});

test("an outer abort stops a hanging request promptly with an allowlisted code", async () => {
  const calls: FakeCall[] = [];
  const hanging = { ...runtime({ authed: ["openai-codex"], answers: {} }, calls), complete: () => new Promise<never>(() => {}) };
  const model = selectSummaryModel(hanging as never, { requestTimeoutMs: 60_000 });
  const started = Date.now();
  await assert.rejects(() => model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(50) }), error => error instanceof GenerationFailure && error.code === "aborted");
  assert.ok(Date.now() - started < 2_000);
});

test("when every candidate times out, the failure is reported as request_timeout", async () => {
  const calls: FakeCall[] = [];
  const hanging = { ...runtime({ authed: ["openai-codex", "anthropic"], answers: {} }, calls), complete: () => new Promise<never>(() => {}) };
  const model = selectSummaryModel(hanging as never, { requestTimeoutMs: 30 });
  await assert.rejects(() => model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), error => error instanceof GenerationFailure && error.code === "request_timeout");
});

test("unauthenticated or unknown candidates are skipped entirely", async () => {
  const calls: FakeCall[] = [];
  const model = selectSummaryModel(runtime({ authed: ["anthropic"], answers: { "anthropic/claude-haiku-4-5": "[]" } }, calls) as never);
  assert.equal(await model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), "[]");
  assert.deepEqual(calls.map(call => call.provider), ["anthropic"]);
});

test("selection fails fast with an allowlisted diagnostic when no candidate is authenticated and available", () => {
  const calls: FakeCall[] = [];
  assert.throws(() => selectSummaryModel(runtime({ authed: [], answers: {} }, calls) as never), error => error instanceof GenerationFailure && error.code === "no_configured_model");
  assert.equal(calls.length, 0);
});

test("when every available candidate fails, the reported error names no provider output", async () => {
  const calls: FakeCall[] = [];
  const model = selectSummaryModel(runtime({
    authed: ["openai-codex", "anthropic"],
    answers: { "openai-codex/gpt-6.1-sol": new Error("token=secret-value"), "anthropic/claude-haiku-4-5": new Error("token=secret-value") },
  }, calls) as never);
  await assert.rejects(() => model.complete({ systemPrompt: "s", text: "t", signal: AbortSignal.timeout(5_000) }), error => {
    assert.ok(error instanceof GenerationFailure);
    assert.equal(error.code, "provider_request_failed");
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
  assert.deepEqual(calls.map(call => call.provider), ["openai-codex", "anthropic"]);
});

test("fenced JSON from a fallback provider parses to the same categories as raw JSON", () => {
  const rows = [{ name: "Deployment", description: "Release operations", keywords: ["canary"] }];
  const source = "Deploy uses canary releases.";
  const raw = parseCategories(JSON.stringify(rows), source);
  assert.deepEqual(parseCategories("```json\n" + JSON.stringify(rows) + "\n```", source), raw);
  assert.deepEqual(parseCategories("```\n" + JSON.stringify(rows) + "\n```", source), raw);
  assert.throws(() => parseCategories("Here you go: not json", source));
});

test("generated rows are repaired only within the persisted schema, never fabricated", () => {
  const source = "Deploy uses canary releases and rollback alarms.";
  const parsed = parseCategories(JSON.stringify([
    { name: "Deployment", description: "Canary releases with rollback alarms", keywords: ["canary", "asynchronous", "rollback"] },
    { name: "Unsupported", description: "No source keywords", keywords: ["fabricated"] },
  ]), source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, "Deployment");
  assert.deepEqual(parsed[0]!.keywords, ["canary", "rollback"]);
  assert.equal(parsed[0]!.description, "Canary releases with rollback alarms");
  assert.throws(() => parseCategories(JSON.stringify([{ name: "All invalid", description: "d", keywords: ["fabricated"] }]), source));
});

test("length is prompt guidance only: a long description is kept verbatim, never cut or dropped", () => {
  const source = "Deploy uses canary releases and rollback alarms everywhere.";
  const long = "Deploy uses canary releases and rollback alarms everywhere across every service tier and region without exception or omission";
  assert.ok(long.length > 120);
  const parsed = parseCategories(JSON.stringify([{ name: "Deployment", description: long, keywords: ["canary"] }]), source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.description, long);
  // Structural safety still applies: newlines and the store delimiter remain rejected.
  assert.throws(() => parseCategories(JSON.stringify([{ name: "Bad", description: "line one\nline two", keywords: ["canary"] }]), source));
});
