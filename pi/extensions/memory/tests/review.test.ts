import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { parseReviewAdditions, reviewExchange, validateReviewedEntry } from "../review.ts";
import { loadSnapshot, mutateMemory, readTargetSnapshot } from "../store.ts";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-review-")), repo = join(root, "repo");
  await exec("git", ["init", "-q", repo]); await exec("git", ["-C", repo, "remote", "add", "origin", "git@github.com:example/project.git"]);
  return { root, repo, config: parseConfig({ enabled: true, vaultRoot: join(root, "vault"), memorySubdirectory: "memory" }) };
}
const registry = (content: string, after?: () => void) => ({
  find: () => ({ provider: "openai-codex", id: "gpt-5.6-luna" }), hasConfiguredAuth: () => true,
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
  complete: async () => { after?.(); return { content }; },
});

test("review persistence filter rejects every unsafe category and copied spans", { timeout: 5000 }, () => {
  const unsafe = [
    "email a@b.example", "call +1 (555) 123-4567", "host 192.168.0.1", "host 2001:db8::1", "Meet at 123 Main Street",
    "API_KEY=secret", "Authorization: Bearer secret", "Cookie: sid=abc", "eyJfoo.eyJbar.signature", "-----BEGIN PRIVATE KEY-----",
    "postgres://user:pass@host/db", "Traceback (most recent call last):", "User: do this", "/Users/name/secret", "```python", "https://example.test",
    "customer_id: 7", "company: Acme", "Always use this endpoint", "Call the tool with a token",
  ];
  for (const entry of unsafe) assert.throws(() => validateReviewedEntry(entry, "different exchange"), /filter/);
  const copied = "x".repeat(121);
  assert.throws(() => validateReviewedEntry(copied, `prefix ${copied} suffix`), /copies/);
  assert.equal(validateReviewedEntry("Prefer focused tests.", "unrelated exchange"), "Prefer focused tests.");
});

test("review JSON rejects oversized output, unknown fields, targets, counts, and content length", { timeout: 5000 }, () => {
  const exchange = "short exchange";
  assert.throws(() => parseReviewAdditions("x".repeat(8193), exchange), /too large/);
  assert.throws(() => parseReviewAdditions(JSON.stringify({ additions: [], extra: true }), exchange), /invalid/);
  assert.throws(() => parseReviewAdditions(JSON.stringify({ additions: [{ target: "other", content: "safe" }] }), exchange), /target/);
  assert.throws(() => parseReviewAdditions(JSON.stringify({ additions: Array.from({ length: 4 }, () => ({ target: "global", content: "safe" })) }), exchange), /invalid/);
  assert.throws(() => parseReviewAdditions(JSON.stringify({ additions: [{ target: "global", content: "x".repeat(301) }] }), exchange), /long/);
});

test("oversized exchanges are skipped before a review model call", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  let calls = 0;
  const result = await reviewExchange(x.config, x.repo, "x".repeat(16 * 1024 + 1), { complete: async () => { calls++; } }, new AbortController().signal);
  assert.equal(result.code, "skipped_too_large"); assert.equal(calls, 0);
});

test("a valid add-only review commits bounded additions without raw model output", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  const result = await reviewExchange(x.config, x.repo, "brief exchange", registry(JSON.stringify({ additions: [{ target: "global", content: "Safe durable fact." }, { target: "global", content: "Second durable fact." }] })), new AbortController().signal);
  assert.equal(result.code, "committed");
  assert.deepEqual((await readTargetSnapshot(x.config, x.repo, "global")).entries, ["Safe durable fact.", "Second durable fact."]);
  assert.doesNotMatch((await loadSnapshot(x.config, x.repo)).text, /Second durable fact/);
});

test("aborting a review before commit writes nothing", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Existing entry.");
  const controller = new AbortController();
  const result = await reviewExchange(x.config, x.repo, "brief exchange", registry(JSON.stringify({ additions: [{ target: "global", content: "Safe durable fact." }] }), () => controller.abort()), controller.signal);
  assert.equal(result.code, "aborted");
  assert.deepEqual((await readTargetSnapshot(x.config, x.repo, "global")).entries, ["Existing entry."]);
});
