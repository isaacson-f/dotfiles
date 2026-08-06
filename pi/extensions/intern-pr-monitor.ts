import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const DONE_WHEN = ["prs_exist", "checks_complete", "checks_successful", "draft_or_update"] as const;

const PollParamsSchema = Type.Object({
	branches: Type.Optional(
		Type.Array(Type.String(), {
			description: "Git branch names to watch for PRs, e.g. frank/my-intern-branch.",
		}),
	),
	session_ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "Intern session IDs or prefixes. The extension resolves each session to its current branch via `intern status`.",
		}),
	),
	repo: Type.Optional(
		Type.String({
			description: "GitHub repo in owner/name form. Defaults to the current checkout's GitHub repo.",
		}),
	),
	base: Type.Optional(
		Type.String({
			description: "Optional base branch filter, e.g. feat/playbook-preview-response.",
		}),
	),
	done_when: Type.Optional(
		Type.String({
			description:
				"Stop condition: prs_exist, checks_complete, checks_successful, or draft_or_update. draft_or_update means: if the remote branch is absent at poll start, wait for a draft PR; if it exists, wait for a new branch head SHA. Defaults to checks_complete.",
		}),
	),
	poll_interval_seconds: Type.Optional(
		Type.Number({
			description: "Seconds between polls. Defaults to 60. Minimum 5.",
		}),
	),
	timeout_seconds: Type.Optional(
		Type.Number({
			description: "Maximum seconds to poll before returning. Defaults to 900. Minimum 10.",
		}),
	),
});

type PollParams = Static<typeof PollParamsSchema>;
type DoneWhen = (typeof DONE_WHEN)[number];

type ExecResult = {
	stdout?: string;
	stderr?: string;
	code?: number;
	killed?: boolean;
};

type InternStatus = {
	session_id?: string;
	status?: string;
	waiting_for_input?: boolean;
	branch?: string;
	preview?: string;
};

type StatusCheck = {
	name?: string;
	status?: string;
	conclusion?: string | null;
};

type PullRequest = {
	number: number;
	title: string;
	headRefName: string;
	baseRefName: string;
	url: string;
	isDraft: boolean;
	updatedAt: string;
	statusCheckRollup?: StatusCheck[];
	reviewDecision?: string | null;
	mergeStateStatus?: string | null;
};

type BranchPrStatus = {
	branch: string;
	sourceSessionId?: string;
	intern?: InternStatus;
	pr?: PullRequest;
	missing: boolean;
	pendingChecks: string[];
	failingChecks: string[];
	successfulChecks: string[];
	skippedChecks: string[];
	error?: string;
	branchHeadSha?: string | null;
	baselineHeadSha?: string | null;
	updatedSinceBaseline?: boolean;
	draftCreatedSinceBaseline?: boolean;
	waitingFor?: string;
};

type BranchBaselineHeads = Record<string, string | null>;

type PollSnapshot = {
	repo: string;
	base?: string;
	doneWhen: DoneWhen;
	statuses: BranchPrStatus[];
	done: boolean;
	missingBranches: string[];
	pendingBranches: string[];
	failingBranches: string[];
	checkedAt: string;
	baselineHeads?: BranchBaselineHeads;
};

type Watcher = {
	id: string;
	params: Required<PollParams> & { base?: string; repo: string };
	ctx: { cwd: string; hasUI: boolean; ui?: unknown };
	lastFingerprint?: string;
	baselineHeads?: BranchBaselineHeads;
	stopped: boolean;
	timer?: ReturnType<typeof setInterval>;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function clampNumber(value: number | undefined, fallback: number, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.floor(value));
}

function normalizeDoneWhen(value: unknown): DoneWhen {
	return DONE_WHEN.includes(value as DoneWhen) ? (value as DoneWhen) : "checks_complete";
}

function normalizeParams(params: PollParams): PollParams {
	return {
		...params,
		branches: [...new Set(params.branches ?? [])].filter(Boolean),
		session_ids: [...new Set(params.session_ids ?? [])].filter(Boolean),
		done_when: normalizeDoneWhen(params.done_when),
		poll_interval_seconds: clampNumber(params.poll_interval_seconds, 60, 5),
		timeout_seconds: clampNumber(params.timeout_seconds, 900, 10),
	};
}

