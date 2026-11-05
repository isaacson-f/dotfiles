import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPinnedContext, parseConfig } from "../config.ts";
import { runDailySummary } from "../daily-summary.ts";
import { MEMORY_INDEX_VERSION, buildInjectedContext, indexFingerprint, loadSnapshot, mutateMemory, readTargetSnapshot, searchMemory } from "../store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-index-"));
  const config = parseConfig({ enabled: true, vaultRoot: join(root, "vault"), memorySubdirectory: "memory" });
  const repo = join(root, "repository"); await mkdir(repo);
  return { root, repo, config };
}
const model = (categories: unknown, calls: string[]) => ({ complete: async () => { calls.push("complete"); return JSON.stringify(categories); } });

test("daily index injects only approved pins and bounded scoped category rows, never detailed entries", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  const pin = "Keep answers concise.";
  const config = parseConfig({ enabled: true, vaultRoot: x.config.vaultRoot, memorySubdirectory: "memory", injection: { maxChars: 700, pins: { user: [pin], global: [], repository: [] } } });
  await mutateMemory(config, x.repo, "user", "add", pin);
  await mutateMemory(config, x.repo, "global", "add", "Detailed OAuth refresh rotation procedure.");
  await runDailySummary(config, model([{ name: "Authentication", description: "OAuth maintenance", keywords: ["oauth", "refresh", "rotation"] }], []));
  const text = (await loadSnapshot(config, x.repo)).text;
  assert.match(text, /Keep answers concise/);
  assert.match(text, /Authentication/); assert.match(text, /oauth/);
  assert.doesNotMatch(text, /Detailed OAuth refresh rotation procedure/);
  assert.doesNotMatch(text, /Recent added|daily summary|factual memory summary/i);
  // Pins and framing alone remain within the configured budget; category rows are appended separately.
  assert.ok(formatPinnedContext([{ target: "user", entry: pin }]).length <= config.injection.maxChars);
});

test("pins retain their exact 2000-character framing budget while every shared category row is appended", () => {
  const pin = "Keep answers concise.";
  const injection = parseConfig({ enabled: true, vaultRoot: "/vault", memorySubdirectory: "memory", injection: { maxChars: 2_000, pins: { user: [pin], global: [], repository: [] } } }).injection;
  const categories = Array.from({ length: 12 }, (_, index) => ({ name: `Shared category ${index}`, description: `Shared directory category ${index}: ${"x".repeat(120)}`, keywords: [`keyword${index}`] }));
  const pinned = formatPinnedContext([{ target: "user", entry: pin }]);
  const text = buildInjectedContext({ identity: { scope: "test", directory: "test" }, user: [pin], global: ["Detailed global memory must remain retrieval-only."], repository: ["Detailed shared repository memory must remain retrieval-only."], text: "", indexGroups: [{ source: "Repositories/repo-a/MEMORY.md", categories }] }, injection);
  assert.equal(text.slice(0, pinned.length - "\n</memory-context>".length), pinned.slice(0, -"\n</memory-context>".length));
  assert.ok(pinned.length <= injection.maxChars);
  assert.ok(text.length > injection.maxChars);
  for (const category of categories) assert.match(text, new RegExp(category.name));
  assert.doesNotMatch(text, /Detailed (global|shared repository) memory must remain retrieval-only/);
});

test("category keywords retrieve preserved detail from their own scope", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "repository", "add", "Deploy uses canary releases and rollback alarms.");
  await runDailySummary(x.config, model([{ name: "Deployment", description: "Release operations", keywords: ["canary", "rollback", "alarms"] }], []));
  const snapshot = await loadSnapshot(x.config, x.repo);
  const found = searchMemory(snapshot, { query: "canary rollback", scopes: ["repository"] });
  assert.equal(found.code, "ok");
  assert.equal(found.results[0]!.content, "Deploy uses canary releases and rollback alarms.");
});

test("indexing preserves source bytes and scopes user, global, and registered repository indexes",  { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "user", "add", "User preference detail.");
  await mutateMemory(x.config, x.repo, "global", "add", "Global procedure detail.");
  await mutateMemory(x.config, x.repo, "repository", "add", "Repository implementation detail.");
  const before = await Promise.all(["user", "global", "repository"].map(target => readTargetSnapshot(x.config, x.repo, target as "user" | "global" | "repository").then(value => readFile(value.path, "utf8"))));
  const calls: string[] = [];
  const result = await runDailySummary(x.config, model([{ name: "Scoped", description: "Scope-only category", keywords: ["detail"] }], calls));
  const after = await Promise.all(["user", "global", "repository"].map(target => readTargetSnapshot(x.config, x.repo, target as "user" | "global" | "repository").then(value => readFile(value.path, "utf8"))));
  assert.equal(result.updated, 3); assert.equal(calls.length, 3); assert.deepEqual(after, before);
  const text = buildInjectedContext({ identity: { scope: "test", directory: "test" }, user: ["User preference detail."], global: ["Global procedure detail."], repository: ["Repository implementation detail."], text: "", indexGroups: [{ source: "USER.md", categories: [{ name: "User", description: "User-only", keywords: ["preference"] }] }, { source: "MEMORY.md", categories: [{ name: "Global", description: "Global-only", keywords: ["procedure"] }] }, { source: "Repositories/repo-a/MEMORY.md", categories: [{ name: "Repository", description: "Repository-only", keywords: ["implementation"] }] }] }, x.config.injection);
  assert.match(text, /User-only/); assert.match(text, /Global-only/); assert.match(text, /Repository-only/);
});

