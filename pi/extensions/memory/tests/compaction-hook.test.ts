import assert from "node:assert/strict";
import test from "node:test";
import { createLunaCompactionExtension } from "../../luna-compaction.ts";

function harness(compactImpl: any) {
  let handler: any;
  createLunaCompactionExtension(compactImpl)({ on: (name: string, value: any) => { if (name === "session_before_compact") handler = value; } } as any);
  return handler;
}
const event: any = { preparation: { previousSummary: "old summary", firstKeptEntryId: "entry-9" }, customInstructions: "retain release proof", signal: new AbortController().signal };
const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
const ctx = (registry: any, notices: string[] = []) => ({ modelRegistry: registry, ui: { notify: (message: string) => notices.push(message) } });

test("compaction hook forwards preparation, composed instructions, cancellation, auth, and environment", async () => {
  const calls: any[] = [];
  const handler = harness(async (...args: any[]) => { calls.push(args); return { summary: "handoff", firstKeptEntryId: "entry-9", tokensBefore: 42 }; });
  const result = await handler(event, ctx({ find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: { authorization: "x" }, env: { MODE: "test" } }) }));
  assert.deepEqual(result, { compaction: { summary: "handoff", firstKeptEntryId: "entry-9", tokensBefore: 42 } });
  assert.equal(calls[0][0], event.preparation);
  assert.equal(calls[0][5], event.signal);
  assert.deepEqual(calls[0][3], { authorization: "x" });
  assert.deepEqual(calls[0][8], { MODE: "test" });
  assert.match(calls[0][4], /retain release proof/);
});

test("compaction hook preserves built-in fallback for unavailable model, auth failure, thrown call, and cancellation", async () => {
  const noModel = harness(async () => { throw new Error("must not run"); });
  assert.equal(await noModel(event, ctx({ find: () => undefined })), undefined);
  const noAuth = harness(async () => { throw new Error("must not run"); });
  assert.equal(await noAuth(event, ctx({ find: () => model, getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }) })), undefined);
  const throws = harness(async () => { throw new Error("cancelled"); });
  assert.equal(await throws(event, ctx({ find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) })), undefined);
  const controller = new AbortController(); controller.abort();
  const cancelled = harness(async (...args: any[]) => { assert.equal(args[5].aborted, true); throw new Error("aborted"); });
  assert.equal(await cancelled({ ...event, signal: controller.signal }, ctx({ find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) })), undefined);
});
