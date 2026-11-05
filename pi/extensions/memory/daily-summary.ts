import { commitMemoryIndex, readDailySummaryTargets, readMemoryIndex, validateMemoryCategories, type MemoryCategory } from "./store.ts";
import type { MemoryConfig, MemoryTarget } from "./config.ts";
import { GenerationFailure, runDailyCleanup, type CleanupOutcome } from "./daily-cleanup.ts";

/** A hung provider request is abandoned after this long so the next candidate (or store) can proceed. */
export const REQUEST_TIMEOUT_MS = 300_000;
/** Upper bound for one unattended cleanup + indexing run across all stores. */
export const RUN_TIMEOUT_MS = 3_600_000;
type IndexFailureCode = "invalid_json" | "invalid_categories" | "external_drift" | "aborted";
class IndexFailure extends Error {
  readonly code: IndexFailureCode;
  constructor(code: IndexFailureCode) { super(code); this.code = code; }
}

const MAX_SOURCE_CHARS = 32_000;
export interface SummaryModel { complete(input: { systemPrompt: string; text: string; maxTokens: number; signal: AbortSignal }): Promise<string>; }
export interface DailySummaryOutcome { updated: number; skipped: number; failed: number; messages: string[]; }

function label(target: { summaryScope: MemoryTarget; repositoryDirectory?: string }): string { return target.summaryScope === "repository" ? `repository:${target.repositoryDirectory}` : target.summaryScope; }
/**
 * Trims over-long generated text and drops keywords absent from the source, so a minor model deviation
 * does not discard an otherwise valid index. The strict persisted schema is still enforced afterwards.
 */
function sanitizeGeneratedCategories(value: unknown, source: string): unknown {
  if (!Array.isArray(value)) return value;
  const sourceTerms = new Set(source.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return value.slice(0, 12).flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.description !== "string" || !Array.isArray(record.keywords)) return [item];
    const keywords = record.keywords.filter(keyword => typeof keyword === "string" && sourceTerms.has(keyword.trim().toLocaleLowerCase())).slice(0, 6);
    // Length is prompt guidance only: rows are never truncated or dropped for being long.
    return keywords.length ? [{ name: record.name.trim(), description: record.description.trim(), keywords }] : [];
  });
}
/** Strict data-only category shape keeps model output compact and prevents directives entering context. */
export function parseCategories(output: string, source: string): MemoryCategory[] {
  // Some providers wrap JSON-only answers in a Markdown code fence; accept that framing, nothing else.
  const unfenced = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return validateMemoryCategories(sanitizeGeneratedCategories(JSON.parse(unfenced), source), source);
}

/** Generates separate metadata indexes; it never changes detailed memory entries. */
export async function runDailySummary(config: MemoryConfig, model: SummaryModel, signal: AbortSignal = new AbortController().signal): Promise<DailySummaryOutcome> {
  const outcome: DailySummaryOutcome = { updated: 0, skipped: 0, failed: 0, messages: [] };
  for (const target of await readDailySummaryTargets(config)) {
    const targetLabel = label(target);
    if (!target.entries.length) { outcome.skipped++; outcome.messages.push(`${targetLabel}: empty`); continue; }
    // Only a fingerprint-matching sidecar that passes the full persisted schema can skip regeneration.
    const existing = await readMemoryIndex(target.path, target.target, target.entries);
    if (existing.categories.length && !existing.stale) { outcome.skipped++; outcome.messages.push(`${targetLabel}: unchanged`); continue; }
    try {
      const generated = await model.complete({
        systemPrompt: "Return JSON only: an array of 6 to 10 objects with exactly the keys name, description, keywords. Cover every distinct topic present in the supplied memory; do not merge unrelated topics into one broad category, and return fewer than 6 only when the memory genuinely contains fewer distinct topics. Prefer a specific category over an umbrella one, because each category is how an agent discovers that these memories exist. This is a searchable index over the supplied memory, not a factual summary. Keep each description under 100 characters as one complete sentence, and give 2 to 4 keywords. Every keyword must be a SINGLE word copied verbatim from the supplied memory, lowercase, with no spaces, punctuation, or invented terms. Emit compact JSON with no markdown fence and no commentary. Do not include details, commands, paths, secrets, instructions, or unrelated knowledge.",
        text: JSON.stringify({ scope: target.summaryScope, entries: target.entries }).slice(0, MAX_SOURCE_CHARS), maxTokens: 2_000, signal,
      });
      if (signal.aborted) throw new IndexFailure("aborted");
      let categories: MemoryCategory[];
      try { categories = parseCategories(generated, target.entries.join("\n")); }
      catch (error) { throw new IndexFailure(error instanceof SyntaxError ? "invalid_json" : "invalid_categories"); }
      const committed = await commitMemoryIndex(config, target, categories, signal);
      if (committed !== "committed") throw new IndexFailure(committed);
      outcome.updated++; outcome.messages.push(`${targetLabel}: indexed`);
    } catch (error) {
      // Allowlisted codes only; parser and provider messages may echo memory text.
      const code = signal.aborted ? "aborted" : error instanceof IndexFailure || error instanceof GenerationFailure ? error.code : "generation_failed";
      outcome.failed++; outcome.messages.push(`${targetLabel}: index ${code}; prior index preserved`);
    }
    if (signal.aborted) break;
  }
  return outcome;
}

