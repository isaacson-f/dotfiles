import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = resolve(homedir(), ".pi", "agent");
const AUTH_PATH = resolve(AGENT_DIR, "auth.json");
const PATH_TOOLS = new Set(["read", "grep", "edit", "write"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

function canonicalizePath(rawPath: string, cwd: string): string {
	const expanded = rawPath === "~" || rawPath.startsWith(`~${sep}`)
		? resolve(homedir(), rawPath.slice(2))
		: isAbsolute(rawPath)
			? resolve(rawPath)
			: resolve(cwd, rawPath);

	let candidate = expanded;
	const suffix: string[] = [];
	while (!existsSync(candidate)) {
		const parent = dirname(candidate);
		if (parent === candidate) return expanded;
		suffix.unshift(candidate.slice(parent.length + 1));
		candidate = parent;
	}

	try {
		return resolve(realpathSync(candidate), ...suffix);
	} catch {
		return expanded;
	}
}

function isAuthPath(rawPath: string, cwd: string): boolean {
	return canonicalizePath(rawPath, cwd) === AUTH_PATH;
}

function isNodeModulesPath(rawPath: string, cwd: string): boolean {
	return canonicalizePath(rawPath, cwd).split(sep).includes("node_modules");
}

function inputPath(input: Record<string, unknown>): string | undefined {
	return typeof input.path === "string" ? input.path : undefined;
}

function referencesPiAuth(command: string): boolean {
	const normalized = command.replaceAll("\\", "/");
	return normalized.includes(AUTH_PATH.replaceAll("\\", "/"))
		|| /(?:~|\$HOME|\$\{HOME\})\/\.pi\/agent\/auth\.json\b/.test(normalized);
}

function directlyMutatesNodeModules(command: string): boolean {
	if (!/(?:^|[/'"\s])node_modules(?:[/'"\s]|$)/.test(command)) return false;
	return /(?:\bsed\s+-[^\n]*i\b|\bperl\s+-[^\n]*i\b|\b(?:rm|mv|cp|install|truncate|chmod|chown)\b|\btee\b|>>?)/i.test(command);
}

function destructiveReason(command: string): string | undefined {
	const rules: Array<[RegExp, string]> = [
		[/\brm\b[^\n;&|]*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive[^\n;&|]*--force|--force[^\n;&|]*--recursive)/i, "recursive forced deletion"],
		[/\bgit\s+reset\s+--hard\b/i, "hard Git reset"],
		[/\bgit\s+clean\s+-[a-z]*f/i, "forced Git clean"],
		[/\b(?:terraform|tofu|pulumi)\s+destroy\b/i, "infrastructure destruction"],
		[/\bkubectl\s+delete\b/i, "Kubernetes deletion"],
		[/\bdocker\s+(?:system|volume|image|container)\s+prune\b/i, "Docker prune"],
		[/\b(?:mkfs(?:\.\w+)?|diskutil\s+erase\w*|dd\s+if=)\b/i, "disk/filesystem operation"],
		[/\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i, "destructive database operation"],
		[/\b(?:alembic\s+downgrade|prisma\s+migrate\s+reset)\b/i, "destructive database migration"],
		[/\bsudo\b/i, "privileged command"],
	];
	return rules.find(([pattern]) => pattern.test(command))?.[1];
}

export default function localSafetyPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (PATH_TOOLS.has(event.toolName)) {
			const path = inputPath(input);
			if (path && isAuthPath(path, ctx.cwd)) {
				return { block: true, reason: "Pi auth.json is protected from tool access." };
			}
			if (path && WRITE_TOOLS.has(event.toolName) && isNodeModulesPath(path, ctx.cwd)) {
				return { block: true, reason: "Direct edits under node_modules are prohibited; use the package manager or a user extension." };
			}
		}

		if (event.toolName !== "bash") return undefined;
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;

		if (/\bpi-subagents\s+(?:--version|-v|version)\b/.test(command)) {
			return {
				block: true,
				reason: "pi-subagents is an installer, not a version-reporting CLI. Read its installed package.json instead.",
			};
		}
		if (referencesPiAuth(command)) {
			return { block: true, reason: "Shell access to Pi auth.json is prohibited." };
		}
		if (directlyMutatesNodeModules(command)) {
			return { block: true, reason: "Direct shell mutation under node_modules is prohibited; use the package manager or a user extension." };
		}

		const reason = destructiveReason(command);
		if (!reason) return undefined;
		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked ${reason}: no interactive confirmation UI is available.` };
		}

		const allowed = await ctx.ui.confirm(
			`Confirm ${reason}`,
			`Allow this command?\n\n${command}`,
		);
		return allowed ? undefined : { block: true, reason: `User declined ${reason}.` };
	});
}
