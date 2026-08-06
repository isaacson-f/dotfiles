import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const internSessionTypeSchema = Type.Union([
	Type.Literal("research_slack"),
	Type.Literal("pr_slack"),
]);

const DEFAULT_INTERN_BRANCH = "main";

const internNewSchema = Type.Object({
	session_type: Type.Union([
		Type.Literal("research_slack"),
		Type.Literal("pr_slack"),
	], {
		description:
			"Choose the intern session type: `research_slack` for codebase research that ends with a Slack update, or `pr_slack` for implementation work that ends with a new branch, PR, and Slack update.",
	}),
	task: Type.String({
		description:
			"The task for the remote intern. Provide the actual work to do; the extension will wrap it with Agency-specific guidance for the chosen session type.",
	}),
	repo: Type.Optional(
		Type.String({
			description: "Repository in org/repo format. Defaults to the current git remote or agency-inc/agency.",
		}),
	),
	branch: Type.Optional(
		Type.String({
			default: DEFAULT_INTERN_BRANCH,
			description: "Optional branch to check out before the intern starts working. Defaults to main unless the user explicitly asks for another branch.",
		}),
	),
	provider: Type.Optional(
		Type.String({
			description: "Optional intern provider override.",
		}),
	),
	docker: Type.Optional(
		Type.Boolean({
			description: "Enable Docker-in-Docker for the intern session when needed.",
		}),
	),
	raw_prompt: Type.Optional(
		Type.Boolean({
			description: "If true, send the task as-is without the Agency one-shot guidance wrapper.",
		}),
	),
});

type InternNewInput = Static<typeof internNewSchema>;
type InternSessionType = Static<typeof internSessionTypeSchema>;

type GitContext = {
	repo?: string;
	branch?: string;
	root?: string;
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

function reportMessage(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}

	if (level === "error") console.error(text);
	else console.log(text);
}

async function getGitContext(pi: ExtensionAPI): Promise<GitContext> {
	const [repoResult, branchResult, rootResult] = await Promise.all([
		pi.exec("git", ["remote", "get-url", "origin"]).catch(() => undefined),
		pi.exec("git", ["branch", "--show-current"]).catch(() => undefined),
		pi.exec("git", ["rev-parse", "--show-toplevel"]).catch(() => undefined),
	]);

	return {
		repo: parseRepoFromRemote(repoResult?.stdout),
		branch: trimMaybe(branchResult?.stdout),
		root: trimMaybe(rootResult?.stdout),
	};
}

function formatSessionType(sessionType: InternSessionType): string {
	return sessionType === "research_slack" ? "Research + Slack" : "Branch/PR + Slack";
}

function buildAgencyPrompt(
	task: string,
	sessionType: InternSessionType,
	git: GitContext,
	repo: string,
	branch?: string,
): string {
	const modeSpecificLines =
		sessionType === "research_slack"
			? [
				"- This is a research session. Investigate the codebase and produce the answer without opening a PR.",
				"- Slack the requester with the final answer, recommendations, and any relevant file paths or commands.",
				"- Avoid code changes unless they are strictly necessary to complete the research task, and if you do make any, explain why.",
			]
			: [
				"- This is an implementation session. After orienting yourself, create a fresh working branch for the change before editing code.",
				"- Finish by opening a PR and Slack the requester with the PR link plus a concise summary.",
				"- Run the most relevant verification for the files you changed before opening the PR.",
			];

	const finalResponseLines =
		sessionType === "research_slack"
			? [
				"- Summarize the answer you sent.",
				"- List the exact file paths or docs you inspected.",
				"- Call out assumptions, follow-up work, or open questions.",
			]
			: [
				"- Summarize what changed.",
				"- List the exact file paths touched.",
				"- List verification commands run and their outcomes.",
				"- Include the branch name and PR link.",
				"- Call out any follow-up work, assumptions, or risks.",
			];

	const lines = [
		"Agency intern task",
		"",
		"Session type",
		`- ${formatSessionType(sessionType)}`,
		"",
		"Primary objective",
		task.trim(),
		"",
		"Repository context",
		`- Repo: ${repo}`,
		git.root ? `- Local repo root from caller: ${git.root}` : undefined,
		git.branch ? `- Caller's current branch: ${git.branch}` : undefined,
		branch ? `- Requested session branch: ${branch}` : undefined,
		"",
		"Execution expectations",
		"- Treat this as a one-shot task. Make reasonable assumptions and drive to a useful outcome without waiting for clarification unless blocked by a hard ambiguity.",
		"- Start with a codebase exploration pass: read AGENTS.md at the repository root, inspect the current implementation, and read any directly relevant docs under .claude/skills/ before changing code.",
		"- Treat implementation details in the request as hypotheses to verify against the current code, not instructions to follow blindly.",
		"- Follow existing patterns in the touched area instead of inventing new structure.",
		"- Keep the scope tight and avoid unrelated refactors unless they are necessary to complete the task cleanly.",
		"- Clean up as you work. Keep comments sparse and useful.",
		"- If you change FastAPI routes or API response shapes, regenerate or verify OpenAPI artifacts as needed.",
		...modeSpecificLines,
		"",
		"Verification expectations",
		"- Run the most relevant checks for the files you changed.",
		"- Agency's standard verification commands include: just ts-types-check, just py-types-check, just all-format-fix, just all-lint-fix, plus targeted tests.",
		"- If a full command is too expensive or irrelevant, run the narrowest meaningful verification and explain why.",
		"",
		"Final response expectations",
		...finalResponseLines,
	].filter((line): line is string => Boolean(line));

	return lines.join("\n");
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

async function createInternSession(pi: ExtensionAPI, input: InternNewInput, signal?: AbortSignal) {
	const git = await getGitContext(pi);
	const repo = trimMaybe(input.repo) ?? git.repo ?? "agency-inc/agency";
	const branch = trimMaybe(input.branch) ?? DEFAULT_INTERN_BRANCH;
	const provider = trimMaybe(input.provider);
	const task = input.task.trim();
	const sessionType = input.session_type;
	const prompt = input.raw_prompt ? task : buildAgencyPrompt(task, sessionType, git, repo, branch);

	const args = ["new", "--json", "--repo", repo];
	if (branch) args.push("--branch", branch);
	if (provider) args.push("--provider", provider);
	if (input.docker) args.push("--docker");
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
		branch: branch ?? (typeof parsed.branch === "string" ? parsed.branch : undefined),
		sessionType,
		prompt,
		sessionId,
		status: typeof parsed.status === "string" ? parsed.status : undefined,
		attachHint,
		rawResult: result,
		parsed,
	};
}

