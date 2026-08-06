import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_ENVIRONMENT = "production";

type GitContext = {
	repo?: string;
	branch?: string;
	root?: string;
	sha?: string;
};

type InternSessionInfo = {
	session_id?: string;
	status?: string;
	waiting_for_input?: boolean;
	repo?: string;
	branch?: string;
	prompt?: string;
	created_at?: string;
	preview?: string;
	[key: string]: unknown;
};

const MonitorAlertSchema = Type.Object({
	target: Type.String({
		description:
			"What was deployed and what to watch, e.g. branch/PR/change summary plus expected production behavior.",
	}),
	repo: Type.Optional(
		Type.String({
			description: "Repository in org/repo format. Defaults to the current git remote or agency-inc/agency.",
		}),
	),
	branch: Type.Optional(
		Type.String({
			description:
				"Deployed branch, commit, or release identifier. Also used as the intern checkout branch when present. Defaults to the current git branch.",
		}),
	),
	environment: Type.Optional(
		Type.String({
			default: DEFAULT_ENVIRONMENT,
			description: "Environment to monitor. Defaults to production.",
		}),
	),
	interval_minutes: Type.Optional(
		Type.Number({
			default: DEFAULT_INTERVAL_MINUTES,
			description: "Minutes between monitoring checks. Defaults to 5. Minimum 1.",
		}),
	),
	duration_minutes: Type.Optional(
		Type.Number({
			default: DEFAULT_DURATION_MINUTES,
			description: "Maximum monitoring duration in minutes. Defaults to 30. Minimum 5.",
		}),
	),
	services: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Relevant Datadog service names or Temporal worker/service names to prioritize. If omitted, the intern infers them from the deployed change.",
		}),
	),
	datadog_query: Type.Optional(
		Type.String({
			description:
				"Optional Datadog log query/filter to prioritize. If omitted, the intern infers queries from services, env, and changed code.",
		}),
	),
	temporal_query: Type.Optional(
		Type.String({
			description:
				"Optional Temporal visibility query, workflow IDs, workflow types, or task queues to prioritize.",
		}),
	),
	slack_recipient: Type.Optional(
		Type.String({
			description:
				"Optional Slack user or channel to notify. Defaults to Slacking the requester using the intern's normal Slack behavior.",
		}),
	),
	deployed_at: Type.Optional(
		Type.String({
			description:
				"Optional deployment timestamp or time expression. Defaults to when the monitor session is created. Use ISO 8601 when possible.",
		}),
	),
	sufficient_proof: Type.Optional(
		Type.String({
			description:
				"Optional custom early-stop criteria. Defaults to multiple clean Datadog + Temporal checks over at least 15 minutes.",
		}),
	),
	provider: Type.Optional(
		Type.String({
			description: "Optional intern provider override.",
		}),
	),
});

type MonitorAlertInput = Static<typeof MonitorAlertSchema>;

type NormalizedMonitorAlertInput = Required<
	Pick<MonitorAlertInput, "target" | "environment" | "interval_minutes" | "duration_minutes" | "deployed_at">
> &
	Omit<MonitorAlertInput, "target" | "environment" | "interval_minutes" | "duration_minutes" | "deployed_at">;

function trimMaybe(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseRepoFromRemote(remoteUrl: string | undefined): string | undefined {
	const remote = trimMaybe(remoteUrl);
	if (!remote) return undefined;

	const cleaned = remote.replace(/^git@github\.com:/, "https://github.com/");
	const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
	if (!match) return undefined;
	return `${match[1]}/${match[2]}`;
}

function clampNumber(value: number | undefined, fallback: number, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.floor(value));
}

function normalizeInput(input: MonitorAlertInput): NormalizedMonitorAlertInput {
	return {
		...input,
		target: input.target.trim(),
		environment: trimMaybe(input.environment) ?? DEFAULT_ENVIRONMENT,
		interval_minutes: clampNumber(input.interval_minutes, DEFAULT_INTERVAL_MINUTES, 1),
		duration_minutes: clampNumber(input.duration_minutes, DEFAULT_DURATION_MINUTES, 5),
		deployed_at: trimMaybe(input.deployed_at) ?? new Date().toISOString(),
		branch: trimMaybe(input.branch),
		repo: trimMaybe(input.repo),
		datadog_query: trimMaybe(input.datadog_query),
		temporal_query: trimMaybe(input.temporal_query),
		slack_recipient: trimMaybe(input.slack_recipient),
		sufficient_proof: trimMaybe(input.sufficient_proof),
		provider: trimMaybe(input.provider),
		services: [...new Set((input.services ?? []).map((service) => service.trim()).filter(Boolean))],
	};
}

