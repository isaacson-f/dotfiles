import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai";
const MODEL = "gpt-5.6-luna";

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.modelRegistry.find(PROVIDER, MODEL);
    if (!model) {
      ctx.ui.notify(`${PROVIDER}/${MODEL} is unavailable; using default compaction`, "warning");
      return;
    }

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        const reason = auth.ok ? "no API key is configured" : auth.error;
        ctx.ui.notify(`Luna compaction unavailable (${reason}); using default compaction`, "warning");
        return;
      }

      ctx.ui.notify(`Compacting with ${PROVIDER}/${MODEL}`, "info");
      const result = await compact(
        event.preparation,
        model,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        "off",
        undefined,
        auth.env,
      );

      return { compaction: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Luna compaction failed (${message}); using default compaction`, "warning");
      return;
    }
  });
}
