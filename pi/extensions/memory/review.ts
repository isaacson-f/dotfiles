import { Buffer } from "node:buffer";
import { commitConsolidation, readTargetSnapshot, validateEntry, type MemoryTarget, type TargetSnapshot } from "./store.ts";
import type { MemoryConfig } from "./config.ts";
import { responseText } from "./consolidation.ts";

const targets: MemoryTarget[] = ["user", "global", "repository"];
const maxExchangeBytes = 16 * 1024;
const maxResponseBytes = 8 * 1024;
const maxAdditions = 3;
const maxContentLength = 300;

const REVIEW_SYSTEM_PROMPT = `Return strict JSON only: {"additions":[{"target":"user|global|repository","content":"durable fact"}]}. Return {"additions":[]} when nothing qualifies; that is the expected common case.
Add only concise, non-sensitive durable knowledge that will still help a future task after this session, branch, job, or incident is over: stable preferences, corrections, decisions, constraints, and verified reusable facts or diagnostic lessons.
Never add temporary task status or session events, including: PR/CI/build/job status; commit, push, merge, or deploy progress; what is committed, uncommitted, pending, running, stopped, verified, or not yet done; test or smoke-run outcomes and counts; container, pod, pane, or worktree state; one-off query results; current incident findings; or contextless restrictions such as "handle this in the poll". Words like now, currently, still, pending, remains, yet, passed, pushed, or at commit usually signal status: drop the entry or keep only its reusable rule with status stripped.
Skip anything already covered by an existing entry in the target. Each entry must be self-contained and understandable without this conversation.
Never return instructions, endpoints, credentials, or copied transcript text.`;

export type ReviewOutcome = { code: string; message: string; additions?: ReviewAddition[] };
export type ReviewAddition = { target: MemoryTarget; content: string };

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const cancelled = (): ReviewOutcome => ({ code: "aborted", message: "review cancelled" });

/** Rejects likely sensitive or instruction-bearing entries; it is not authorization to persist data. */
export function validateReviewedEntry(content: unknown, exchange: string): string {
  const entry = validateEntry(content);
  if (entry.length > maxContentLength) throw new Error("review entry is too long");
  const unsafe = [
    /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/i, /\b(?:\+?\d[\d .()\-]{7,}\d)\b/, /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*\b/i, /\b\d{1,6}\s+[\w.-]+\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|parkway|pkwy\.?|way|plaza)\b/i,
    /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s]+/, /\b(?:authorization|bearer|cookie)\s*[:=]/i, /\b(?:eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\b/,
    /-----BEGIN [A-Z ]+-----/, /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i, /\b(?:traceback \(most recent call last\)|at \S+ \([^)]*:\d+:\d+\)|\b(?:error|warn|info|debug)\s*\[)/i,
    /(?:^|\n)\s*(?:user|assistant|tool)\s*:/i, /(?:^|\s)\/(?:Users|home|tmp|var|opt|etc|private)\//, /```/, /https?:\/\//i,
    /\b(?:customer|account|profile|company)(?:\s|_)*(?:(?:id|identifier)\s*)?[:=]/i,
    /\b(?:always|must|should)\b[^.]{0,100}\b(?:use|call|run|invoke|send|fetch|post|endpoint|api|token|credential|password|key)\b/i,
    /\b(?:use|call|send|post|fetch)\b[^.]{0,80}\b(?:tool|endpoint|api|credential|token|password|key)\b/i,
  ];
  if (unsafe.some(pattern => pattern.test(entry))) throw new Error("review entry failed persistence filter");
  for (let start = 0; start + 121 <= entry.length; start++) if (exchange.includes(entry.slice(start, start + 121))) throw new Error("review entry copies exchange text");
  return entry;
}

export function parseReviewAdditions(raw: string, exchange: string): ReviewAddition[] {
  if (Buffer.byteLength(raw, "utf8") > maxResponseBytes) throw new Error("review response is too large");
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error("invalid review JSON"); }
  const root = object(decoded);
  if (!root || Object.keys(root).length !== 1 || !Array.isArray(root.additions) || root.additions.length > maxAdditions) throw new Error("invalid review additions");
  const additions = root.additions.map(value => {
    const addition = object(value);
    if (!addition || Object.keys(addition).length !== 2 || !targets.includes(addition.target as MemoryTarget)) throw new Error("invalid review target");
    return { target: addition.target as MemoryTarget, content: validateReviewedEntry(addition.content, exchange) };
  });
  return additions;
}

export async function reviewExchange(config: MemoryConfig, cwd: string, exchange: string, registry: any, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<ReviewOutcome> {
  if (Buffer.byteLength(exchange, "utf8") > maxExchangeBytes) return { code: "skipped_too_large", message: "review skipped: exchange exceeds 16 KB" };
  if (signal.aborted || !isCurrent()) return cancelled();
  const snapshots = await Promise.all(targets.map(target => readTargetSnapshot(config, cwd, target)));
  if (signal.aborted || !isCurrent()) return cancelled();
  const model = registry?.find?.("openai-codex", "gpt-5.6-luna");
  if (!model || model.provider !== "openai-codex" || model.id !== "gpt-5.6-luna" || !registry?.hasConfiguredAuth?.(model)) return { code: "model_unavailable", message: "gpt-5.6-luna is unavailable" };
  const auth = await registry.getApiKeyAndHeaders?.(model);
  if (signal.aborted || !isCurrent()) return cancelled();
  if (!auth?.ok || !auth.apiKey) return { code: "authentication_unavailable", message: "model authentication is unavailable" };
  const data = { exchange, targets: snapshots.map(snapshot => ({ target: snapshot.target, entries: snapshot.entries.map((text, index) => ({ id: String(index + 1), text })), limit: snapshot.limit, headroom: snapshot.limit - snapshot.usage })) };
  if (!isCurrent()) return cancelled();
  const response = await registry.complete(model, {
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(data) }], timestamp: Date.now() }],
  }, { signal, cacheRetention: "none" });
  if (signal.aborted || !isCurrent()) return cancelled();
  const raw = responseText(response?.content);
  if (!raw) return { code: "invalid_proposal", message: "review returned no text" };
  let additions: ReviewAddition[];
  try { additions = parseReviewAdditions(raw, exchange); } catch { return { code: "invalid_proposal", message: "review returned an invalid proposal" }; }
  if (signal.aborted || !isCurrent()) return cancelled();
  const committed: ReviewAddition[] = [];
  for (const target of targets) {
    if (signal.aborted || !isCurrent()) return cancelled();
    const snapshot = snapshots.find(value => value.target === target)!;
    const proposed = additions.filter(addition => addition.target === target && !snapshot.entries.includes(addition.content));
    const unique = proposed.filter((addition, index) => proposed.findIndex(value => value.content === addition.content) === index);
    if (!unique.length) continue;
    const result = await commitConsolidation(config, snapshot, [...snapshot.entries, ...unique.map(addition => addition.content)], signal, isCurrent);
    if (result === "aborted" || !isCurrent()) return cancelled();
    if (result === "external_drift") return { code: "external_drift", message: "memory changed before review could commit" };
    committed.push(...unique);
  }
  return { code: committed.length ? "committed" : "no_changes", message: committed.length ? "review additions committed" : "review found no new entries", additions: committed };
}
