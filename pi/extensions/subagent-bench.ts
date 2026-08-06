import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type RunRecord = {
	key: string;
	runId: string;
	agent: string;
	model: string;
	status: string;
	acceptance: string;
	timestamp: number;
	durationMs: number;
	toolCount: number;
	turns: number;
	cost: number;
	fallback: boolean;
};

type Aggregate = {
	agent: string;
	runs: RunRecord[];
};

const MAX_SCANNED_FILES = 10_000;
const MAX_RECENT_ROWS = 12;

function parseJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown, fallback = "unknown"): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function findFiles(root: string, suffix: string, maxDepth: number): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > maxDepth || files.length >= MAX_SCANNED_FILES) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_SCANNED_FILES) return;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
		}
	};
	visit(root, 0);
	return files;
}

function recordFromMetadata(path: string): RunRecord | undefined {
	const data = asRecord(parseJson(path));
	if (!data) return undefined;
	const usage = asRecord(data.usage) ?? {};
	const acceptance = asRecord(data.acceptance) ?? {};
	const attemptedModels = Array.isArray(data.attemptedModels) ? data.attemptedModels : [];
	const runId = stringValue(data.runId);
	const agent = stringValue(data.agent);
	const timestamp = numberValue(data.timestamp) || statSync(path).mtimeMs;
	return {
		key: `meta:${runId}:${agent}:${timestamp}`,
		runId,
		agent,
		model: stringValue(data.model),
		status: numberValue(data.exitCode) === 0 ? "complete" : "failed",
		acceptance: stringValue(acceptance.status, "unknown"),
		timestamp,
		durationMs: numberValue(data.durationMs),
		toolCount: numberValue(data.toolCount),
		turns: numberValue(usage.turns),
		cost: numberValue(usage.cost),
		fallback: attemptedModels.length > 1,
	};
}