function reportMessage(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}

	if (level === "error") console.error(text);
	else console.log(text);
}

async function getGitContext(pi: ExtensionAPI): Promise<GitContext> {
	const [repoResult, branchResult, rootResult, shaResult] = await Promise.all([
		pi.exec("git", ["remote", "get-url", "origin"]).catch(() => undefined),
		pi.exec("git", ["branch", "--show-current"]).catch(() => undefined),
		pi.exec("git", ["rev-parse", "--show-toplevel"]).catch(() => undefined),
		pi.exec("git", ["rev-parse", "HEAD"]).catch(() => undefined),
	]);

	return {
		repo: parseRepoFromRemote(repoResult?.stdout),
		branch: trimMaybe(branchResult?.stdout),
		root: trimMaybe(rootResult?.stdout),
		sha: trimMaybe(shaResult?.stdout),
	};
}

function parseJson<T>(value: string): T | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			try {
				return JSON.parse(lines[i]) as T;
			} catch {
				continue;
			}
		}
		return undefined;
	}
}

function formatList(title: string, values: string[] | undefined): string[] {
	if (!values || values.length === 0) return [];
	return [title, ...values.map((value) => `- ${value}`), ""];
}

function buildMonitorPrompt(input: NormalizedMonitorAlertInput, git: GitContext, repo: string, branch?: string): string {
	const services = input.services ?? [];
	const proof =
		input.sufficient_proof ??
		[
			`At least 3 monitoring checks spanning at least 15 minutes after ${input.deployed_at} are clean,`,
			"with no new relevant Datadog errors above baseline, no new failed/timed-out/terminated Temporal workflows,",
			"and no relevant Datadog monitors/incidents in alert. If the full duration is shorter than 15 minutes, require at least 2 clean checks.",
		].join(" ");

	const lines = [
		"Agency intern task: monitor and alert after deployment",
		"",
		"Primary objective",
		`Monitor the deployed change for regressions, especially new Datadog errors/logs and Temporal workflow failures. Send Slack progress updates and stop when the monitoring window is complete or the early-stop proof is satisfied.`,
		"",
		"Deployment context",
		`- Repo: ${repo}`,
		branch ? `- Deployed branch/change identifier: ${branch}` : undefined,
		git.sha ? `- Caller local HEAD at monitor creation: ${git.sha}` : undefined,
		git.root ? `- Caller local repo root: ${git.root}` : undefined,
		`- Environment: ${input.environment}`,
		`- Deployment time / post-deploy window starts: ${input.deployed_at}`,
		`- Requested monitoring cadence: every ${input.interval_minutes} minute(s)` ,
		`- Maximum monitoring duration: ${input.duration_minutes} minute(s)` ,
		input.slack_recipient ? `- Slack recipient/channel: ${input.slack_recipient}` : "- Slack recipient/channel: requester (use normal intern Slack behavior)",
		"",
		"What was deployed / what to watch",
		input.target,
		"",
		...formatList("Relevant services to prioritize", services),
		input.datadog_query ? "Datadog query/filter to prioritize" : undefined,
		input.datadog_query ? input.datadog_query : undefined,
		input.datadog_query ? "" : undefined,
		input.temporal_query ? "Temporal query/workflows/task queues to prioritize" : undefined,
		input.temporal_query ? input.temporal_query : undefined,
		input.temporal_query ? "" : undefined,
		"Operating mode",
		"- This is a monitoring/research session, not an implementation session. Do not open a PR and do not make code changes unless explicitly needed to inspect context.",
		"- Use read-only production inspection only. Do not terminate, cancel, signal, reset, start, delete, or otherwise mutate production Temporal workflows.",
		"- If Datadog or Temporal MCP tools are unavailable, Slack the requester immediately that monitoring is blocked and include the required setup/action.",
		"- Keep the session alive and loop yourself; do not finish after the first check unless the monitoring is blocked before it starts.",
		"",
		"Recommended orientation before the first monitoring check",
		"- Read AGENTS.md and the directly relevant skills if present: `.claude/skills/pup-datadog/SKILL.md`, `.claude/skills/temporal-cli-ops/SKILL.md`, and `.claude/skills/debug-temporal-workflow/SKILL.md`.",
		"- Quickly inspect the deployed diff or PR if available so you can infer affected services, Temporal workflow types, task queues, log fields, and likely error signatures.",
		"- Establish a short pre-deploy baseline where practical, then compare post-deploy observations against it.",
		"",
		"Monitoring loop",
		`- Run a check immediately, then repeat every ${input.interval_minutes} minute(s) until ${input.duration_minutes} minute(s) have elapsed or the early-stop proof below is satisfied.`,
		"- Datadog: use `search_datadog_logs` for raw examples/discovery and `analyze_datadog_logs` for counts/group-bys. Check error logs, exceptions, Tracebacks, warnings that look severe, relevant services, monitors, incidents, and APM spans/services when useful.",
		"- Temporal: use the intern MCP Temporal CLI for read-only `temporal workflow list/count/describe/show/trace` style checks. Look for Failed, TimedOut, Terminated, Canceled, stuck Running workflows, task queue/worker errors, ActivityTaskFailed, ActivityTaskTimedOut, WorkflowTaskFailed, ChildWorkflowExecutionFailed, and nondeterminism-like failures.",
		"- Correlate findings with the deployment time, environment, services, workflow types, org/user/company IDs, branch/commit/PR identifiers, and any changed code paths.",
		"- Prefer concise counts plus 1-3 representative examples. Avoid dumping huge logs into Slack.",
		"",
		"Slack notification requirements",
		"- Send a kickoff Slack when monitoring starts: include what is being monitored, cadence, max duration, environment, and the initial queries/scope you plan to use.",
		`- Send a progress Slack after every monitoring check, even if clean. Include elapsed time, Datadog status, Temporal status, notable counts, and whether you are continuing or stopping early.`,
		"- If you find a likely regression or production-impacting error, Slack immediately with severity, evidence, links/IDs, suspected relation to the deploy, and recommended next action. Continue monitoring unless clearly blocked.",
		"- Send a final Slack before finishing: summarize all checks, evidence, whether errors appeared, whether early-stop proof was met, and any follow-up recommendations.",
		"",
		"Early-stop / sufficient proof criteria",
		`- ${proof}`,
		"- Do not stop early merely because the first check is clean unless the requester explicitly provided a stronger custom proof criterion.",
		"",
		"Final response in this intern session",
		"- Summarize the Slack updates you sent.",
		"- List the Datadog and Temporal checks/queries performed.",
		"- State whether the monitor ended by timeout, early-stop proof, or a blocking issue.",
		"- Include any incident/error evidence, assumptions, and residual risks.",
	].filter((line): line is string => Boolean(line));

	return lines.join("\n");
}