function parseJson<T>(text: string, label: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function execJson<T>(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; label: string },
): Promise<T> {
	const result = (await pi.exec(command, args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: 30_000,
	})) as ExecResult;

	if (result.code !== 0) {
		throw new Error(
			`${options.label} failed (${result.code ?? "unknown"}): ${(result.stderr ?? result.stdout ?? "").trim()}`,
		);
	}
	return parseJson<T>(result.stdout ?? "", options.label);
}

async function execText(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; label: string },
): Promise<string> {
	const result = (await pi.exec(command, args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: 30_000,
	})) as ExecResult;

	if (result.code !== 0) {
		throw new Error(
			`${options.label} failed (${result.code ?? "unknown"}): ${(result.stderr ?? result.stdout ?? "").trim()}`,
		);
	}
	return (result.stdout ?? "").trim();
}

async function resolveRepo(pi: ExtensionAPI, repo: string | undefined, cwd: string, signal?: AbortSignal): Promise<string> {
	if (repo?.trim()) return repo.trim();
	const data = await execJson<{ nameWithOwner: string }>(pi, "gh", ["repo", "view", "--json", "nameWithOwner"], {
		cwd,
		signal,
		label: "gh repo view",
	});
	return data.nameWithOwner;
}

async function resolveInternSession(
	pi: ExtensionAPI,
	sessionId: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<InternStatus> {
	return execJson<InternStatus>(pi, "intern", ["status", sessionId, "--json"], {
		cwd,
		signal,
		label: `intern status ${sessionId}`,
	});
}

async function listPrsForBranch(
	pi: ExtensionAPI,
	args: { repo: string; branch: string; base?: string; cwd: string; signal?: AbortSignal },
): Promise<PullRequest[]> {
	const prs = await execJson<PullRequest[]>(
		pi,
		"gh",
		[
			"pr",
			"list",
			"--repo",
			args.repo,
			"--state",
			"open",
			"--head",
			args.branch,
			"--limit",
			"20",
			"--json",
			"number,title,headRefName,baseRefName,url,isDraft,updatedAt,statusCheckRollup,reviewDecision,mergeStateStatus",
		],
		{ cwd: args.cwd, signal: args.signal, label: `gh pr list ${args.branch}` },
	);
	return args.base ? prs.filter((pr) => pr.baseRefName === args.base) : prs;
}

async function getRemoteBranchSha(
	pi: ExtensionAPI,
	args: { branch: string; cwd: string; signal?: AbortSignal },
): Promise<string | null> {
	const output = await execText(pi, "git", ["ls-remote", "origin", `refs/heads/${args.branch}`], {
		cwd: args.cwd,
		signal: args.signal,
		label: `git ls-remote ${args.branch}`,
	});
	const sha = output.split(/\s+/)[0]?.trim();
	return sha ? sha : null;
}

function classifyChecks(pr?: PullRequest): Pick<
	BranchPrStatus,
	"pendingChecks" | "failingChecks" | "successfulChecks" | "skippedChecks"
> {
	const pendingChecks: string[] = [];
	const failingChecks: string[] = [];
	const successfulChecks: string[] = [];
	const skippedChecks: string[] = [];

	for (const check of pr?.statusCheckRollup ?? []) {
		const name = check.name ?? "unnamed-check";
		if (check.status && check.status !== "COMPLETED") {
			pendingChecks.push(name);
			continue;
		}

		const conclusion = check.conclusion ?? "";
		if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(conclusion)) {
			failingChecks.push(name);
		} else if (conclusion === "SUCCESS") {
			successfulChecks.push(name);
		} else if (["SKIPPED", "NEUTRAL"].includes(conclusion)) {
			skippedChecks.push(name);
		}
	}

	return { pendingChecks, failingChecks, successfulChecks, skippedChecks };
}

