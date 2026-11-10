import { mkdir, rm, stat } from "node:fs/promises";

export type DailySummaryLockResult = "completed" | "already-running";

/** Longer than the extension's one-hour run cap, so only a lock left by a killed process is reclaimed. */
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

async function acquire(lock: string): Promise<boolean> {
  try { await mkdir(lock, { mode: 0o700 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}

/** Only the invocation that created the lock directory may remove it; a lock older than staleMs is reclaimed once. */
export async function withDailySummaryLock(lock: string, work: () => Promise<void>, staleMs = STALE_LOCK_MS): Promise<DailySummaryLockResult> {
  let acquired = await acquire(lock);
  if (!acquired) {
    const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
    if (age <= staleMs) return "already-running";
    await rm(lock, { recursive: true, force: true });
    acquired = await acquire(lock);
    if (!acquired) return "already-running";
  }
  try {
    await work();
    return "completed";
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