async function createMonitorAlertSession(pi: ExtensionAPI, input: MonitorAlertInput, signal?: AbortSignal) {
	const normalized = normalizeInput(input);
	if (!normalized.target) throw new Error("target is required.");

	const git = await getGitContext(pi);
	const repo = normalized.repo ?? git.repo ?? "agency-inc/agency";
	const branch = normalized.branch ?? git.branch;
	const prompt = buildMonitorPrompt(normalized, git, repo, branch);

	const args = ["new", "--json", "--repo", repo];
	if (branch) args.push("--branch", branch);
	if (normalized.provider) args.push("--provider", normalized.provider);
	args.push(prompt);

	const result = await pi.exec("intern", args, { signal });
	if (result.code !== 0) {
		const message = [result.stderr, result.stdout].map((part) => part?.trim()).filter(Boolean).join("\n\n");
		throw new Error(message || `intern exited with code ${result.code}`);
	}

	const parsed = parseJson<InternSessionInfo>(result.stdout) ?? {};
	const sessionId = trimMaybe(typeof parsed.session_id === "string" ? parsed.session_id : undefined);
	const attachHint = sessionId ? `intern attach ${sessionId}` : undefined;

	return {
		repo,
		branch,
		sessionId,
		status: typeof parsed.status === "string" ? parsed.status : undefined,
		attachHint,
		prompt,
		parsed,
		normalized,
	};
}

