// Read-only practice run: times the exact daily index request per model. Never writes memory.
// Usage: node practice-run.ts <user|global> [timeoutMs=300000] [index|cleanup]
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { readDailySummaryTargets } from "./store.ts";
import { SUMMARY_MODEL_CANDIDATES, parseCategories } from "./daily-summary.ts";
import { dailyCleanupGenerationInput, parseDailyCleanupPlan } from "./daily-cleanup.ts";

const scope = process.argv[2] ?? "global";
const timeoutMs = Number(process.argv[3] ?? 300_000);
const mode = process.argv[4] ?? "index"; // "index" or "cleanup"; cleanup plans are parsed, never applied
const source = await readFile(new URL("./daily-summary.ts", import.meta.url), "utf8");
const systemPrompt = source.match(/systemPrompt: "(Return JSON only:[^"]*)"/)?.[1];
if (!systemPrompt) throw new Error("could not locate index system prompt");

const config = await loadConfig();
const target = (await readDailySummaryTargets(config)).find(t => t.summaryScope === scope && !t.repositoryDirectory);
if (!target) throw new Error(`no ${scope} target`);
const pins = config.injection.pins[target.target];
const cleanupInput = dailyCleanupGenerationInput(target, pins);
const text = mode === "cleanup" ? cleanupInput.text : JSON.stringify({ scope: target.summaryScope, entries: target.entries }).slice(0, 32_000);
const prompt = mode === "cleanup" ? cleanupInput.systemPrompt : systemPrompt;
console.log(`mode=${mode} scope=${scope} entries=${target.entries.length} inputChars=${text.length} timeout=${timeoutMs}ms`);

const t0 = Date.now();
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const runtime: any = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(15_000) });
console.log(`runtime startup ${Date.now() - t0}ms`);

await Promise.all(SUMMARY_MODEL_CANDIDATES.map(async ({ provider, model: id }) => {
  const tag = `${provider}/${id}`;
  if (!runtime.hasConfiguredAuth(provider)) return console.log(`${tag}: no auth`);
  const model = runtime.getModel(provider, id);
  if (!model) return console.log(`${tag}: model unknown`);
  console.log(`${tag}: reasoning=${model.reasoning} maxOutput=${model.maxTokens} api=${model.api}`);
  const start = Date.now();
  try {
    const response = await runtime.complete(model, {
      systemPrompt: prompt,
      messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
    }, { signal: AbortSignal.timeout(timeoutMs), cacheRetention: "none" });
    const answer = response.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    const kinds = response.content.map((p: any) => p.type).join(",");
    let parsed = "ok";
    try {
      if (mode === "cleanup") { const plan = parseDailyCleanupPlan(answer, target, pins); parsed = `ok (remove ${plan.remove.length}, merge ${plan.merge.length}, skipped ${plan.skipped})`; }
      else parsed = `ok (${parseCategories(answer, target.entries.join("\n")).length} categories)`;
    } catch (e) { parsed = `FAIL ${(e as Error).name}`; }
    console.log(`${tag}: ${Date.now() - start}ms stop=${response.stopReason} parts=[${kinds}] usage=${JSON.stringify(response.usage)} answerChars=${answer.length} parse=${parsed}`);
    console.log(`${tag}: answer head: ${answer.slice(0, 160).replace(/\s+/g, " ")}`);
    console.log(`${tag}: answer tail: ${answer.slice(-120).replace(/\s+/g, " ")}`);
  } catch (error) {
    console.log(`${tag}: ERROR after ${Date.now() - start}ms: ${(error as Error).name}: ${(error as Error).message.slice(0, 200)}`);
  }
}));
