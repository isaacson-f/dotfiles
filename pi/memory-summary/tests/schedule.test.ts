import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasTransientFailure, readCompletedDate, writeCompletedDate } from "../schedule.ts";
import { withDailySummaryLock } from "../lock.ts";

test("environment failures require a retry; content failures and clean runs do not", () => {
  assert.equal(hasTransientFailure(["global: cleanup request_timeout; source preserved"]), true);
  assert.equal(hasTransientFailure(["repository:x: index empty_provider_response; prior index preserved"]), true);
  assert.equal(hasTransientFailure(["user: index provider_request_failed; prior index preserved"]), true);
  assert.equal(hasTransientFailure(["user: index invalid_json; prior index preserved", "global: unchanged"]), false);
  assert.equal(hasTransientFailure(["user: indexed", "global: cleanup unchanged"]), false);
});

test("the completion date round-trips and a missing file reads as not completed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-schedule-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, ".daily-summary-completed");
  assert.equal(await readCompletedDate(path), undefined);
  await writeCompletedDate(path, "2026-11-10");
  assert.equal(await readCompletedDate(path), "2026-11-10");
  assert.deepEqual(await readdir(dir), [".daily-summary-completed"], "no temporary file is left behind");
});

test("a live lock blocks a second run, but a lock left by a killed process is reclaimed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, ".daily-summary.lock");
  await mkdir(lock);
  let ran = false;
  assert.equal(await withDailySummaryLock(lock, async () => { ran = true; }), "already-running");
  assert.equal(ran, false);
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(lock, threeHoursAgo, threeHoursAgo);
  assert.equal(await withDailySummaryLock(lock, async () => { ran = true; }), "completed");
  assert.equal(ran, true);
  assert.deepEqual(await readdir(dir), [], "the reclaimed lock is released after the run");
});
