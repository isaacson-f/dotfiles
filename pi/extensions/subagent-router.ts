import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "subagent-router-state.json");
const KNOWN_AGENTS = [
	"scout",
	"researcher",
	"planner",
	"worker",
	"reviewer",
	"context-builder",
	"oracle",
	"delegate",
] as const;

type AgentName = (typeof KNOWN_AGENTS)[number];

interface AgentUsage {
	lastUsedAt?: string;
	lastNudgedAt?: string;
	promptsSinceUse: number;
	promptsSinceNudge: number;
}

interface RouterState {
	version: 1;
	updatedAt: string;
	agents: Record<AgentName, AgentUsage>;
}

function emptyUsage(): AgentUsage {
	return { promptsSinceUse: 999, promptsSinceNudge: 999 };
}

function defaultState(): RouterState {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		agents: Object.fromEntries(KNOWN_AGENTS.map((agent) => [agent, emptyUsage()])) as Record<AgentName, AgentUsage>,
	};
}

function loadState(): RouterState {
	try {
		if (!existsSync(STATE_PATH)) return defaultState();
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<RouterState>;
		const state = defaultState();
		for (const agent of KNOWN_AGENTS) {
			state.agents[agent] = { ...state.agents[agent], ...(parsed.agents?.[agent] ?? {}) };
		}
		return state;
	} catch {
		return defaultState();
	}
}

function saveState(state: RouterState): void {
	state.updatedAt = new Date().toISOString();
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function bumpPromptCounters(state: RouterState): void {
	for (const usage of Object.values(state.agents)) {
		usage.promptsSinceUse += 1;
		usage.promptsSinceNudge += 1;
	}
}

function markUsed(state: RouterState, agent: string | undefined): void {
	if (!agent || !isAgentName(agent)) return;
	state.agents[agent] = {
		...state.agents[agent],
		lastUsedAt: new Date().toISOString(),
		promptsSinceUse: 0,
	};
}

function markNudged(state: RouterState, agent: AgentName): void {
	state.agents[agent] = {
		...state.agents[agent],
		lastNudgedAt: new Date().toISOString(),
		promptsSinceNudge: 0,
	};
}

function isAgentName(value: string): value is AgentName {
	return (KNOWN_AGENTS as readonly string[]).includes(value);
}

function textMatches(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function isNudgeAllowed(usage: AgentUsage, minPromptsSinceUse: number): boolean {
	return usage.promptsSinceUse >= minPromptsSinceUse && usage.promptsSinceNudge >= 3;
}

function classifyPrompt(prompt: string, state: RouterState): Array<{ agent: AgentName; reason: string; route: string }> {
	const text = prompt.toLowerCase();
	const hints: Array<{ agent: AgentName; reason: string; route: string }> = [];

	const unfamiliarCode = textMatches(text, [
		/\bhow does\b/,
		/\bwhere (is|are|does|do)\b/,
		/\bunderstand\b/,
		/\binvestigate\b/,
		/\btrace\b/,
		/\bmap\b.*\b(flow|code|system|implementation)\b/,
		/\bfind\b.*\b(implementation|code|file|flow|source)\b/,
		/\bunfamiliar\b/,
	]);

	const riskyDecision = textMatches(text, [
		/\barchitecture\b/,
		/\barchitectural\b/,
		/\bmigration\b/,
		/\bmigrate\b/,
		/\bstrategy\b/,
		/\bapproach\b/,
		/\btrade[- ]?off\b/,
		/\brisky\b/,
		/\bsecurity\b/,
		/\bpermissions?\b/,
		/\breplace\b/,
		/\brefactor\b/,
		/\bhard bug\b/,
		/\bsecond opinion\b/,
		/\bshould we\b/,
	]);

	const externalFacts = textMatches(text, [
		/\bdocs?\b/,
		/\bofficial\b/,
		/\bapi\b.*\b(reference|docs?|behavior)\b/,
		/\blatest\b/,
		/\bcurrent\b.*\b(version|behavior|docs?)\b/,
		/\bchangelog\b/,
		/\brelease notes?\b/,
		/\bvendor\b/,
	]);

	const planning = textMatches(text, [
		/\bplan\b/,
		/\bdesign\b/,
		/\bproposal\b/,
		/\broadmap\b/,
		/\bsteps?\b.*\bimplement\b/,
	]);

	const implementation = textMatches(text, [
		/\bimplement\b/,
		/\badd\b/,
		/\bfix\b/,
		/\bchange\b/,
		/\bupdate\b/,
		/\bwire\b/,
		/\bbuild\b/,
	]);

	const reviewReady = textMatches(text, [
		/\breview\b/,
		/\bcheck\b.*\b(diff|change|work|before|ready)\b/,
		/\bready\b/,
		/\bship\b/,
		/\bdone\b/,
		/\bfinal\b/,
		/\bsummarize\b/,
		/\bvalidate\b/,
		/\bqa\b/,
		/\btest\b.*\bcoverage|missing|enough\b/,
	]);

	if (unfamiliarCode && isNudgeAllowed(state.agents.scout, 3)) {
		hints.push({
			agent: "scout",
			reason: "the request looks like unfamiliar-code/context discovery",
			route: "start with scout before planning or editing",
		});
	}

	if (externalFacts && isNudgeAllowed(state.agents.researcher, 4)) {
		hints.push({
			agent: "researcher",
			reason: "the request depends on docs, API behavior, or current external facts",
			route: "use researcher and cite sources before relying on the fact",
		});
	}

	if (riskyDecision && isNudgeAllowed(state.agents.oracle, 4)) {
		hints.push({
			agent: "oracle",
			reason: "the request appears risky, architectural, or decision-heavy",
			route: "ask oracle for a second opinion before worker edits",
		});
	}

	if ((planning || (implementation && !unfamiliarCode)) && isNudgeAllowed(state.agents.planner, 5)) {
		hints.push({
			agent: "planner",
			reason: "the request likely benefits from a concrete plan before non-trivial edits",
			route: "use planner, then stop for approval unless implementation was explicitly requested",
		});
	}

	if ((reviewReady || implementation) && isNudgeAllowed(state.agents.reviewer, 4)) {
		hints.push({
			agent: "reviewer",
			reason: implementation
				? "implementation work should usually be reviewed before final summary"
				: "the request asks whether work is ready, correct, validated, or review-worthy",
			route: "run reviewer, preferably fresh-context for unbiased validation",
		});
	}

	return hints.slice(0, 3);
}

function extractAgents(input: unknown): string[] {
	const agents = new Set<string>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.agent === "string") agents.add(record.agent);
		for (const key of ["tasks", "chain", "parallel"] as const) visit(record[key]);
	};
	visit(input);
	return [...agents];
}

