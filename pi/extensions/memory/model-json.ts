/** The single model used for memory review, consolidation, cleanup, and indexing; Claude is the unattended fallback. */
export const MEMORY_MODEL = { provider: "openai-codex", id: "gpt-6.1-sol" } as const;

function outermostValue(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const end = text.lastIndexOf(text[start] === "{" ? "}" : "]");
  return end > start ? text.slice(start, end + 1) : undefined;
}

/**
 * Decodes a JSON-only model answer. Models sometimes wrap the value in a Markdown fence or add a sentence of
 * explanation after it; both framings are accepted, and the decoded value still goes through strict validation.
 * Throws SyntaxError when no candidate parses, so callers can report a fixed invalid_json code.
 */
export function parseModelJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, text, outermostValue(text)]) {
    if (candidate === undefined) continue;
    try { return JSON.parse(candidate.trim()); } catch { /* try the next framing */ }
  }
  throw new SyntaxError("model answer contains no JSON value");
}