function isSnapshotDone(snapshot: Omit<PollSnapshot, "done">, doneWhen: DoneWhen): boolean {
	if (snapshot.statuses.length === 0) return false;
	if (doneWhen === "draft_or_update") {
		return snapshot.statuses.every((status) => status.updatedSinceBaseline || status.draftCreatedSinceBaseline);
	}
	if (snapshot.missingBranches.length > 0) return false;
	if (doneWhen === "prs_exist") return true;
	if (snapshot.pendingBranches.length > 0) return false;
	if (doneWhen === "checks_complete") return true;
	return snapshot.failingBranches.length === 0;
}

async function collectSnapshot(
	pi: ExtensionAPI,
	params: PollParams,
	cwd: string,
	signal?: AbortSignal,
	baselineHeads?: BranchBaselineHeads,
): Promise<PollSnapshot> {
	const normalized = normalizeParams(params);
	const repo = await resolveRepo(pi, normalized.repo, cwd, signal);
	const branches = new Map<string, { branch: string; sourceSessionId?: string; intern?: InternStatus }>();

	for (const branch of normalized.branches ?? []) {
		branches.set(branch, { branch });
	}

	for (const sessionId of normalized.session_ids ?? []) {
		try {
			const intern = await resolveInternSession(pi, sessionId, cwd, signal);
			if (intern.branch) {
				branches.set(intern.branch, {
					branch: intern.branch,
					sourceSessionId: sessionId,
					intern,
				});
			} else {
				branches.set(`intern:${sessionId}`, {
					branch: `intern:${sessionId}`,
					sourceSessionId: sessionId,
					intern,
				});
			}
		} catch (error) {
			branches.set(`intern:${sessionId}`, {
				branch: `intern:${sessionId}`,
				sourceSessionId: sessionId,
				intern: { session_id: sessionId },
			});
		}
	}

	const statuses: BranchPrStatus[] = [];
	for (const entry of branches.values()) {
		if (entry.branch.startsWith("intern:")) {
			statuses.push({
				...entry,
				missing: true,
				pendingChecks: [],
				failingChecks: [],
				successfulChecks: [],
				skippedChecks: [],
				branchHeadSha: null,
				baselineHeadSha: null,
				waitingFor: "intern branch resolution",
				error: `Could not resolve branch for intern session ${entry.sourceSessionId}`,
			});
			continue;
		}

		try {
			const branchHeadSha = await getRemoteBranchSha(pi, { branch: entry.branch, cwd, signal });
			const prs = await listPrsForBranch(pi, {
				repo,
				branch: entry.branch,
				base: normalized.base,
				cwd,
				signal,
			});
			const pr = prs[0];
			const baselineHeadSha = baselineHeads?.[entry.branch];
			const baselineKnown = Object.prototype.hasOwnProperty.call(baselineHeads ?? {}, entry.branch);
			const updatedSinceBaseline =
				baselineKnown && baselineHeadSha !== null && branchHeadSha !== null && branchHeadSha !== baselineHeadSha;
			const draftCreatedSinceBaseline =
				baselineKnown && baselineHeadSha === null && pr?.isDraft === true;
			const waitingFor = baselineKnown
				? baselineHeadSha === null
					? "draft PR creation"
					: "branch head update"
				: undefined;
			statuses.push({
				...entry,
				pr,
				missing: !pr,
				branchHeadSha,
				baselineHeadSha: baselineKnown ? baselineHeadSha : undefined,
				updatedSinceBaseline,
				draftCreatedSinceBaseline,
				waitingFor,
				...classifyChecks(pr),
			});
		} catch (error) {
			statuses.push({
				...entry,
				missing: true,
				pendingChecks: [],
				failingChecks: [],
				successfulChecks: [],
				skippedChecks: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const missingBranches = statuses.filter((status) => status.missing).map((status) => status.branch);
	const pendingBranches = statuses
		.filter((status) => status.pr && status.pendingChecks.length > 0)
		.map((status) => status.branch);
	const failingBranches = statuses
		.filter((status) => status.pr && status.failingChecks.length > 0)
		.map((status) => status.branch);
	const doneWhen = normalized.done_when as DoneWhen;
	const partial = {
		repo,
		base: normalized.base,
		doneWhen,
		statuses,
		missingBranches,
		pendingBranches,
		failingBranches,
		checkedAt: new Date().toISOString(),
	};

	return { ...partial, baselineHeads, done: isSnapshotDone(partial, doneWhen) };
}

function formatCheckList(label: string, checks: string[]): string {
	if (checks.length === 0) return "";
	return ` ${label}: ${checks.slice(0, 5).join(", ")}${checks.length > 5 ? ` +${checks.length - 5}` : ""}`;
}

function formatSnapshot(snapshot: PollSnapshot): string {
	const lines = [
		`Intern PR monitor — ${snapshot.done ? "DONE" : "waiting"}`,
		`Repo: ${snapshot.repo}${snapshot.base ? `, base: ${snapshot.base}` : ""}, done_when: ${snapshot.doneWhen}`,
		`Checked: ${snapshot.checkedAt}`,
		"",
	];

	for (const status of snapshot.statuses) {
		const session = status.sourceSessionId ? ` [intern ${status.sourceSessionId.slice(0, 8)}]` : "";
		if (status.error) {
			lines.push(`✗ ${status.branch}${session}: ${status.error}`);
			continue;
		}
		if (!status.pr) {
			const branchState =
				snapshot.doneWhen === "draft_or_update"
					? ` [${status.waitingFor ?? "baseline"}: ${status.baselineHeadSha?.slice(0, 12) ?? "absent"} -> ${status.branchHeadSha?.slice(0, 12) ?? "absent"}]`
					: "";
			lines.push(`• ${status.branch}${session}: no open PR${snapshot.base ? ` targeting ${snapshot.base}` : ""}${branchState}`);
			continue;
		}
		const pr = status.pr;
		const draft = pr.isDraft ? " DRAFT" : " READY";
		const checkSummary =
			formatCheckList("pending", status.pendingChecks) + formatCheckList("failing", status.failingChecks);
		const branchState =
			snapshot.doneWhen === "draft_or_update"
				? ` [${status.waitingFor ?? "baseline"}: ${status.baselineHeadSha?.slice(0, 12) ?? "absent"} -> ${status.branchHeadSha?.slice(0, 12) ?? "absent"}]`
				: "";
		lines.push(
			`• ${status.branch}${session}: #${pr.number}${draft} ${pr.title} (${pr.headRefName}->${pr.baseRefName})${branchState}${checkSummary}`,
		);
		lines.push(`  ${pr.url}`);
	}

	if (snapshot.missingBranches.length > 0) lines.push(`\nMissing PRs: ${snapshot.missingBranches.join(", ")}`);
	if (snapshot.pendingBranches.length > 0) lines.push(`Pending checks: ${snapshot.pendingBranches.join(", ")}`);
	if (snapshot.failingBranches.length > 0) lines.push(`Failing checks: ${snapshot.failingBranches.join(", ")}`);
	return lines.join("\n");
}

function fingerprint(snapshot: PollSnapshot): string {
	return JSON.stringify(
		snapshot.statuses.map((status) => ({
			branch: status.branch,
			pr: status.pr?.number,
			draft: status.pr?.isDraft,
			branchHeadSha: status.branchHeadSha,
			baselineHeadSha: status.baselineHeadSha,
			updatedSinceBaseline: status.updatedSinceBaseline,
			draftCreatedSinceBaseline: status.draftCreatedSinceBaseline,
			pending: status.pendingChecks,
			failing: status.failingChecks,
			error: status.error,
		})),
	);
}

function baselineHeadsFromSnapshot(snapshot: PollSnapshot): BranchBaselineHeads {
	return Object.fromEntries(snapshot.statuses.map((status) => [status.branch, status.branchHeadSha ?? null]));
}

async function pollUntilDone(
	pi: ExtensionAPI,
	params: PollParams,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
): Promise<{ snapshot: PollSnapshot; timedOut: boolean; attempts: number }> {
	const normalized = normalizeParams(params);
	const timeoutMs = (normalized.timeout_seconds ?? 900) * 1000;
	const intervalMs = (normalized.poll_interval_seconds ?? 60) * 1000;
	const deadline = Date.now() + timeoutMs;
	let attempts = 0;
	let lastSnapshot: PollSnapshot | undefined;
	let baselineHeads: BranchBaselineHeads | undefined;

	if (normalized.done_when === "draft_or_update") {
		const baselineSnapshot = await collectSnapshot(pi, normalized, ctx.cwd, signal);
		baselineHeads = baselineHeadsFromSnapshot(baselineSnapshot);
		lastSnapshot = await collectSnapshot(pi, normalized, ctx.cwd, signal, baselineHeads);
		onUpdate?.({ content: [{ type: "text", text: formatSnapshot(lastSnapshot) }], details: lastSnapshot });
		if (lastSnapshot.done) return { snapshot: lastSnapshot, timedOut: false, attempts };
	}

	while (Date.now() <= deadline) {
		attempts++;
		lastSnapshot = await collectSnapshot(pi, normalized, ctx.cwd, signal, baselineHeads);
		onUpdate?.({ content: [{ type: "text", text: formatSnapshot(lastSnapshot) }], details: lastSnapshot });
		if (lastSnapshot.done) return { snapshot: lastSnapshot, timedOut: false, attempts };
		await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
	}

	if (!lastSnapshot) lastSnapshot = await collectSnapshot(pi, normalized, ctx.cwd, signal, baselineHeads);
	return { snapshot: lastSnapshot, timedOut: true, attempts };
}

function parseArgs(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	return tokens;
}

function tokenLooksLikeInternSession(token: string): boolean {
	return /^[0-9a-f]{8}(?:-[0-9a-f-]{4,})?$/i.test(token);
}

function parseCommandParams(args: string): { action: "start" | "stop" | "list" | "once"; params: PollParams; stopId?: string } {
	const tokens = parseArgs(args);
	const actionToken = tokens[0];
	const action = actionToken === "start" || actionToken === "stop" || actionToken === "list" || actionToken === "once" ? actionToken : "once";
	const rest = action === "once" && actionToken !== "once" ? tokens : tokens.slice(1);
	const params: PollParams = { branches: [], session_ids: [] };
	let stopId: string | undefined;

	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		const next = rest[i + 1];
		if (token === "--repo" && next) {
			params.repo = next;
			i++;
		} else if (token === "--base" && next) {
			params.base = next;
			i++;
		} else if (token === "--interval" && next) {
			params.poll_interval_seconds = Number(next);
			i++;
		} else if (token === "--timeout" && next) {
			params.timeout_seconds = Number(next);
			i++;
		} else if (token === "--done" && next && DONE_WHEN.includes(next as DoneWhen)) {
			params.done_when = next as DoneWhen;
			i++;
		} else if (action === "stop") {
			stopId = token;
		} else if (tokenLooksLikeInternSession(token)) {
			params.session_ids?.push(token);
		} else if (token) {
			params.branches?.push(token);
		}
	}

	return { action, params: normalizeParams(params), stopId };
}

export default function internPrMonitorExtension(pi: ExtensionAPI) {
	const watchers = new Map<string, Watcher>();

	function stopWatcher(id: string): boolean {
		const watcher = watchers.get(id);
		if (!watcher) return false;
		watcher.stopped = true;
		if (watcher.timer) clearInterval(watcher.timer);
		watchers.delete(id);
		return true;
	}

	async function runWatcherTick(watcher: Watcher) {
		if (watcher.stopped) return;
		try {
			if (watcher.params.done_when === "draft_or_update" && !watcher.baselineHeads) {
				const baselineSnapshot = await collectSnapshot(pi, watcher.params, watcher.ctx.cwd);
				watcher.baselineHeads = baselineHeadsFromSnapshot(baselineSnapshot);
			}
			const snapshot = await collectSnapshot(pi, watcher.params, watcher.ctx.cwd, undefined, watcher.baselineHeads);
			const currentFingerprint = fingerprint(snapshot);
			const text = formatSnapshot(snapshot);
			if (watcher.lastFingerprint !== currentFingerprint || snapshot.done) {
				watcher.lastFingerprint = currentFingerprint;
				pi.sendMessage(
					{
						customType: "intern-pr-monitor",
						content: text,
						display: true,
						details: snapshot,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			}
			if (snapshot.done) stopWatcher(watcher.id);
		} catch (error) {
			pi.sendMessage(
				{
					customType: "intern-pr-monitor",
					content: `Intern PR monitor ${watcher.id} failed: ${error instanceof Error ? error.message : String(error)}`,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			stopWatcher(watcher.id);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("intern-pr-monitor", "intern PR monitor ready");
	});

	pi.on("session_shutdown", () => {
		for (const id of [...watchers.keys()]) stopWatcher(id);
	});

	pi.registerTool({
		name: "intern_pr_poll",
		label: "Intern PR Poll",
		description:
			"Poll GitHub PRs for intern-created branches or intern session IDs until PRs exist or checks complete. Does not use subagents.",
		parameters: PollParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const normalized = normalizeParams(params);
			if ((normalized.branches?.length ?? 0) === 0 && (normalized.session_ids?.length ?? 0) === 0) {
				throw new Error("Provide at least one branch or intern session id.");
			}
			const result = await pollUntilDone(pi, normalized, ctx, signal, onUpdate);
			const text = `${result.timedOut ? "Timed out" : "Finished"} after ${result.attempts} poll(s).\n\n${formatSnapshot(
				result.snapshot,
			)}`;
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});

	pi.registerCommand("intern-pr-monitor", {
		description:
			"Poll intern PRs. Usage: /intern-pr-monitor once|start|list|stop [--repo owner/repo] [--base branch] [--done prs_exist|checks_complete|checks_successful|draft_or_update] [--interval 60] <branch-or-intern-id>...",
		handler: async (args, ctx) => {
			const { action, params, stopId } = parseCommandParams(args);
			if (action === "list") {
				if (watchers.size === 0) {
					ctx.ui.notify("No active intern PR monitors.", "info");
					return;
				}
				ctx.ui.notify(
					[...watchers.values()]
						.map(
							(watcher) =>
								`${watcher.id}: ${(watcher.params.branches ?? []).join(", ")} ${(watcher.params.session_ids ?? [])
									.map((id) => `intern:${id.slice(0, 8)}`)
									.join(", ")}`,
						)
						.join("\n"),
					"info",
				);
				return;
			}

			if (action === "stop") {
				if (!stopId) {
					ctx.ui.notify("Usage: /intern-pr-monitor stop <monitor-id>", "warning");
					return;
				}
				ctx.ui.notify(stopWatcher(stopId) ? `Stopped ${stopId}` : `No monitor found: ${stopId}`, "info");
				return;
			}

			if ((params.branches?.length ?? 0) === 0 && (params.session_ids?.length ?? 0) === 0) {
				ctx.ui.notify("Provide at least one branch or intern session id.", "warning");
				return;
			}

			if (action === "start") {
				const repo = await resolveRepo(pi, params.repo, ctx.cwd);
				const id = `ipr-${Date.now().toString(36)}`;
				const normalized = normalizeParams(params) as Required<PollParams> & { base?: string; repo: string };
				normalized.repo = repo;
				const watcher: Watcher = {
					id,
					params: normalized,
					ctx: { cwd: ctx.cwd, hasUI: ctx.hasUI },
					stopped: false,
				};
				watchers.set(id, watcher);
				watcher.timer = setInterval(() => void runWatcherTick(watcher), (normalized.poll_interval_seconds ?? 60) * 1000);
				ctx.ui.notify(`Started intern PR monitor ${id}`, "info");
				void runWatcherTick(watcher);
				return;
			}

			const result = await pollUntilDone(pi, params, ctx, ctx.signal, (update) => {
				ctx.ui.setWidget("intern-pr-monitor", update.content[0]?.text ?? "", { placement: "belowEditor" });
			});
			ctx.ui.setWidget("intern-pr-monitor", undefined);
			ctx.ui.notify(`${result.timedOut ? "Timed out" : "Finished"} intern PR polling`, result.snapshot.done ? "info" : "warning");
		},
	});
}