function formatUsage(state: RouterState): string {
	return KNOWN_AGENTS.map((agent) => {
		const usage = state.agents[agent];
		const lastUsed = usage.lastUsedAt ?? "never";
		return `${agent}: last used ${lastUsed}, prompts since use ${usage.promptsSinceUse}`;
	}).join("\n");
}

export default function subagentRouterExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const state = loadState();
		bumpPromptCounters(state);
		const hints = classifyPrompt(event.prompt, state);
		for (const hint of hints) markNudged(state, hint.agent);
		saveState(state);

		if (hints.length === 0) return;

		const hintText = hints
			.map(
				(hint) =>
					`- Consider ${hint.agent}: ${hint.reason}; recommended route: ${hint.route}.`,
			)
			.join("\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n<subagent-routing-hints>\nThe user wants automatic subagent routing. For this prompt, actively raise useful stale/underused subagents when appropriate. Do not force delegation if it would be overkill, but if you use or suggest a route, briefly explain it.\n${hintText}\n</subagent-routing-hints>`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "subagent") return;
		const state = loadState();
		for (const agent of extractAgents(event.input)) markUsed(state, agent);
		saveState(state);
	});

	pi.registerCommand("subagent-routing-state", {
		description: "Show automatic subagent routing usage state",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatUsage(loadState()), "info");
		},
	});

	pi.registerCommand("subagent-routing-reset", {
		description: "Reset automatic subagent routing usage state",
		handler: async (_args, ctx) => {
			saveState(defaultState());
			ctx.ui.notify("Subagent routing state reset", "info");
		},
	});
}
