import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { consolidateSnapshot, parseConsolidationPlan, selectConsolidationTarget } from "../consolidation.ts";
import { commitConsolidation, loadSnapshot, mutateMemory, readTargetSnapshot, type TargetSnapshot } from "../store.ts";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-consolidation-")), repo = join(root, "repo");
  await exec("git", ["init", "-q", repo]); await exec("git", ["-C", repo, "remote", "add", "origin", "git@github.com:example/project.git"]);
  return { root, repo, config: parseConfig({ enabled: true, vaultRoot: join(root, "vault"), memorySubdirectory: "memory", limits: { user: 1375, global: 2200, repository: 2200 } }) };
}
const entry = (letter: string, size: number) => `${letter.repeat(size - 2)} ${letter}`;
const snapshot = (entries: string[]): TargetSnapshot => ({ target: "global", entries, serialized: `${entries.join("\n§\n")}\n`, usage: `${entries.join("\n§\n")}\n`.length, limit: 2200, path: "/memory/MEMORY.md" });

test("threshold selection picks only the highest target at or above 80%", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "user", "add", entry("u", 1120));
  await mutateMemory(x.config, x.repo, "global", "add", entry("g", 1800));
  await mutateMemory(x.config, x.repo, "repository", "add", entry("r", 1500));
  assert.equal((await selectConsolidationTarget(x.config, x.repo))?.target, "global");
  const low = await fixture(); t.after(() => rm(low.root, { recursive: true, force: true }));
  await mutateMemory(low.config, low.repo, "global", "add", entry("l", 1000));
  assert.equal(await selectConsolidationTarget(low.config, low.repo), undefined);
  const empty = await fixture(); t.after(() => rm(empty.root, { recursive: true, force: true }));
  assert.equal(await selectConsolidationTarget(empty.config, empty.repo, false), undefined, "manual compaction must not call a model for empty memory");
});

test("plan validation rejects invalid ids, group bounds, unsafe content, and non-shrinking plans", { timeout: 5000 }, () => {
  const base = snapshot(Array.from({ length: 12 }, (_, index) => `entry ${index + 1}`));
  const invalid = (groups: unknown) => JSON.stringify({ groups });
  assert.throws(() => parseConsolidationPlan(invalid([{ sources: ["99"], content: "short" }]), base), /unknown/);
  assert.throws(() => parseConsolidationPlan(invalid([{ sources: ["1"], content: "short" }, { sources: ["1"], content: "other" }]), base), /reused/);
  assert.throws(() => parseConsolidationPlan(invalid(Array.from({ length: 9 }, () => ({ sources: ["1"], content: "x" }))), base), /groups/);
  assert.throws(() => parseConsolidationPlan(invalid([{ sources: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], content: "x" }]), base), /group/);
  const thirteen = snapshot(Array.from({ length: 13 }, (_, index) => `large entry ${index + 1}`));
  assert.throws(() => parseConsolidationPlan(invalid([{ sources: ["1", "2", "3", "4", "5", "6", "7"], content: "x" }, { sources: ["8", "9", "10", "11", "12", "13"], content: "y" }]), thirteen), /sources/);
  assert.throws(() => parseConsolidationPlan(invalid([{ sources: ["1", "2"], content: "bad\n§\nentry" }]), base), /separator/);
  assert.throws(() => parseConsolidationPlan(invalid([{ sources: ["1"], content: "entry 1" }]), base), /did not reduce/);
});

test("consolidation records replacement entries as recent for injection", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Verbose source entry.");
  const before = await readTargetSnapshot(x.config, x.repo, "global");
  assert.equal(await commitConsolidation(x.config, before, ["Consolidated current entry."]), "committed");
  // Consolidated detail stays retrieval-only; it is never injected as context.
  const loaded = await loadSnapshot(x.config, x.repo);
  assert.deepEqual(loaded.global, ["Consolidated current entry."]);
  assert.doesNotMatch(loaded.text, /Consolidated current entry/);
});

