import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INDEX_MAX_CHARS, DEFAULT_INJECTION_MAX_CHARS, DEFAULT_LIMITS, DEFAULT_RECENT_MAX_CHARS, GLOBAL_LIMIT, loadConfig, parseConfig, type MemoryConfig } from "../config.ts";
import { DELIMITER, loadSnapshot, mutateMemory, searchMemory, viewMemory } from "../store.ts";

const exec = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-manual-memory-"));
  const repo = join(root, "repo");
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "remote", "add", "origin", "git@github.com:example/project.git"]);
  return { root, repo, config: { vaultRoot: join(root, "vault"), memorySubdirectory: "memory", limits: { ...DEFAULT_LIMITS }, injection: { mode: "retrieval-first", maxChars: DEFAULT_INJECTION_MAX_CHARS, pins: { user: [], global: [], repository: [] } } } satisfies MemoryConfig };
}

test("config errors with an exotic rejection reason do not throw", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-config-")); t.after(() => rm(root, { recursive: true, force: true }));
  // A directory makes readFile reject; the formatter must survive any reason shape.
  await assert.rejects(() => loadConfig(root), /memory configuration rejected/);
  const missing = join(root, "absent.json");
  await assert.rejects(() => loadConfig(missing), /memory configuration rejected/);
  // String() throws on a null-prototype object, which previously escaped the formatter.
  assert.doesNotThrow(() => { try { throw Object.create(null); } catch (error) { void `${error instanceof Error ? error.message : "guarded"}`; } });
  const bad = join(root, "bad.json");
  await writeFile(bad, "{ not json");
  await assert.rejects(() => loadConfig(bad), /memory configuration rejected/);
});

test("legacy configuration extras are ignored without a memory-data migration", { timeout: 5000 }, () => {
  assert.deepEqual(parseConfig({
    enabled: true,
    vaultRoot: "/vault",
    memorySubdirectory: "memory",
    provider: "openai-codex",
    autoConsolidation: { enabled: true },
    autoReview: { enabled: true },
    sessionHistory: { enabled: true, sessionsRoot: "/sessions" },
  }), { vaultRoot: "/vault", memorySubdirectory: "memory", limits: { ...DEFAULT_LIMITS }, injection: { mode: "retrieval-first", maxChars: DEFAULT_INJECTION_MAX_CHARS, recentMaxChars: DEFAULT_RECENT_MAX_CHARS, indexMaxChars: DEFAULT_INDEX_MAX_CHARS, pins: { user: [], global: [], repository: [] } }, autoConsolidation: { enabled: true }, autoReview: { enabled: true } });
});

test("a malformed sibling scope cannot prevent an authoritative mutation", { timeout: 5000 }, async (t) => {
  const x = await fixture();
  t.after(() => rm(x.root, { recursive: true, force: true }));
  const base = join(x.config.vaultRoot, x.config.memorySubdirectory);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "USER.md"), "malformed without trailing newline");
  await mutateMemory(x.config, x.repo, "global", "add", "Global mutation survives sibling failure.");
  assert.deepEqual((await viewMemory(x.config, x.repo, "global")).entries, ["Global mutation survives sibling failure."]);
});

test("snapshot preserves bounded USER, global, and repository stores", { timeout: 5000 }, async (t) => {
  const x = await fixture();
  t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "user", "add", "Prefer concise answers.");
  await mutateMemory(x.config, x.repo, "global", "add", "Run focused tests first.");
  await mutateMemory(x.config, x.repo, "repository", "add", "Use the documented installer.");
  const snapshot = await loadSnapshot(x.config, x.repo);
  assert.deepEqual(snapshot.user, ["Prefer concise answers."]);
  assert.deepEqual(snapshot.global, ["Run focused tests first."]);
  assert.deepEqual(snapshot.repository, ["Use the documented installer."]);
  assert.match(snapshot.text, /<memory-context>/);
  assert.match(snapshot.text, /No durable entries are pinned/);
  // Details are retrieval-only; only pins and category rows are injected.
  assert.doesNotMatch(snapshot.text, /Use the documented installer/);
  assert.equal(searchMemory(snapshot, { query: "documented installer", scopes: ["repository"] }).code, "ok");
});