function formatCreatedMessage(session: Awaited<ReturnType<typeof createMonitorAlertSession>>): string {
	const lines = [
		`Created monitor-and-alert intern session${session.sessionId ? ` ${session.sessionId}` : ""}.`,
		`Repo: ${session.repo}`,
		session.branch ? `Branch/change: ${session.branch}` : undefined,
		`Environment: ${session.normalized.environment}`,
		`Cadence: every ${session.normalized.interval_minutes} minute(s)`,
		`Max duration: ${session.normalized.duration_minutes} minute(s)`,
		session.status ? `Status: ${session.status}` : undefined,
		session.attachHint ? `Attach with: ${session.attachHint}` : undefined,
	].filter((line): line is string => Boolean(line));

	return lines.join("\n");
}

function parseArgs(input: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	return tokens;
}

function parseCommandInput(args: string): MonitorAlertInput {
	const tokens = parseArgs(args);
	const input: MonitorAlertInput = { target: "", services: [] };
	const targetParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const next = tokens[i + 1];
		if (token === "--repo" && next) {
			input.repo = next;
			i++;
		} else if ((token === "--branch" || token === "--change") && next) {
			input.branch = next;
			i++;
		} else if ((token === "--env" || token === "--environment") && next) {
			input.environment = next;
			i++;
		} else if ((token === "--interval" || token === "--interval-minutes") && next) {
			input.interval_minutes = Number(next);
			i++;
		} else if ((token === "--duration" || token === "--duration-minutes") && next) {
			input.duration_minutes = Number(next);
			i++;
		} else if ((token === "--service" || token === "--services") && next) {
			input.services = [...(input.services ?? []), ...next.split(",")];
			i++;
		} else if ((token === "--datadog" || token === "--datadog-query") && next) {
			input.datadog_query = next;
			i++;
		} else if ((token === "--temporal" || token === "--temporal-query") && next) {
			input.temporal_query = next;
			i++;
		} else if ((token === "--slack" || token === "--slack-recipient") && next) {
			input.slack_recipient = next;
			i++;
		} else if ((token === "--deployed-at" || token === "--since") && next) {
			input.deployed_at = next;
			i++;
		} else if ((token === "--proof" || token === "--sufficient-proof") && next) {
			input.sufficient_proof = next;
			i++;
		} else if (token === "--provider" && next) {
			input.provider = next;
			i++;
		} else if (token) {
			targetParts.push(token);
		}
	}

	input.target = targetParts.join(" ").trim();
	return input;
}

async function runMonitorAlertCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	let input = parseCommandInput(args);
	if (!input.target && ctx.hasUI) {
		const edited = await ctx.ui.editor(
			"Create monitor-and-alert intern task",
			[
				"What was deployed / what should be watched:",
				"",
				"Relevant services (optional):",
				"",
				"Datadog query/filter (optional):",
				"",
				"Temporal workflows/query/task queues (optional):",
				"",
			].join("\n"),
		);
		const text = edited?.trim();
		if (text) input = { ...input, target: text };
	}

	if (!input.target) {
		reportMessage(ctx, "Usage: /intern-monitor-alert [--env production] [--interval 5] [--duration 30] [--service name] [--datadog-query '...'] [--temporal-query '...'] <what was deployed>", "warning");
		return;
	}

	reportMessage(ctx, "Creating monitor-and-alert intern session...", "info");
	const session = await createMonitorAlertSession(pi, input, ctx.signal);
	reportMessage(ctx, formatCreatedMessage(session), "info");
}

export default function internMonitorAlertExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "intern_monitor_alert",
		label: "Intern monitor and alert",
		description:
			"Create a remote intern session that monitors a deployed change with Temporal + Datadog checks, sends Slack progress updates, and stops after a bounded window or sufficient proof.",
		parameters: MonitorAlertSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: "Creating monitor-and-alert intern session..." }],
				details: {},
			});

			const session = await createMonitorAlertSession(pi, params, signal);
			return {
				content: [{ type: "text", text: formatCreatedMessage(session) }],
				details: {
					sessionId: session.sessionId,
					repo: session.repo,
					branch: session.branch,
					status: session.status,
					attachHint: session.attachHint,
					prompt: session.prompt,
					params: session.normalized,
					parsed: session.parsed,
				},
			};
		},
	});

	pi.registerCommand("intern-monitor-alert", {
		description:
			"Create an intern monitor-and-alert session. Usage: /intern-monitor-alert [--env production] [--interval 5] [--duration 30] [--service svc] [--datadog-query '...'] [--temporal-query '...'] <what was deployed>",
		handler: async (args, ctx) => {
			await runMonitorAlertCommand(pi, args, ctx);
		},
	});
}