test("consolidation timestamps only changed legacy entries", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  const base = join(x.config.vaultRoot, x.config.memorySubdirectory);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "MEMORY.md"), "Legacy retained.\n§\nLegacy replaced.\n");
  const before = await readTargetSnapshot(x.config, x.repo, "global");
  assert.equal(await commitConsolidation(x.config, before, ["Legacy retained.", "Consolidated replacement."]), "committed");
  const loaded = await loadSnapshot(x.config, x.repo);
  assert.deepEqual(loaded.global, ["Legacy retained.", "Consolidated replacement."]);
  assert.doesNotMatch(loaded.text, /Consolidated replacement|Legacy retained/);
});

test("optimistic consolidation aborts on external drift without overwriting it", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "First long entry that will be replaced.");
  await mutateMemory(x.config, x.repo, "global", "add", "Second long entry that will be removed.");
  const before = await readTargetSnapshot(x.config, x.repo, "global");
  await mutateMemory(x.config, x.repo, "global", "add", "External writer wins.");
  assert.equal(await commitConsolidation(x.config, before, ["Compact entry."]), "external_drift");
  assert.deepEqual((await readTargetSnapshot(x.config, x.repo, "global")).entries, ["First long entry that will be replaced.", "Second long entry that will be removed.", "External writer wins."]);
});

test("abort after a model response does not parse or commit memory", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "First verbose entry that will remain unchanged.");
  await mutateMemory(x.config, x.repo, "global", "add", "Second verbose entry that will remain unchanged.");
  const before = await readTargetSnapshot(x.config, x.repo, "global"), controller = new AbortController();
  let completeCalls = 0;
  const registry = {
    find: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }), hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    complete: async () => { completeCalls++; controller.abort(); return { content: JSON.stringify({ groups: [{ sources: ["1", "2"], content: "Compact entry." }] }) }; },
  };
  assert.deepEqual(await consolidateSnapshot(x.config, before, registry, controller.signal), { code: "aborted", message: "consolidation cancelled" });
  assert.equal(completeCalls, 1);
  assert.deepEqual((await readTargetSnapshot(x.config, x.repo, "global")).entries, before.entries);
});

test("abort while waiting on the mutation queue writes nothing", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "First verbose entry that must survive an aborted commit.");
  await mutateMemory(x.config, x.repo, "global", "add", "Second verbose entry that must survive an aborted commit.");
  const before = await readTargetSnapshot(x.config, x.repo, "global"), controller = new AbortController();
  controller.abort();
  assert.equal(await commitConsolidation(x.config, before, ["Compact entry."], controller.signal), "aborted");
  assert.deepEqual((await readTargetSnapshot(x.config, x.repo, "global")).entries, before.entries, "an aborted commit must not modify the store");
});

test("abort during the commit's own awaits still writes nothing", { timeout: 5000 }, async (t) => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "First verbose entry that must survive a late abort.");
  await mutateMemory(x.config, x.repo, "global", "add", "Second verbose entry that must survive a late abort.");
  const before = await readTargetSnapshot(x.config, x.repo, "global"), controller = new AbortController();
  // Abort only once the commit is already past its entry gate and inside its awaits.
  setTimeout(() => controller.abort(), 0);
  const result = await commitConsolidation(x.config, before, ["Compact entry."], controller.signal);
  assert.equal(result, "aborted");
  assert.deepEqual((await readTargetSnapshot(x.config, x.repo, "global")).entries, before.entries);
  const leftovers = (await readdir(join(x.config.vaultRoot, "memory"))).filter(name => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "an aborted commit must not leave temp files behind");
});

test("memory never creates legacy stateRoot artifacts", { timeout: 5000 }, async (t) => {
  const x = await fixture(), stateRoot = join(x.root, "state"); t.after(() => rm(x.root, { recursive: true, force: true }));
  const config = parseConfig({ enabled: true, vaultRoot: x.config.vaultRoot, memorySubdirectory: "memory", stateRoot, autoConsolidation: { enabled: true } });
  await mutateMemory(config, x.repo, "global", "add", "Only the vault is written.");
  await assert.rejects(() => access(stateRoot));
});
