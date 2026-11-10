import { readFile, rename, writeFile } from "node:fs/promises";

/**
 * Failure codes that come from the environment (sleep, network, provider availability) rather than from
 * the memory content. Any of these means the day's run must be retried on the next trigger.
 */
const TRANSIENT_FAILURE = /\b(request_timeout|empty_provider_response|provider_request_failed|aborted|generation_failed|no_configured_model)\b/;

export function hasTransientFailure(messages: readonly string[]): boolean {
  return messages.some(message => TRANSIENT_FAILURE.test(message));
}

/** Local calendar date (YYYY-MM-DD), so "once a day" follows the user's day rather than UTC. */
export function localDate(now: Date): string {
  return now.toLocaleDateString("en-CA");
}

export async function readCompletedDate(path: string): Promise<string | undefined> {
  try { return (await readFile(path, "utf8")).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Atomic replace so an interrupted write can never leave a partial date that looks valid. */
export async function writeCompletedDate(path: string, date: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${date}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