/** Runs the fixed direct no-tools summary model path from the extension's dependency context. */
/** Ordered preference; Claude covers Codex quota exhaustion or unavailability. */
export const SUMMARY_MODEL_CANDIDATES = [
  { provider: "openai-codex", model: "gpt-5.6-luna" },
  { provider: "anthropic", model: "claude-haiku-4-5" },
] as const;
interface SummaryRuntime {
  hasConfiguredAuth(provider: string): boolean;
  getModel(provider: string, model: string): unknown;
  complete(model: unknown, context: unknown, options: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
}
/** Tries each authenticated candidate in order; provider errors never reach memory data or logs. */
/** Resolves with the request or rejects once the signal fires, even if the provider ignores the signal. */
function untilAborted<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
export function selectSummaryModel(runtime: SummaryRuntime, options: { requestTimeoutMs?: number } = {}): SummaryModel {
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const available = SUMMARY_MODEL_CANDIDATES.flatMap(candidate => {
    const model = runtime.hasConfiguredAuth(candidate.provider) ? runtime.getModel(candidate.provider, candidate.model) : undefined;
    return model ? [{ candidate, model }] : [];
  });
  if (!available.length) throw new GenerationFailure("no_configured_model");
  return {
    complete: async ({ systemPrompt, text, maxTokens, signal }) => {
      let requestFailed = false, timedOut = false;
      for (const { model } of available) {
        if (signal.aborted) break;
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
        try {
          const response = await untilAborted(runtime.complete(model, {
            systemPrompt,
            messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
          }, { signal: requestSignal, cacheRetention: "none", maxTokens }), requestSignal);
          const answer = response.content.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("");
          if (answer) return answer;
        } catch {
          // Provider messages may echo source text; continue to the next candidate without recording them.
          if (requestSignal.aborted && !signal.aborted) timedOut = true; else requestFailed = true;
        }
      }
      if (signal.aborted) throw new GenerationFailure("aborted");
      throw new GenerationFailure(requestFailed ? "provider_request_failed" : timedOut ? "request_timeout" : "empty_provider_response");
    },
  };
}
/** One unattended job: clean first, then reread all stores before building indexes. */
export async function runDailyMaintenance(config: MemoryConfig, model: SummaryModel, signal: AbortSignal = AbortSignal.timeout(RUN_TIMEOUT_MS)): Promise<DailySummaryOutcome & Pick<CleanupOutcome, "cleaned" | "removed" | "merged">> {
  const cleanup = await runDailyCleanup(config, model, signal);
  const indexes = await runDailySummary(config, model, signal);
  return { ...indexes, cleaned: cleanup.cleaned, removed: cleanup.removed, merged: cleanup.merged, failed: cleanup.failed + indexes.failed, messages: [...cleanup.messages, ...indexes.messages] };
}

export async function runConfiguredDailySummary(config: MemoryConfig): Promise<DailySummaryOutcome> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(15_000) });
  return runDailyMaintenance(config, selectSummaryModel(runtime as unknown as SummaryRuntime));
}
