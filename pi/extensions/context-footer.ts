import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function colorForPercent(percent: number | null): "muted" | "success" | "warning" | "error" {
	if (percent === null) return "muted";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function renderContextBar(
	theme: { fg: (color: string, text: string) => string },
	percent: number | null,
	options: { dimmed?: boolean; slots?: number } = {},
): string {
	const { dimmed = false, slots = 12 } = options;
	if (percent === null) {
		return theme.fg("muted", `[${"?".repeat(slots)}]`);
	}

	const filled = Math.max(0, Math.min(slots, Math.round((percent / 100) * slots)));
	if (dimmed) {
		return theme.fg("dim", `[${"█".repeat(filled)}${"░".repeat(slots - filled)}]`);
	}

	return (
		"[" +
		theme.fg(colorForPercent(percent), "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(slots - filled)) +
		"]"
	);
}

export default function (pi: ExtensionAPI) {
	let lastKnownPercent: number | null = null;
	let staleAfterCompaction = false;
	let requestRender: (() => void) | null = null;

	pi.on("session_start", async (_event, ctx) => {
		lastKnownPercent = null;
		staleAfterCompaction = false;
		requestRender = null;
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					requestRender = null;
					unsubscribe();
				},
				invalidate() {},
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					const livePercent = usage?.percent ?? null;
					if (livePercent !== null) {
						lastKnownPercent = livePercent;
						staleAfterCompaction = false;
					}

					const isUsingCachedPercent = livePercent === null && staleAfterCompaction && lastKnownPercent !== null;
					const percent = livePercent ?? (isUsingCachedPercent ? lastKnownPercent : null);
					const percentLabel = percent === null ? "?" : `${Math.round(percent)}%`;

					const left =
						theme.fg("dim", "ctx ") +
						renderContextBar(theme, percent, { dimmed: isUsingCachedPercent }) +
						" " +
						theme.fg(isUsingCachedPercent ? "dim" : colorForPercent(percent), percentLabel);

					const model = ctx.model
						? footerData.getAvailableProviderCount() > 1
							? `${ctx.model.provider}/${ctx.model.id}`
							: ctx.model.id
						: "no-model";

					const branch = footerData.getGitBranch() ?? "no-git";
					const right = theme.fg("dim", `${model} • git:${branch}`);

					const totalWidth = visibleWidth(left) + 2 + visibleWidth(right);
					if (totalWidth <= width) {
						const gap = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
						return [left + gap + right];
					}

					return [truncateToWidth(left, width), truncateToWidth(right, width)];
				},
			};
		});
	});

	pi.on("session_compact", async () => {
		staleAfterCompaction = true;
		requestRender?.();
	});
}