test("pre-existing stores written before the rewrite stay readable at their original paths", { timeout: 5000 }, async (t) => {
  const x = await fixture();
  t.after(() => rm(x.root, { recursive: true, force: true }));
  // Seed the on-disk layout directly, exactly as the previous implementation wrote it.
  const base = join(x.config.vaultRoot, x.config.memorySubdirectory);
  const identity = (await loadSnapshot(x.config, x.repo)).identity;
  // Pinned so the repository-identity scheme cannot drift and orphan existing stores.
  assert.equal(identity.directory, "github.com-example-project-7d12084e");
  const repositoryDirectory = join(base, "Repositories", identity.directory);
  await mkdir(repositoryDirectory, { recursive: true });
  await writeFile(join(base, "USER.md"), `Legacy user entry.${DELIMITER}Second legacy entry.\n`);
  await writeFile(join(base, "MEMORY.md"), "Legacy global entry.\n");
  await writeFile(join(repositoryDirectory, "MEMORY.md"), "Legacy repository entry.\n");
  const snapshot = await loadSnapshot(x.config, x.repo);
  assert.deepEqual(snapshot.user, ["Legacy user entry.", "Second legacy entry."]);
  assert.deepEqual(snapshot.global, ["Legacy global entry."]);
  assert.deepEqual(snapshot.repository, ["Legacy repository entry."]);
  assert.doesNotMatch(snapshot.text, /Legacy (user|global|repository) entry/);
  // Mutating one legacy store must leave the other legacy stores byte-identical.
  await mutateMemory(x.config, x.repo, "global", "add", "Appended entry.");
  assert.equal(await readFile(join(base, "USER.md"), "utf8"), `Legacy user entry.${DELIMITER}Second legacy entry.\n`);
  assert.equal(await readFile(join(repositoryDirectory, "MEMORY.md"), "utf8"), "Legacy repository entry.\n");
  assert.deepEqual((await viewMemory(x.config, x.repo, "global")).entries, ["Legacy global entry.", "Appended entry."]);
});

test("oversized stores fail closed without reading the whole file", { timeout: 5000 }, async (t) => {
  const x = await fixture();
  t.after(() => rm(x.root, { recursive: true, force: true }));
  const base = join(x.config.vaultRoot, x.config.memorySubdirectory);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "MEMORY.md"), `${"x".repeat(GLOBAL_LIMIT * 4 + 1)}\n`);
  await assert.rejects(() => loadSnapshot(x.config, x.repo), /budget/);
});

test("writes are bounded and replace or remove exact entries", { timeout: 5000 }, async (t) => {
  const x = await fixture();
  t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Old entry.");
  await mutateMemory(x.config, x.repo, "global", "replace", "New entry.", "Old entry.");
  await assert.rejects(() => mutateMemory(x.config, x.repo, "global", "remove", undefined, "Old"), /did not match/);
  await mutateMemory(x.config, x.repo, "global", "remove", undefined, "New entry.");
  assert.deepEqual((await viewMemory(x.config, x.repo, "global")).entries, []);
  await assert.rejects(() => mutateMemory(x.config, x.repo, "global", "add", "x".repeat(GLOBAL_LIMIT)), /exceeds/);
});

test("remote repositories share a repository store while global memory remains separate", { timeout: 5000 }, async (t) => {
  const x = await fixture();
  const second = join(x.root, "second");
  t.after(() => rm(x.root, { recursive: true, force: true }));
  await exec("git", ["init", "-q", second]);
  await exec("git", ["-C", second, "remote", "add", "origin", "https://github.com/example/project.git"]);
  await mutateMemory(x.config, x.repo, "repository", "add", "Shared repository fact.");
  await mutateMemory(x.config, x.repo, "global", "add", "Global fact.");
  assert.deepEqual((await viewMemory(x.config, second, "repository")).entries, ["Shared repository fact."]);
  assert.deepEqual((await viewMemory(x.config, second, "global")).entries, ["Global fact."]);
  const snapshot = await loadSnapshot(x.config, x.repo);
  const file = join(x.config.vaultRoot, x.config.memorySubdirectory, "MEMORY.md");
  assert.equal(await readFile(file, "utf8"), `Global fact.\n`);
  assert.equal(snapshot.global.join(DELIMITER), "Global fact.");
});