function formatSessionCreatedMessage(session: Awaited<ReturnType<typeof createInternSession>>): string {
	const lines = [
		`Created intern session${session.sessionId ? ` ${session.sessionId}` : ""}.`,
		`Type: ${formatSessionType(session.sessionType)}`,
		`Repo: ${session.repo}`,
		session.branch ? `Branch: ${session.branch}` : undefined,
		session.status ? `Status: ${session.status}` : undefined,
		session.attachHint ? `Attach with: ${session.attachHint}` : undefined,
	].filter((line): line is string => Boolean(line));

	return lines.join("\n");
}

async function pickSessionType(ctx: ExtensionCommandContext): Promise<InternSessionType> {
	if (!ctx.hasUI) {
		return "pr_slack";
	}

	const picked = await ctx.ui.select("Intern session type", [
		"Research + Slack",
		"Branch/PR + Slack",
	]);
	return picked === "Research + Slack" ? "research_slack" : "pr_slack";
}

async function runInternNewCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let task = args.trim();
	if (!task) {
		task =
			(
				await ctx.ui.editor(
					"Create intern task",
					[
						"Goal:",
						"",
						"Context:",
						"",
						"Constraints:",
						"",
						"Definition of done:",
					].join("\n"),
				)
			) ?? "";
		task = task.trim();
	}

	if (!task) {
		reportMessage(ctx, "No intern task provided", "warning");
		return;
	}

	const sessionType = await pickSessionType(ctx);
	reportMessage(ctx, "Creating intern session...", "info");
	const session = await createInternSession(pi, { task, session_type: sessionType });
	reportMessage(ctx, formatSessionCreatedMessage(session), "info");
}

export default function agencyInternExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "intern_new",
		label: "Intern new",
		description: "Create a new remote intern session in the Agency repo using the installed intern CLI.",
		parameters: internNewSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: "Creating intern session..." }],
				details: {},
			});

			const session = await createInternSession(pi, params, signal);
			return {
				content: [{ type: "text", text: formatSessionCreatedMessage(session) }],
				details: {
					sessionId: session.sessionId,
					sessionType: session.sessionType,
					repo: session.repo,
					branch: session.branch,
					status: session.status,
					attachHint: session.attachHint,
					prompt: session.prompt,
					parsed: session.parsed,
				},
			};
		},
	});

	pi.registerCommand("intern-new", {
		description: "Create a new remote intern session for the Agency repo",
		handler: async (args, ctx) => {
			await runInternNewCommand(pi, args, ctx);
		},
	});

	pi.registerCommand("intern-list", {
		description: "List current intern sessions",
		handler: async (_args, ctx) => {
			const result = await pi.exec("intern", ["list", "--json"]);
			if (result.code !== 0) {
				const message = [result.stderr, result.stdout].map((part) => part?.trim()).filter(Boolean).join("\n\n");
				throw new Error(message || `intern list exited with code ${result.code}`);
			}

			const sessions = parseJson<InternSessionInfo[]>(result.stdout) ?? [];
			if (sessions.length === 0) {
				reportMessage(ctx, "No intern sessions found", "info");
				return;
			}

			const labels = sessions.map((session) => {
				const sessionId = typeof session.session_id === "string" ? session.session_id : "unknown";
				const status = typeof session.status === "string" ? session.status : "unknown";
				const repo = typeof session.repo === "string" ? session.repo : "unknown repo";
				const branch = typeof session.branch === "string" ? session.branch : "unknown branch";
				return `${sessionId} • ${status} • ${repo} • ${branch}`;
			});

			if (!ctx.hasUI) {
				console.log(labels.join("\n"));
				return;
			}

			const picked = await ctx.ui.select("Intern sessions", labels);
			if (!picked) return;
			const sessionId = picked.split(" • ")[0];
			reportMessage(ctx, `Attach with: intern attach ${sessionId}`, "info");
		},
	});
}
