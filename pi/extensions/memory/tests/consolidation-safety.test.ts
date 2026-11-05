import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INJECTION_MAX_CHARS, DEFAULT_LIMITS, type MemoryConfig } from "../config.ts";
import { commitConsolidation, mutateMemory, readTargetSnapshot } from "../store.ts";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-consolidation-safety-"));
  const repo = join(root, "repo");
  await exec("git", ["init", "-q", repo]);
  const config: MemoryConfig = { vaultRoot: join(root, "vault"), memorySubdirectory: "memory", limits: { ...DEFAULT_LIMITS }, injection: { mode: "retrieval-first", maxChars: DEFAULT_INJECTION_MAX_CHARS, pins: { user: [], global: [], repository: [] } } };
  await mutateMemory(config, repo, "global", "add", "original");
  return { root, repo, config };
}

test("consolidation rejects a post-snapshot symlink instead of following it", async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  const snapshot = await readTargetSnapshot(x.config, x.repo, "global");
  await unlink(snapshot.path);
  const outside = join(x.root, "outside.md");
  await writeFile(outside, "outside\n");
  await symlink(outside, snapshot.path);
  await assert.rejects(() => commitConsolidation(x.config, snapshot, ["replacement"]), /unsafe memory file/);
});

test("consolidation rejects an oversized post-snapshot file before reading it fully", async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  const snapshot = await readTargetSnapshot(x.config, x.repo, "global");
  await writeFile(snapshot.path, `${"x".repeat(x.config.limits.global * 4 + 1)}\n`);
  await assert.rejects(() => commitConsolidation(x.config, snapshot, ["replacement"]), /exceeds its budget/);
});
