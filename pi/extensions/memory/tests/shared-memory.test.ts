import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { runDailySummary } from "../daily-summary.ts";
import { loadSnapshot, mutateMemory, searchMemory } from "../store.ts";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-shared-memory-"));
  const first = join(root, "first"), second = join(root, "second");
  for (const repository of [first, second]) { await exec("git", ["init", "-q", repository]); }
  await exec("git", ["-C", first, "remote", "add", "origin", "git@github.com:example/first.git"]);
  await exec("git", ["-C", second, "remote", "add", "origin", "git@github.com:example/second.git"]);
  return { root, first, second, config: parseConfig({ enabled: true, vaultRoot: join(root, "vault"), memorySubdirectory: "memory", injection: { maxChars: 1200, pins: { user: [], global: [], repository: [] } } }) };
}
const model = (rows: unknown) => ({ complete: async () => JSON.stringify(rows) });

test("memory search and category injection aggregate all registered repositories with provenance", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.first, "repository", "add", "First service uses aurora replicas.");
  await mutateMemory(x.config, x.second, "repository", "add", "Second service owns nebula migrations.");
  await runDailySummary(x.config, model([{ name: "Storage", description: "Aurora replicas", keywords: ["aurora", "replicas"] }]));
  const snapshot = await loadSnapshot(x.config, x.second);
  const result = searchMemory(snapshot, { query: "aurora", scopes: ["repository"] });
  assert.equal(result.code, "ok");
  assert.equal(result.results[0]!.content, "First service uses aurora replicas.");
  assert.match(result.results[0]!.source, /^Repositories\//);
  // Provenance is the tree heading for the owning store, not a prefix on every row.
  assert.match(snapshot.text, /^Repositories\/github\.com-example-first-[0-9a-f]+\/MEMORY\.md$/m);
  assert.match(snapshot.text, /^└── Storage — Aurora replicas \[aurora, replicas\]$/m);
  assert.doesNotMatch(snapshot.text, /First service uses aurora replicas/);
});