function recordsFromAsyncStatus(path: string): RunRecord[] {
	const data = asRecord(parseJson(path));
	if (!data || !Array.isArray(data.steps)) return [];
	const runId = stringValue(data.id ?? data.runId, path.split("/").at(-2) ?? "unknown");
	return data.steps.flatMap((rawStep, index) => {
		const step = asRecord(rawStep);
		if (!step) return [];
		const acceptance = asRecord(step.acceptance) ?? {};
		const usage = asRecord(step.usage ?? step.totalChildUsage) ?? {};
		const attemptedModels = Array.isArray(step.attemptedModels) ? step.attemptedModels : [];
		const timestamp = numberValue(step.completedAt ?? step.endedAt ?? step.startedAt ?? data.updatedAt)
			|| statSync(path).mtimeMs;
		const agent = stringValue(step.agent, `step-${index + 1}`);
		return [{
			key: `async:${runId}:${index}:${timestamp}`,
			runId,
			agent,
			model: stringValue(step.model),
			status: stringValue(step.status),
			acceptance: stringValue(acceptance.status, "unknown"),
			timestamp,
			durationMs: numberValue(step.durationMs),
			toolCount: numberValue(step.toolCount),
			turns: numberValue(step.turnCount ?? usage.turns),
			cost: numberValue(usage.cost),
			fallback: attemptedModels.length > 1,
		} satisfies RunRecord];
	});
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function average(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatDuration(ms: number): string {
	if (!ms) return "-";
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

function formatAge(timestamp: number): string {
	const delta = Math.max(0, Date.now() - timestamp);
	if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.round(delta / 60_000))}m`;
	if (delta < 24 * 60 * 60 * 1000) return `${Math.round(delta / 3_600_000)}h`;
	return `${Math.round(delta / 86_400_000)}d`;
}

function pad(value: string, width: number): string {
	return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function collectRecords(cwd: string, days: number): RunRecord[] {
	const sessionRoot = join(homedir(), ".pi", "agent", "sessions");
	const projectArtifacts = join(cwd, ".pi-subagents", "artifacts");
	const asyncRoot = join(tmpdir(), `pi-subagents-uid-${userInfo().uid}`, "async-subagent-runs");
	const cutoff = Date.now() - days * 86_400_000;
	const records: RunRecord[] = [];

	for (const root of [sessionRoot, projectArtifacts]) {
		for (const path of findFiles(root, "_meta.json", root === sessionRoot ? 5 : 2)) {
			const record = recordFromMetadata(path);
			if (record && record.timestamp >= cutoff) records.push(record);
		}
	}
	for (const path of findFiles(asyncRoot, "status.json", 2)) {
		records.push(...recordsFromAsyncStatus(path).filter((record) => record.timestamp >= cutoff));
	}

	const unique = new Map<string, RunRecord>();
	for (const record of records) unique.set(record.key, record);
	return [...unique.values()].sort((left, right) => right.timestamp - left.timestamp);
}

function buildReport(records: RunRecord[], days: number): string {
	const groups = new Map<string, Aggregate>();
	for (const record of records) {
		const group = groups.get(record.agent) ?? { agent: record.agent, runs: [] };
		group.runs.push(record);
		groups.set(record.agent, group);
	}

	const rejected = records.filter((record) => record.acceptance === "rejected").length;
	const failed = records.filter((record) => record.status === "failed").length;
	const fallbacks = records.filter((record) => record.fallback).length;
	const lines = [
		`Subagent benchmark — last ${days} day(s)`,
		`Runs: ${records.length}  Failed: ${failed}  Rejected: ${rejected}  Fallbacks: ${fallbacks}  Cost: $${records.reduce((sum, run) => sum + run.cost, 0).toFixed(3)}`,
		"",
		`${pad("Agent", 17)} ${pad("Runs", 5)} ${pad("Median", 8)} ${pad("Tools", 7)} ${pad("Turns", 7)} ${pad("Reject", 6)}`,
		"-".repeat(58),
	];

	for (const group of [...groups.values()].sort((left, right) => left.agent.localeCompare(right.agent))) {
		lines.push(
			`${pad(group.agent, 17)} ${pad(String(group.runs.length), 5)} ${pad(formatDuration(median(group.runs.map((run) => run.durationMs))), 8)} ${pad(average(group.runs.map((run) => run.toolCount)).toFixed(1), 7)} ${pad(average(group.runs.map((run) => run.turns)).toFixed(1), 7)} ${pad(String(group.runs.filter((run) => run.acceptance === "rejected").length), 6)}`,
		);
	}

	lines.push("", "Recent runs");
	for (const run of records.slice(0, MAX_RECENT_ROWS)) {
		lines.push(
			`${pad(formatAge(run.timestamp), 4)} ${pad(run.agent, 16)} ${pad(formatDuration(run.durationMs), 7)} ${pad(run.status, 9)} ${pad(run.acceptance, 12)} ${run.model}`,
		);
	}
	if (records.length === 0) lines.push("No recent subagent metadata or async status files found.");
	return lines.join("\n");
}

function showReport(ctx: ExtensionCommandContext, report: string): void {
	if (ctx.hasUI) {
		ctx.ui.setWidget("subagent-bench", report.split("\n"));
		ctx.ui.notify("Subagent benchmark shown below the editor. Use /subagent-bench clear to hide it.", "info");
	} else {
		console.log(report);
	}
}

export default function subagentBenchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-bench", {
		description: "Summarize recent local subagent latency, tools, turns, acceptance, fallbacks, and cost",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				if (ctx.hasUI) ctx.ui.setWidget("subagent-bench", undefined);
				return;
			}
			const parsedDays = Number(args.trim() || "14");
			const days = Number.isFinite(parsedDays) ? Math.min(90, Math.max(1, Math.floor(parsedDays))) : 14;
			showReport(ctx, buildReport(collectRecords(ctx.cwd, days), days));
		},
	});
}
