/**
 * Elapsed Timer Extension
 *
 * Shows how long the current agent run has been going, displayed as
 * grayed-out text next to the "Working..." spinner during streaming.
 *
 * Example:
 *   ⠹ Working... 12s (esc to interrupt)
 *
 * Implementation notes:
 * - Starts a 1-second ticker on `agent_start` and clears it on `agent_end`.
 * - Uses `ctx.ui.setWorkingMessage(text)` to replace the loader message.
 *   The Loader already renders its message through `theme.fg("muted", ...)`,
 *   so the whole string is grayed automatically.
 * - Restores the default working message on end with `setWorkingMessage()`.
 * - Only active in modes that have a TUI (`ctx.hasUI`). In RPC/print modes
 *   `setWorkingMessage` is a no-op so the interval would just be wasted work.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TICK_INTERVAL_MS = 1000;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return `${hours}h ${remMinutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

export default function elapsedTimerExtension(pi: ExtensionAPI): void {
	let startedAt: number | null = null;
	let intervalId: ReturnType<typeof setInterval> | null = null;

	function stopTimer(): void {
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}
		startedAt = null;
	}

	function renderMessage(ctx: ExtensionContext, elapsedMs: number): void {
		// The Loader paints this whole string with theme.fg("muted", ...),
		// so everything ends up grayed out.
		ctx.ui.setWorkingMessage(`Working... ${formatElapsed(elapsedMs)} (esc to interrupt)`);
	}

	pi.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Defensive: if a previous run didn't clean up, reset first.
		stopTimer();

		startedAt = Date.now();
		renderMessage(ctx, 0);

		intervalId = setInterval(() => {
			if (startedAt === null) return;
			renderMessage(ctx, Date.now() - startedAt);
		}, TICK_INTERVAL_MS);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		if (ctx.hasUI) {
			// Passing undefined restores pi's default "Working..." message.
			ctx.ui.setWorkingMessage();
		}
	});

	// Safety net: if the session is torn down mid-run (e.g. /new, /resume,
	// process exit), make sure we don't leak the interval.
	pi.on("session_shutdown", async () => {
		stopTimer();
	});
}