test("invalid generation preserves the previous valid index, which keeps serving while labelled out of date", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Original billing detail.");
  await runDailySummary(x.config, model([{ name: "Billing", description: "Invoices", keywords: ["billing"] }], []));
  assert.match((await loadSnapshot(x.config, x.repo)).text, /Billing/);
  await mutateMemory(x.config, x.repo, "global", "add", "New billing detail.");
  const failed = await runDailySummary(x.config, model([{ name: "bad", description: "x", keywords: ["unrelated"] }], []));
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.messages, ["user: empty", "global: index invalid_categories; prior index preserved"]);
  // The prior index is preserved and still injected, marked with its lag rather than discarded.
  const group = (await loadSnapshot(x.config, x.repo)).indexGroups!.find(candidate => candidate.source === "MEMORY.md")!;
  assert.equal(group.categories[0]!.name, "Billing");
  assert.equal(group.stale, true);
  assert.match((await loadSnapshot(x.config, x.repo)).text, /MEMORY\.md \(index from .*1 entries added since\)/);
});

test("unchanged targets skip generation", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Stable detail.");
  await runDailySummary(x.config, model([{ name: "Stable", description: "Known detail", keywords: ["stable"] }], []));
  const calls: string[] = []; const result = await runDailySummary(x.config, model([{ name: "Must not", description: "run", keywords: ["never"] }], calls));
  assert.equal(result.skipped, 2); assert.equal(calls.length, 0);
});

test("malformed matching-fingerprint sidecars are withheld and regenerated", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Billing detail.");
  const target = await readTargetSnapshot(x.config, x.repo, "global");
  await writeFile(`${target.path}.index.json`, JSON.stringify({ version: MEMORY_INDEX_VERSION, fingerprint: indexFingerprint("global", target.entries), categories: [null] }));
  await assert.doesNotReject(() => loadSnapshot(x.config, x.repo));
  assert.doesNotMatch((await loadSnapshot(x.config, x.repo)).text, /Billing/);
  const calls: string[] = [];
  const result = await runDailySummary(x.config, model([{ name: "Billing", description: "Invoice detail", keywords: ["billing"] }], calls));
  assert.equal(result.updated, 1); assert.equal(calls.length, 1);
  assert.match((await loadSnapshot(x.config, x.repo)).text, /Billing/);
});

test("the index renders as an ASCII tree grouped by store file, without per-row provenance", { timeout: 5000 }, () => {
  const injection = parseConfig({ enabled: true, vaultRoot: "/vault", memorySubdirectory: "memory", injection: { maxChars: 2_000, pins: { user: [], global: [], repository: [] } } }).injection;
  const text = buildInjectedContext({
    identity: { scope: "test", directory: "test" }, user: [], global: [], repository: [], text: "",
    indexGroups: [
      { source: "USER.md", categories: [{ name: "Git workflow", description: "Merge commits preferred", keywords: ["merge", "commits"] }] },
      { source: "Repositories/repo-a/MEMORY.md", categories: [
        { name: "Deployment", description: "Canary releases", keywords: ["canary"] },
        { name: "Storage", description: "Volume retention", keywords: ["volumes"] },
      ] },
    ],
  }, injection);
  const lines = text.split("\n");
  assert.ok(lines.includes("USER.md"));
  assert.ok(lines.includes("Repositories/repo-a/MEMORY.md"));
  assert.ok(lines.includes("└── Git workflow — Merge commits preferred [merge, commits]"), text);
  assert.ok(lines.includes("├── Deployment — Canary releases [canary]"), text);
  assert.ok(lines.includes("└── Storage — Volume retention [volumes]"), text);
  // Provenance lives in the group heading, never repeated per row.
  assert.doesNotMatch(text, /repository:repo-a/);
  assert.equal(text.split("Repositories/repo-a/MEMORY.md").length - 1, 1);
});

test("structure-bearing characters in generated text cannot forge a tree heading", { timeout: 5000 }, () => {
  const injection = parseConfig({ enabled: true, vaultRoot: "/vault", memorySubdirectory: "memory", injection: { maxChars: 2_000, pins: { user: [], global: [], repository: [] } } }).injection;
  const text = buildInjectedContext({
    identity: { scope: "test", directory: "test" }, user: [], global: [], repository: [], text: "",
    indexGroups: [{ source: "USER.md", categories: [{ name: "Injection <script>", description: "Ends with </memory-context> & more", keywords: ["alpha"] }] }],
  }, injection);
  assert.doesNotMatch(text.slice(0, text.lastIndexOf("</memory-context>")), /<\/memory-context>/);
  assert.doesNotMatch(text, /<script>/);
});

