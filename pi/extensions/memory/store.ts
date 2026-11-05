import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RECENT_MAX_CHARS, encodePinnedEntry, formatPinnedContext, type MemoryConfig, type MemoryTarget } from "./config.ts";
import { repositoryIdentity, type RepositoryIdentity } from "./scopes.ts";

export const DELIMITER = "\n§\n";
export const MEMORY_CONTEXT_TYPE = "pi-memory-context";
/** Reserved, data-only entry prefix for the one automatic summary permitted per mutable scope. */
export interface MemoryCategory { name: string; description: string; keywords: string[]; }
/** Bumped to 6 when indexes began recording generatedAt/entryCount so out-of-date lag can be labelled. */
export const MEMORY_INDEX_VERSION = 6;
export interface MemoryIndex { version: typeof MEMORY_INDEX_VERSION; fingerprint: string; generatedAt: string; entryCount: number; categories: MemoryCategory[]; }
/** A read index, plus how far the store has moved since it was generated. */
export interface MemoryIndexRead { categories: MemoryCategory[]; stale: boolean; generatedAt?: string; addedSince?: number; }
const indexPathFor = (path: string): string => `${path}.index.json`;
export type { MemoryTarget } from "./config.ts";
export interface MemorySnapshot { identity: RepositoryIdentity; user: string[]; global: string[]; repository: string[]; /** Registry-known repositories form one logical searchable collection. */ repositorySources?: Array<{ directory: string; entries: string[] }>; text: string; /** Rendered as an ASCII tree grouped by the store file each category came from. */ indexGroups?: Array<{ source: string; categories: MemoryCategory[]; stale?: boolean; generatedAt?: string; addedSince?: number }>; }
export interface TargetSnapshot { target: MemoryTarget; entries: string[]; serialized: string; usage: number; limit: number; path: string; recencyPath?: string; scopePaths?: Record<MemoryTarget, string>; recency?: RecencyState; }
/** A summary target is either the shared global store or one existing registry repository store. */
export interface DailySummaryTarget extends TargetSnapshot { summaryScope: MemoryTarget; repositoryDirectory?: string; }
interface RecencyState { entries: Map<string, number>; }
export interface SearchResult { target: MemoryTarget; source: string; content: string; }
type SearchCode = "ok" | "no_results" | "invalid_query" | "invalid_scope";
export type SearchOutcome = { code: SearchCode; results: SearchResult[]; maxChars: number; message?: string };
const targets: MemoryTarget[] = ["user", "global", "repository"];
const limitFor = (config: MemoryConfig, target: MemoryTarget) => config.limits[target];
const serialize = (entries: string[]) => entries.length ? `${entries.join(DELIMITER)}\n` : "";
const MAX_RECENCY_BYTES = 512 * 1024;
const entryId = (entry: string) => createHash("sha256").update(entry).digest("hex");
const emptyRecency = (): RecencyState => ({ entries: new Map() });
const recencyPathFor = (path: string) => `${path}.recent.json`;
async function directory(path: string): Promise<void> { try { const value = await lstat(path); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`unsafe memory directory: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(path, { recursive: true, mode: 0o700 }); const value = await lstat(path); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`unsafe memory directory: ${path}`); } }
async function root(config: MemoryConfig): Promise<string> { await directory(config.vaultRoot); const path = join(config.vaultRoot, config.memorySubdirectory); await directory(path); return path; }
async function paths(config: MemoryConfig, identity: RepositoryIdentity): Promise<Record<MemoryTarget, string>> { const base = await root(config), repositories = join(base, "Repositories"), repository = join(repositories, identity.directory); await directory(repositories); await directory(repository); return { user: join(base, "USER.md"), global: join(base, "MEMORY.md"), repository: join(repository, "MEMORY.md") }; }
function parse(raw: string, config: MemoryConfig, target: MemoryTarget): string[] { if (!raw) return []; if (!raw.endsWith("\n") || raw.length > limitFor(config, target)) throw new Error(`${target} memory is malformed or exceeds its budget`); const entries = raw.slice(0, -1).split(DELIMITER); if (entries.some(entry => !entry.trim() || entry.includes(DELIMITER)) || new Set(entries).size !== entries.length || serialize(entries) !== raw) throw new Error(`${target} memory is malformed`); return entries; }
async function readStore(path: string, config: MemoryConfig, target: MemoryTarget): Promise<string[]> { try { const value = await lstat(path); if (!value.isFile() || value.isSymbolicLink()) throw new Error(`unsafe memory file: ${path}`); if (value.size > limitFor(config, target) * 4) throw new Error(`${target} memory exceeds its budget`); return parse(await readFile(path, "utf8"), config, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
/** Missing or invalid sidecars deliberately fall back to deterministic stored order; they never block memory access. */
async function readRecency(path: string, entries: string[]): Promise<RecencyState> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink() || value.size > MAX_RECENCY_BYTES) return emptyRecency();
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyRecency();
    const record = parsed as { version?: unknown; entries?: unknown };
    if (record.version !== 2 || !record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) return emptyRecency();
    const allowed = new Set(entries.map(entryId)), recent = new Map<string, number>();
    for (const [id, value] of Object.entries(record.entries as Record<string, unknown>)) {
      if (/^[a-f0-9]{64}$/.test(id) && isPositiveSafeInteger(value) && allowed.has(id)) recent.set(id, value);
    }
    return { entries: recent };
  } catch { return emptyRecency(); }
}
function isPositiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** Reads only this snapshot's three permitted stores; broken metadata contributes no ordering claim. */
async function recencyCeiling(config: MemoryConfig, storePaths: Record<MemoryTarget, string>): Promise<number> {
  const values = await Promise.all(targets.map(async target => {
    try {
      const entries = await readStore(storePaths[target], config, target);
      const state = await readRecency(recencyPathFor(storePaths[target]), entries);
      return Math.max(0, ...state.entries.values());
    } catch { return 0; }
  }));
  return Math.max(0, ...values);
}
function mutationTimestamp(ceiling: number): number {
  const wallClock = Date.now();
  return ceiling < Number.MAX_SAFE_INTEGER ? Math.max(wallClock, ceiling + 1) : ceiling;
}
/** Retains known timestamps only for unchanged content; new content receives this real mutation time or its monotonic floor. */
function nextRecency(previous: RecencyState, beforeEntries: string[], entries: string[], timestamp = Date.now()): RecencyState {
  const before = new Set(beforeEntries.map(entryId)), recent = new Map<string, number>();
  for (const entry of entries) {
    const id = entryId(entry), prior = previous.entries.get(id);
    if (before.has(id)) { if (prior !== undefined) recent.set(id, prior); }
    else recent.set(id, timestamp);
  }
  return { entries: recent };
}
const serializeRecency = (state: RecencyState) => JSON.stringify({ version: 2, entries: Object.fromEntries(state.entries) });
async function atomicWrite(path: string, content: string, config: MemoryConfig, target?: MemoryTarget, expected?: string, signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<"committed" | "external_drift" | "aborted"> { await directory(dirname(path)); if (signal?.aborted || !isCurrent()) return "aborted"; const temp = join(dirname(path), `.${randomUUID()}.tmp`); try { await writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); if (signal?.aborted || !isCurrent()) return "aborted"; if (target !== undefined && expected !== undefined) { const current = serialize(await readStore(path, config, target)); if (signal?.aborted || !isCurrent()) return "aborted"; if (current !== expected) return "external_drift"; } await new Promise<void>(resolve => setImmediate(resolve)); if (signal?.aborted || !isCurrent()) return "aborted"; await rename(temp, path); return "committed"; } catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; } finally { await rm(temp, { force: true }).catch(() => {}); } }
export function validateEntry(content: unknown): string { if (typeof content !== "string") throw new Error("content must be text"); const entry = content.trim(); if (!entry || entry.includes(DELIMITER)) throw new Error("content must be a non-empty entry without the memory separator"); return entry; }
function exactEntry(entries: string[], oldText: unknown): number { if (typeof oldText !== "string" || !oldText) throw new Error("oldText must be a non-empty exact entry"); const index = entries.indexOf(oldText); if (index < 0) throw new Error("oldText did not match an entry"); return index; }
function sourceFor(target: MemoryTarget, identity: RepositoryIdentity, directory = identity.directory): string { return target === "user" ? "USER.md" : target === "global" ? "MEMORY.md" : `Repositories/${directory}/MEMORY.md`; }
/** Unicode letter/number tokens only; matching is case-insensitive without stemming or fuzzy expansion. */
function terms(text: string): string[] { return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function cap(text: string, maxChars: number): string { return text.length <= maxChars ? text : text.slice(0, maxChars); }
function formatEntry(entry: SearchResult): string { return `[${entry.target}] ${entry.source}\n${entry.content}`; }
/** Complete serialized tool output; all outcome text is capped at the caller's maxChars. */
export function formatSearchResult(result: SearchOutcome): string { if (result.code === "ok") return cap(result.results.map(formatEntry).join("\n\n"), result.maxChars); if (result.code === "no_results") return cap("No results.", result.maxChars); return cap(`Memory search unavailable: ${result.message}`, result.maxChars); }
/** Bounded deterministic local BM25 retrieval over only the caller-permitted current snapshot. */
export function searchMemory(snapshot: MemorySnapshot, input: { query: string; scopes?: MemoryTarget[]; limit?: number; maxChars?: number }): SearchOutcome { const maxChars = Number.isInteger(input.maxChars) && input.maxChars! > 0 ? Math.min(input.maxChars!, 8_000) : 2_000; const query = typeof input.query === "string" ? input.query.trim() : ""; const queryTerms = [...new Set(terms(query))]; if (!queryTerms.length) return { code: "invalid_query", results: [], maxChars, message: "query must contain at least one word" }; const requestedScopes = input.scopes ?? targets; if (!Array.isArray(requestedScopes) || !requestedScopes.length || requestedScopes.some(scope => !targets.includes(scope))) return { code: "invalid_scope", results: [], maxChars, message: "select one or more valid scopes" }; const scopes = targets.filter(target => requestedScopes.includes(target)); const documents: Array<SearchResult & { tokens: string[]; order: number }> = []; let order = 0; for (const target of scopes) {
    if (target === "repository" && snapshot.repositorySources) for (const repository of snapshot.repositorySources) for (const content of repository.entries) documents.push({ target, source: sourceFor(target, snapshot.identity, repository.directory), content, tokens: terms(content), order: order++ });
    else for (const content of snapshot[target]) documents.push({ target, source: sourceFor(target, snapshot.identity), content, tokens: terms(content), order: order++ });
  } const documentCount = documents.length; if (!documentCount) return { code: "no_results", results: [], maxChars }; const averageLength = documents.reduce((total, document) => total + document.tokens.length, 0) / documentCount; const documentFrequency = new Map<string, number>(); for (const term of queryTerms) documentFrequency.set(term, documents.reduce((count, document) => count + (document.tokens.includes(term) ? 1 : 0), 0)); const ranked: Array<SearchResult & { score: number; order: number }> = []; for (const document of documents) { let score = 0; for (const term of queryTerms) { const frequency = document.tokens.reduce((count, token) => count + Number(token === term), 0); if (!frequency) continue; const df = documentFrequency.get(term)!; const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)); const normalization = 1.2 * (1 - 0.75 + 0.75 * (averageLength ? document.tokens.length / averageLength : 0)); score += idf * (frequency * 2.2) / (frequency + normalization); } if (score > 0) ranked.push({ target: document.target, source: document.source, content: document.content, score, order: document.order }); } ranked.sort((a, b) => b.score - a.score || a.order - b.order); const limit = Number.isInteger(input.limit) && input.limit! > 0 ? Math.min(input.limit!, 20) : 5; const results: SearchResult[] = []; let used = 0; for (const item of ranked) { const visible = formatEntry(item); if (results.length >= limit || used + (results.length ? 2 : 0) + visible.length > maxChars) continue; results.push({ target: item.target, source: item.source, content: item.content }); used += (results.length > 1 ? 2 : 0) + visible.length; } return results.length ? { code: "ok", results, maxChars } : { code: "no_results", results: [], maxChars }; }
interface RecentPreview { text: string; knownText: string; unknownText: string; }
/** Selects whole, encoded entries; unknown legacy recency ties use stored scope/entry order. */
function recentPreview(snapshot: MemorySnapshot, recency: Record<MemoryTarget, RecencyState>, maxChars: number, pins: MemoryConfig["injection"]["pins"]): RecentPreview {
  if (!maxChars) return { text: "", knownText: "", unknownText: "" };
  const candidates = targets.flatMap((target, targetOrder) => snapshot[target].filter(entry => !pins[target].includes(entry)).map((entry, entryOrder) => ({ target, entry, targetOrder, entryOrder, timestamp: recency[target].entries.get(entryId(entry)) })));
  candidates.sort((a, b) => (b.timestamp ?? -1) - (a.timestamp ?? -1) || a.targetOrder - b.targetOrder || a.entryOrder - b.entryOrder);
  const selected: string[] = [], known: string[] = [], unknown: string[] = [], seen = new Set<string>(); let used = 0;
  for (const candidate of candidates) {
    const key = `${candidate.target}\0${candidate.entry}`, rendered = `- ${encodePinnedEntry(candidate.target, candidate.entry)}`;
    if (!seen.has(key) && used + (selected.length ? 1 : 0) + rendered.length <= maxChars) {
      selected.push(rendered); seen.add(key); used += (selected.length > 1 ? 1 : 0) + rendered.length;
      (candidate.timestamp === undefined ? unknown : known).push(rendered);
    }
  }
  return { text: selected.join("\n"), knownText: known.join("\n"), unknownText: unknown.join("\n") };
}
function fingerprint(target: MemoryTarget, entries: string[]): string { return createHash("sha256").update(JSON.stringify({ target, entries })).digest("hex"); }
/** Length is guidance given to the model, not a hard limit; only structural safety is enforced here. */
function validCategoryText(value: unknown): value is string { return typeof value === "string" && !!value.trim() && !/[\r\n§]/.test(value); }
/** Validates generated and persisted category rows against the same source-grounded data schema. */
export function validateMemoryCategories(value: unknown, source: string): MemoryCategory[] {
  const sourceTerms = new Set(source.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error("invalid category index");
  const categories = value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid category index");
    const record = item as Record<string, unknown>, keywords = record.keywords;
    if (Object.keys(record).some(key => !["name", "description", "keywords"].includes(key)) || !validCategoryText(record.name) || !validCategoryText(record.description) || !Array.isArray(keywords) || !keywords.length || keywords.length > 6 || keywords.some(keyword => !validCategoryText(keyword))) throw new Error("invalid category index");
    return { name: record.name.trim(), description: record.description.trim(), keywords: keywords.map(keyword => keyword.trim()) };
  });
  if (new Set(categories.map(category => category.name.toLocaleLowerCase())).size !== categories.length || categories.some(category => category.keywords.some(keyword => !sourceTerms.has(keyword.toLocaleLowerCase())))) throw new Error("invalid category index");
  return categories;
}
function safeText(value: string): string { return value.replace(/[\r\n]+/g, " ").replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/&/g, "\\u0026"); }
/** One bounded single-line row; provenance lives in the group heading, never repeated per row. */
function categoryRow(category: MemoryCategory, last: boolean): string { return `${last ? "\u2514\u2500\u2500" : "\u251c\u2500\u2500"} ${safeText(category.name)} \u2014 ${safeText(category.description)} [${category.keywords.map(safeText).join(", ")}]`; }
/**
 * Invalid metadata is indistinguishable from missing metadata. A merely out-of-date index is still
 * served: its categories describe entries that mostly still exist, and losing them would remove all
 * discoverability for the store until the next scheduled run. The caller labels the lag instead.
 */
export async function readMemoryIndex(path: string, target: MemoryTarget, entries: string[]): Promise<MemoryIndexRead> {
  const missing: MemoryIndexRead = { categories: [], stale: false };
  try {
    const value = await lstat(indexPathFor(path));
    if (!value.isFile() || value.isSymbolicLink() || value.size > 64 * 1024) return missing;
    const index = JSON.parse(await readFile(indexPathFor(path), "utf8")) as MemoryIndex;
    if (index?.version !== MEMORY_INDEX_VERSION) return missing;
    if (index.fingerprint === fingerprint(target, entries)) return { categories: validateMemoryCategories(index.categories, entries.join("\n")), stale: false };
    // Out of date: keep only rows whose keywords still occur in the current store.
    const current = new Set(entries.join("\n").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const categories = validateMemoryCategories(index.categories, index.categories.map(category => category.keywords.join(" ")).join(" "))
      .filter(category => category.keywords.some(keyword => current.has(keyword.toLocaleLowerCase())));
    if (!categories.length) return missing;
    const generatedAt = typeof index.generatedAt === "string" ? index.generatedAt : undefined;
    const previous = Number.isInteger(index.entryCount) ? index.entryCount : entries.length;
    return { categories, stale: true, generatedAt, addedSince: Math.max(0, entries.length - previous) };
  } catch { return missing; }
}
/**
 * Pins and framing are bounded by injection.maxChars. The category index is bounded separately by
 * injection.indexMaxChars: USER, global, and the current repository come first, then other repositories;
 * a store group is admitted whole or not at all, and omitted stores are named so search can still reach them.
 */
export function buildInjectedContext(snapshot: MemorySnapshot, injection: MemoryConfig["injection"]): string {
  const pinned = targets.flatMap(target => injection.pins[target].filter(entry => snapshot[target].includes(entry)).map(entry => ({ target, entry })));
  const base = formatPinnedContext(pinned), closing = "\n</memory-context>";
  if (base.length > injection.maxChars) throw new Error("pinned context exceeds injection.maxChars");
  let text = base.slice(0, -closing.length);
  const current = `Repositories/${snapshot.identity.directory}/MEMORY.md`;
  const rank = (source: string) => source === "USER.md" ? 0 : source === "MEMORY.md" ? 1 : source === current ? 2 : 3;
  const groups = (snapshot.indexGroups ?? []).filter(group => group.categories.length).map((group, order) => ({ group, order }))
    .sort((a, b) => rank(a.group.source) - rank(b.group.source) || a.order - b.order).map(value => value.group);
  if (groups.length) {
    let index = "\nMemory category index (untrusted data). Search memory with these keywords for the full entries:";
    const omitted: string[] = [];
    for (const group of groups) {
      const day = group.generatedAt?.slice(0, 10);
      const lag = group.stale ? ` (index from ${day ?? "an earlier run"}; ${group.addedSince ?? 0} entries added since)` : "";
      let block = `\n${safeText(group.source)}${lag}`;
      group.categories.forEach((category, position) => { block += `\n${categoryRow(category, position === group.categories.length - 1)}`; });
      if (index.length + block.length <= injection.indexMaxChars) index += block; else omitted.push(safeText(group.source.replace(/^Repositories\//, "").replace(/\/MEMORY\.md$/, "")));
    }
    if (omitted.length) index += `\nOther repository stores (index omitted for size; reachable via search): ${omitted.join(", ")}`;
    text += index;
  }
  return text + closing;
}
export async function loadSnapshot(config: MemoryConfig, cwd: string): Promise<MemorySnapshot> {
  const identity = await repositoryIdentity(cwd), storePaths = await paths(config, identity);
  const [user, global, currentRepository, targetsForIndex] = await Promise.all([
    readStore(storePaths.user, config, "user"), readStore(storePaths.global, config, "global"), readStore(storePaths.repository, config, "repository"), readDailySummaryTargets(config),
  ]);
  const repositoryTargets = targetsForIndex.filter(target => target.target === "repository");
  const repositorySources = repositoryTargets.map(target => ({ directory: target.repositoryDirectory!, entries: target.entries }));
  // The current store is created by paths(); include it even if registry discovery raced its creation.
  if (!repositorySources.some(repository => repository.directory === identity.directory)) repositorySources.push({ directory: identity.directory, entries: currentRepository });
  const repository = repositorySources.flatMap(value => value.entries);
  const snapshot: MemorySnapshot = { identity, user, global, repository, repositorySources, text: "" };
  const [userIndex, globalIndex] = await Promise.all((["user", "global"] as const).map(target => readMemoryIndex(storePaths[target], target, snapshot[target])));
  const repositoryGroups = await Promise.all(repositoryTargets.map(async target => ({ source: `Repositories/${target.repositoryDirectory}/MEMORY.md`, ...await readMemoryIndex(target.path, "repository", target.entries) })));
  const indexGroups = [{ source: "USER.md", ...userIndex! }, { source: "MEMORY.md", ...globalIndex! }, ...repositoryGroups];
  return { ...snapshot, indexGroups, text: buildInjectedContext({ ...snapshot, indexGroups }, config.injection) };
}
export async function viewMemory(config: MemoryConfig, cwd: string, target: MemoryTarget): Promise<{ entries: string[]; usage: number; limit: number }> { const identity = await repositoryIdentity(cwd), storePaths = await paths(config, identity), entries = await readStore(storePaths[target], config, target); return { entries, usage: serialize(entries).length, limit: limitFor(config, target) }; }
export async function readTargetSnapshot(config: MemoryConfig, cwd: string, target: MemoryTarget): Promise<TargetSnapshot> { const identity = await repositoryIdentity(cwd), scopePaths = await paths(config, identity), path = scopePaths[target], entries = await readStore(path, config, target), serialized = serialize(entries), recencyPath = recencyPathFor(path); return { target, entries, serialized, usage: serialized.length, limit: limitFor(config, target), path, recencyPath, scopePaths, recency: await readRecency(recencyPath, entries) }; }

/** Discovers only the documented memory registry: USER.md, global MEMORY.md, and direct repository MEMORY.md stores. */
export async function readDailySummaryTargets(config: MemoryConfig): Promise<DailySummaryTarget[]> {
  const base = await root(config), userPath = join(base, "USER.md"), globalPath = join(base, "MEMORY.md");
  const [userEntries, globalEntries] = await Promise.all([readStore(userPath, config, "user"), readStore(globalPath, config, "global")]);
  const result: DailySummaryTarget[] = [
    { target: "user", summaryScope: "user", entries: userEntries, serialized: serialize(userEntries), usage: serialize(userEntries).length, limit: limitFor(config, "user"), path: userPath, recencyPath: recencyPathFor(userPath), recency: await readRecency(recencyPathFor(userPath), userEntries) },
    { target: "global", summaryScope: "global", entries: globalEntries, serialized: serialize(globalEntries), usage: serialize(globalEntries).length, limit: limitFor(config, "global"), path: globalPath, recencyPath: recencyPathFor(globalPath), recency: await readRecency(recencyPathFor(globalPath), globalEntries) },
  ];
  const repositories = join(base, "Repositories");
  await directory(repositories);
  for (const name of (await readdir(repositories)).sort()) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) continue;
    const directoryPath = join(repositories, name);
    let info;
    try { info = await lstat(directoryPath); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const path = join(directoryPath, "MEMORY.md");
    let file;
    try { file = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!file.isFile() || file.isSymbolicLink()) continue;
    const entries = await readStore(path, config, "repository"), serialized = serialize(entries), recencyPath = recencyPathFor(path);
    result.push({ target: "repository", summaryScope: "repository", repositoryDirectory: name, entries, serialized, usage: serialized.length, limit: limitFor(config, "repository"), path, recencyPath, recency: await readRecency(recencyPath, entries) });
  }
  return result;
}
/** Publishes derived index metadata atomically only while the detailed source snapshot remains current. */
export async function commitMemoryIndex(config: MemoryConfig, snapshot: DailySummaryTarget, categories: MemoryCategory[], signal?: AbortSignal): Promise<"committed" | "external_drift" | "aborted"> {
  if (signal?.aborted) return "aborted";
  const content = JSON.stringify({ version: MEMORY_INDEX_VERSION, fingerprint: fingerprint(snapshot.target, snapshot.entries), generatedAt: new Date().toISOString(), entryCount: snapshot.entries.length, categories } satisfies MemoryIndex);
  return withFileMutationQueue(snapshot.path, async () => {
    if (signal?.aborted) return "aborted";
    if (serialize(await readStore(snapshot.path, config, snapshot.target)) !== snapshot.serialized) return "external_drift";
    const path = indexPathFor(snapshot.path), temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (signal?.aborted) return "aborted";
      if (serialize(await readStore(snapshot.path, config, snapshot.target)) !== snapshot.serialized) return "external_drift";
      await rename(temp, path); return "committed";
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  });
}
export function indexFingerprint(target: MemoryTarget, entries: string[]): string { return fingerprint(target, entries); }
/** Commits only when a bounded, validated reread still equals the pre-model snapshot. */
export async function commitConsolidation(config: MemoryConfig, snapshot: TargetSnapshot, nextEntries: string[], signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<"committed" | "external_drift" | "aborted"> {
  if (new Set(nextEntries).size !== nextEntries.length) throw new Error("memory entries must be unique");
  const content = serialize(nextEntries);
  if (content.length > snapshot.limit) throw new Error(`${snapshot.target} memory exceeds its ${snapshot.limit} character budget`);
  if (signal?.aborted || !isCurrent()) return "aborted";
  return withFileMutationQueue(snapshot.path, async () => {
    if (signal?.aborted || !isCurrent()) return "aborted";
    const current = serialize(await readStore(snapshot.path, config, snapshot.target));
    if (signal?.aborted || !isCurrent()) return "aborted";
    if (current !== snapshot.serialized) return "external_drift";
    if (content === current) return "committed";
    const ceiling = snapshot.scopePaths
      ? await recencyCeiling(config, snapshot.scopePaths)
      : Math.max(0, ...(snapshot.recency?.entries.values() ?? []));
    const timestamp = mutationTimestamp(ceiling);
    const committed = await atomicWrite(snapshot.path, content, config, snapshot.target, snapshot.serialized, signal, isCurrent);
    if (committed !== "committed") return committed;
    const recency = nextRecency(snapshot.recency ?? emptyRecency(), snapshot.entries, nextEntries, timestamp);
    await atomicWrite(snapshot.recencyPath ?? recencyPathFor(snapshot.path), serializeRecency(recency), config).catch(() => {});
    return "committed";
  });
}
export async function mutateMemory(config: MemoryConfig, cwd: string, target: MemoryTarget, action: "add" | "replace" | "remove", content?: unknown, oldText?: unknown): Promise<{ entries: string[]; usage: number; limit: number }> {
  const identity = await repositoryIdentity(cwd), scopePaths = await paths(config, identity), path = scopePaths[target], recencyPath = recencyPathFor(path);
  return withFileMutationQueue(path, async () => {
    const entries = await readStore(path, config, target), previousRecency = await readRecency(recencyPath, entries), next = [...entries];
    if (action === "add") {
      const entry = validateEntry(content);
      if (!next.includes(entry)) next.push(entry);
    } else {
      const index = exactEntry(next, oldText);
      if (action === "replace") next[index] = validateEntry(content);
      else next.splice(index, 1);
    }
    if (new Set(next).size !== next.length) throw new Error("memory entries must be unique");
    const serialized = serialize(next);
    if (serialized.length > limitFor(config, target)) throw new Error(`${target} memory exceeds its ${limitFor(config, target)} character budget`);
    if (serialized !== serialize(entries)) {
      const timestamp = mutationTimestamp(await recencyCeiling(config, scopePaths));
      await atomicWrite(path, serialized, config);
      await atomicWrite(recencyPath, serializeRecency(nextRecency(previousRecency, entries, next, timestamp)), config).catch(() => {});
    }
    return { entries: next, usage: serialized.length, limit: limitFor(config, target) };
  });
}
