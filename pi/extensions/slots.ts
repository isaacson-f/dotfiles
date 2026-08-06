import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SYMBOLS = ["🍒", "🍋", "🍊", "🍇", "🔔", "⭐", "💎", "7️⃣"];
const SPIN_MS = 2200;
const CELEBRATION_MS = 3600;
const FRAME_MS = 90;
const WIN_RATE = 0.25;

type Phase = "spinning" | "win" | "lose";

type ThemeLike = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

function pickSymbol(): string {
	return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)] ?? "🍒";
}

function makeResult(isWin: boolean): string[] {
	if (isWin) {
		const symbol = pickSymbol();
		return [symbol, symbol, symbol];
	}

	let result = [pickSymbol(), pickSymbol(), pickSymbol()];
	while (result[0] === result[1] && result[1] === result[2]) {
		result = [pickSymbol(), pickSymbol(), pickSymbol()];
	}
	return result;
}

class SlotsComponent {
	private readonly theme: ThemeLike;
	private readonly tui: { requestRender: () => void };
	private readonly onClose: () => void;
	private readonly isWin: boolean;
	private readonly finalResult: string[];
	private phase: Phase = "spinning";
	private frame = 0;
	private reels: string[] = [pickSymbol(), pickSymbol(), pickSymbol()];
	private interval: ReturnType<typeof setInterval> | null = null;
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private cachedWidth = 0;
	private cachedFrame = -1;
	private cachedPhase: Phase | null = null;
	private cachedLines: string[] = [];

	constructor(tui: { requestRender: () => void }, theme: ThemeLike, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.isWin = Math.random() < WIN_RATE;
		this.finalResult = makeResult(this.isWin);
		this.start();
	}

	private start(): void {
		this.interval = setInterval(() => {
			this.frame++;
			if (this.phase === "spinning") {
				this.reels = [pickSymbol(), pickSymbol(), pickSymbol()];
			}
			this.invalidate();
			this.tui.requestRender();
		}, FRAME_MS);

		this.timeout = setTimeout(() => {
			this.reels = [...this.finalResult];
			this.phase = this.isWin ? "win" : "lose";
			this.invalidate();
			this.tui.requestRender();

			this.timeout = setTimeout(() => this.close(), this.isWin ? CELEBRATION_MS : 700);
		}, SPIN_MS);
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedFrame === this.frame && this.cachedPhase === this.phase) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const add = (line = "") => lines.push(truncateToWidth(line, width, ""));
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const success = (s: string) => this.theme.fg("success", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const bold = (s: string) => this.theme.bold(s);

		const contentWidth = Math.min(56, Math.max(28, width - 2));
		const border = "═".repeat(Math.max(0, contentWidth - 2));
		const innerWidth = Math.max(0, contentWidth - 4);
		const boxLine = (content: string) => {
			const padding = Math.max(0, innerWidth - visibleWidth(content));
			return accent("║ ") + content + " ".repeat(padding) + accent(" ║");
		};
		const centered = (content: string) => {
			const padding = Math.max(0, innerWidth - visibleWidth(content));
			const left = Math.floor(padding / 2);
			const right = padding - left;
			return accent("║ ") + " ".repeat(left) + content + " ".repeat(right) + accent(" ║");
		};

		add(accent(`╔${border}╗`));
		add(centered(bold(accent("PI SLOTS"))));
		add(boxLine(dim("spinning the reels")));
		add(accent(`╠${border}╣`));

		const reelText = this.reels.map((symbol) => ` ${symbol} `).join(accent("│"));
		add(centered(bold(reelText)));

		if (this.phase === "spinning") {
			const dots = ".".repeat((this.frame % 3) + 1);
			add(centered(warning(`spinning${dots}`)));
			add(centered(dim("good luck")));
		} else if (this.phase === "lose") {
			add(centered(dim("no win this time")));
			add(centered(dim("")));
		} else {
			const sparkle = this.frame % 2 === 0 ? "✨" : "🎉";
			add(centered(success(bold(`${sparkle} JACKPOT ${sparkle}`))));
			add(centered(success("MEGA CELEBRATION MODE")));
		}

		if (this.phase === "win") {
			add(accent(`╠${border}╣`));
			for (const line of this.renderCelebration(innerWidth)) {
				add(boxLine(line));
			}
		}

		add(accent(`╚${border}╝`));

		this.cachedWidth = width;
		this.cachedFrame = this.frame;
		this.cachedPhase = this.phase;
		this.cachedLines = lines;
		return lines;
	}

	private renderCelebration(width: number): string[] {
		const frames = ["🎊", "✨", "🎆", "💥", "🌟", "🎉"];
		return Array.from({ length: 7 }, (_, row) => {
			let line = "";
			for (let col = 0; col < width; col += 2) {
				const shouldDraw = (col + row + this.frame) % 5 === 0;
				line += shouldDraw ? frames[(col + row + this.frame) % frames.length] : "  ";
			}
			return truncateToWidth(line, width, "");
		});
	}

	dispose(): void {
		if (this.interval !== null) {
			clearInterval(this.interval);
			this.interval = null;
		}
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
	}

	private close(): void {
		this.dispose();
		this.onClose();
	}
}

const WIDGET_ID = "slots";

export default function slotsExtension(pi: ExtensionAPI): void {
	let activeCleanup: (() => void) | null = null;

	pi.registerCommand("slots", {
		description: "Spin a tiny slot machine",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/slots requires interactive mode", "error");
				return;
			}

			activeCleanup?.();

			let component: SlotsComponent | null = null;
			let closed = false;
			const cleanup = () => {
				if (closed) return;
				closed = true;
				component?.dispose();
				ctx.ui.setWidget(WIDGET_ID, undefined);
				if (activeCleanup === cleanup) {
					activeCleanup = null;
				}
			};

			activeCleanup = cleanup;
			ctx.ui.setWidget(
				WIDGET_ID,
				(tui, theme) => {
					component = new SlotsComponent(tui, theme, cleanup);
					return component;
				},
				{ placement: "belowEditor" },
			);
		},
	});

	pi.on("session_shutdown", async () => {
		activeCleanup?.();
	});
}
