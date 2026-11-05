import { commitConsolidation, readTargetSnapshot, validateEntry, type MemoryTarget, type TargetSnapshot } from "./store.ts";
import type { MemoryConfig } from "./config.ts";

const targets: MemoryTarget[] = ["user", "global", "repository"];
const threshold = (snapshot: TargetSnapshot) => snapshot.usage >= Math.ceil(snapshot.limit * 0.8);

export interface ConsolidationGroup { sources: string[]; content: string; }
export interface ConsolidationPlan { groups: ConsolidationGroup[]; nextEntries: string[]; }

export async function selectConsolidationTarget(config: MemoryConfig, cwd: string, requireThreshold = true): Promise<TargetSnapshot | undefined> {
  const snapshots = await Promise.all(targets.map(target => readTargetSnapshot(config, cwd, target)));
  return snapshots.filter(snapshot => snapshot.entries.length > 0 && (!requireThreshold || threshold(snapshot))).sort((a, b) => b.usage / b.limit - a.usage / a.limit || b.usage - a.usage)[0];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Parses only the compact group format and reconstructs exact local mutations. */
export function parseConsolidationPlan(raw: string, snapshot: TargetSnapshot): ConsolidationPlan {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error("invalid consolidation JSON"); }
  const root = object(decoded);
  if (!root || Object.keys(root).length !== 1 || !Array.isArray(root.groups) || root.groups.length < 1 || root.groups.length > 8) {
    throw new Error("invalid consolidation groups");
  }
  const known = new Map(snapshot.entries.map((text, index) => [String(index + 1), { text, index }]));
  const used = new Set<string>();
  const replacements = new Map<number, string>();
  const removals = new Set<number>();
  let sourceCount = 0;
  const groups: ConsolidationGroup[] = [];
  for (const value of root.groups) {
    const group = object(value);
    if (!group || Object.keys(group).length !== 2 || !Array.isArray(group.sources) || group.sources.length < 1 || group.sources.length > 8 || typeof group.content !== "string") {
      throw new Error("invalid consolidation group");
    }
    const sources: string[] = [];
    for (const id of group.sources) {
      if (typeof id !== "string" || !known.has(id) || used.has(id)) throw new Error("unknown or reused consolidation source");
      used.add(id); sources.push(id); sourceCount++;
    }
    if (sourceCount > 12) throw new Error("too many consolidation sources");
    const content = validateEntry(group.content);
    const first = known.get(sources[0])!;
    replacements.set(first.index, content);
    for (const id of sources.slice(1)) removals.add(known.get(id)!.index);
    groups.push({ sources, content });
  }
  const nextEntries = snapshot.entries.flatMap((entry, index) => removals.has(index) ? [] : [replacements.get(index) ?? entry]);
  if (new Set(nextEntries).size !== nextEntries.length) throw new Error("consolidation creates duplicate entries");
  const nextUsage = nextEntries.length ? `${nextEntries.join("\n§\n")}\n`.length : 0;
  if (nextUsage >= snapshot.usage) throw new Error("consolidation did not reduce usage");
  return { groups, nextEntries };
}

export function responseText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return;
  const text = content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : undefined);
  return text.every((part): part is string => typeof part === "string") ? text.join("") : undefined;
}

export async function consolidateSnapshot(config: MemoryConfig, snapshot: TargetSnapshot, registry: any, signal: AbortSignal, isCurrent: () => boolean = () => true): Promise<{ code: string; message: string }> {
  const cancelled = () => ({ code: "aborted", message: "consolidation cancelled" });
  if (signal.aborted || !isCurrent()) return cancelled();
  const model = registry?.find?.("openai-codex", "gpt-5.6-luna");
  if (!model || model.provider !== "openai-codex" || model.id !== "gpt-5.6-luna" || !registry?.hasConfiguredAuth?.(model)) {
    return { code: "model_unavailable", message: "gpt-5.6-luna is unavailable" };
  }
  const auth = await registry.getApiKeyAndHeaders?.(model);
  if (signal.aborted || !isCurrent()) return cancelled();
  if (!auth?.ok || !auth.apiKey) return { code: "authentication_unavailable", message: "model authentication is unavailable" };
  const data = { target: snapshot.target, entries: snapshot.entries.map((text, index) => ({ id: String(index + 1), text })), limit: snapshot.limit, headroom: snapshot.limit - snapshot.usage };
  if (!isCurrent()) return cancelled();
  const response = await registry.complete(model, {
    systemPrompt: "Return strict JSON only: {\"groups\":[{\"sources\":[\"id\"],\"content\":\"replacement\"}]}. Consolidate the supplied entries into shorter durable entries. Drop temporary task status (PR/CI/commit/push/deploy progress, pending or unverified work, test outcomes, container or job state) while preserving any reusable rule it carries.",
    messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(data) }], timestamp: Date.now() }],
  }, { signal, cacheRetention: "none", maxTokens: 1200 });
  if (signal.aborted || !isCurrent()) return cancelled();
  const raw = responseText(response?.content);
  if (!raw) return { code: "invalid_response", message: "model returned no text" };
  if (signal.aborted || !isCurrent()) return cancelled();
  let plan: ConsolidationPlan;
  try { plan = parseConsolidationPlan(raw, snapshot); } catch { return { code: "invalid_plan", message: "invalid consolidation plan" }; }
  if (signal.aborted || !isCurrent()) return cancelled();
  // The signal is threaded into the commit so cancellation is honored while waiting
  // on the mutation queue and right up to the final rename.
  const committed = await commitConsolidation(config, snapshot, plan.nextEntries, signal);
  if (committed === "aborted" || !isCurrent()) return cancelled();
  return committed === "committed"
    ? { code: "committed", message: `${snapshot.target} memory consolidated` }
    : { code: "external_drift", message: `${snapshot.target} memory changed before consolidation could commit` };
}