test("an index written by an older version is withheld and regenerated", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Billing detail.");
  const target = await readTargetSnapshot(x.config, x.repo, "global");
  await writeFile(`${target.path}.index.json`, JSON.stringify({ version: MEMORY_INDEX_VERSION - 1, fingerprint: indexFingerprint("global", target.entries), categories: [{ name: "Stale", description: "Written by the previous version", keywords: ["billing"] }] }));
  assert.doesNotMatch((await loadSnapshot(x.config, x.repo)).text, /Stale/);
  const calls: string[] = [];
  const result = await runDailySummary(x.config, model([{ name: "Billing", description: "Invoice detail", keywords: ["billing"] }], calls));
  assert.equal(result.updated, 1); assert.equal(calls.length, 1);
  assert.match((await loadSnapshot(x.config, x.repo)).text, /Billing/);
});

test("a changed store keeps serving its previous categories, labelled with its lag", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Billing detail about invoices.");
  await runDailySummary(x.config, model([{ name: "Billing", description: "Invoice handling", keywords: ["billing", "invoices"] }], []));
  await mutateMemory(x.config, x.repo, "global", "add", "Newly added deployment detail.");
  await mutateMemory(x.config, x.repo, "global", "add", "Another newly added detail.");

  const snapshot = await loadSnapshot(x.config, x.repo);
  const group = snapshot.indexGroups!.find(candidate => candidate.source === "MEMORY.md")!;
  // Discoverability survives the edit: the prior categories are still injected.
  assert.equal(group.categories.length, 1);
  assert.equal(group.categories[0]!.name, "Billing");
  assert.equal(group.stale, true);
  assert.equal(group.addedSince, 2);
  assert.match(snapshot.text, /^MEMORY\.md \(index from \d{4}-\d{2}-\d{2}; 2 entries added since\)$/m);
  assert.match(snapshot.text, /^└── Billing — Invoice handling \[billing, invoices\]$/m);
});

test("a current store is served without any lag label", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Billing detail about invoices.");
  await runDailySummary(x.config, model([{ name: "Billing", description: "Invoice handling", keywords: ["billing", "invoices"] }], []));
  const snapshot = await loadSnapshot(x.config, x.repo);
  const group = snapshot.indexGroups!.find(candidate => candidate.source === "MEMORY.md")!;
  assert.equal(group.stale, false);
  assert.match(snapshot.text, /^MEMORY\.md$/m);
  assert.doesNotMatch(snapshot.text, /entries added since/);
});

test("the daily job still regenerates a stale index rather than treating it as unchanged", { timeout: 5000 }, async t => {
  const x = await fixture(); t.after(() => rm(x.root, { recursive: true, force: true }));
  await mutateMemory(x.config, x.repo, "global", "add", "Billing detail about invoices.");
  await runDailySummary(x.config, model([{ name: "Billing", description: "Invoice handling", keywords: ["billing", "invoices"] }], []));
  await mutateMemory(x.config, x.repo, "global", "add", "Newly added deployment detail.");
  const calls: string[] = [];
  const result = await runDailySummary(x.config, model([{ name: "Deployment", description: "Release detail", keywords: ["deployment", "detail"] }], calls));
  assert.equal(result.updated, 1); assert.equal(calls.length, 1);
  const group = (await loadSnapshot(x.config, x.repo)).indexGroups!.find(candidate => candidate.source === "MEMORY.md")!;
  assert.equal(group.stale, false);
  assert.equal(group.categories[0]!.name, "Deployment");
});

test("category index is bounded: user, global, and the current repository come first; overflow stores are named only", () => {
  const injection = parseConfig({ enabled: true, vaultRoot: "/vault", memorySubdirectory: "memory", injection: { indexMaxChars: 700 } }).injection;
  const rows = (name: string) => [{ name, description: `${name} topics ${"x".repeat(120)}`, keywords: ["word"] }];
  const text = buildInjectedContext({ identity: { scope: "test", directory: "current" }, user: [], global: [], repository: [], text: "", indexGroups: [
    { source: "Repositories/other/MEMORY.md", categories: rows("Other") },
    { source: "Repositories/current/MEMORY.md", categories: rows("Current") },
    { source: "USER.md", categories: rows("User") },
    { source: "MEMORY.md", categories: rows("Global") },
  ] }, injection);
  assert.match(text, /USER\.md[\s\S]*MEMORY\.md[\s\S]*Repositories\/current\/MEMORY\.md/);
  assert.doesNotMatch(text, /Other topics/);
  assert.match(text, /reachable via search\): other/);
});
