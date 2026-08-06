/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
	blocked?: boolean;
	blockReason?: string;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

function isLowQualityStepText(rawText: string, cleanedText: string): boolean {
	const raw = rawText.trim();
	const cleaned = cleanedText.trim();
	const lower = cleaned.toLowerCase();
	const words = cleaned.split(/\s+/).filter(Boolean);

	if (cleaned.length < 8 || words.length < 2) return true;
	if (/^#{1,6}\s+/.test(raw)) return true;
	if (/^[`/\-–—,.;:)\]]/.test(raw)) return true;
	if (/^(and|or|then|also|but|because)\b/i.test(cleaned)) return true;
	if (/^(tbd|todo|n\/a|none|unknown)$/i.test(cleaned)) return true;
	if (/^option\s+[a-z0-9]\b/i.test(cleaned)) return true;
	if (/^(alternative|alternatives|either|or)\b/i.test(cleaned)) return true;
	if (/^(goal|tasks?|tasks ordered|ordered tasks|relevant files|notes?|implementation|validation|testing|tests?|verification|summary|approach|phase\s+\d+)[:.]?$/i.test(cleaned)) return true;
	if (/^(validation|testing|verification)\s*[:.-]?$/i.test(cleaned)) return true;
	if (cleaned.endsWith(":") && words.length <= 5) return true;
	if (!/[a-z0-9]/i.test(cleaned)) return true;
	if (/^(if|when|unless)\b/i.test(cleaned) && words.length < 5) return true;
	if (/^(check|verify|test|validate)$/i.test(lower)) return true;

	return false;
}

function addTodoItem(items: TodoItem[], rawText: string): void {
	const text = rawText
		.trim()
		.replace(/\*{1,2}$/, "")
		.trim();

	if (!text || text.startsWith("`") || text.startsWith("/") || text.startsWith("-")) return;

	const cleaned = cleanStepText(text);
	if (!isLowQualityStepText(text, cleaned)) {
		items.push({ step: items.length + 1, text: cleaned, completed: false });
	}
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const lines = message.split(/\r?\n/);
	const tasksHeading = /^\s{0,3}#{1,6}\s+tasks\s*(?:\(ordered\))?\s*$/i;
	const anyHeading = /^\s{0,3}#{1,6}\s+/;
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+\S)\s*$/;

	let inTasksSection = false;
	for (const line of lines) {
		if (tasksHeading.test(line)) {
			inTasksSection = true;
			continue;
		}
		if (!inTasksSection) continue;
		if (anyHeading.test(line)) break;

		const match = numberedPattern.exec(line);
		if (!match) continue;
		addTodoItem(items, match[2]);
	}

	// Backward compatibility: legacy "Plan:" numbered lists.
	if (items.length === 0) {
		const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
		if (!headerMatch) return items;

		const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
		const legacyPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

		for (const match of planSection.matchAll(legacyPattern)) {
			addTodoItem(items, match[2]);
		}
	}

	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	let changed = 0;
	for (const step of extractDoneSteps(text)) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			item.blocked = false;
			item.blockReason = undefined;
			changed++;
		}
	}
	return changed;
}
