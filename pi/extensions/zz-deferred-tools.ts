import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_SEARCH_NAME = "search_tools";

const DEFERRED_TOOLS = [
	{
		name: "intern_new",
		label: "remote intern delegation",
		keywords: "intern delegate remote slack research implementation branch pull request pr",
	},
	{
		name: "intern_monitor_alert",
		label: "post-deploy monitoring",
		keywords: "intern monitor alert deployment production datadog temporal slack",
	},
	{
		name: "intern_pr_poll",
		label: "intern pull request polling",
		keywords: "intern pull request pr github checks ci poll branch monitor",
	},
	{
		name: "web_search",
		label: "web research",
		keywords: "web internet search research recent current sources citations documentation",
	},
	{
		name: "fetch_content",
		label: "web content fetching",
		keywords: "fetch url webpage website content github pdf youtube documentation",
	},
	{
		name: "get_search_content",
		label: "stored search content",
		keywords: "search stored result full content response source retrieve",
	},
] as const;

const deferredNames = new Set<string>(DEFERRED_TOOLS.map((tool) => tool.name));

function report(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "info");
	else console.log(message);
}

function availableDeferredTools(pi: ExtensionAPI) {
	const registered = new Set(pi.getAllTools().map((tool) => tool.name));
	return DEFERRED_TOOLS.filter((tool) => registered.has(tool.name));
}

function activateTools(pi: ExtensionAPI, names: string[]): string[] {
	const active = pi.getActiveTools();
	const activeSet = new Set(active);
	const added = names.filter((name) => !activeSet.has(name));
	if (added.length > 0) pi.setActiveTools([...active, ...added]);
	return added;
}

function resetDeferredTools(pi: ExtensionAPI): void {
	const active = pi.getActiveTools().filter((name) => !deferredNames.has(name));
	pi.setActiveTools([...new Set([...active, TOOL_SEARCH_NAME])]);
}

export default function deferredToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_SEARCH_NAME,
		label: "Search tools",
		description: "Find and activate deferred web-research or Agency intern tools when the active tools cannot perform the task.",
		promptSnippet: "Use search_tools when a task requires web access, remote intern delegation, deployment monitoring, or intern PR polling.",
		parameters: Type.Object({
			query: Type.String({ description: "Capability or task to find a tool for." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, default: 3 })),
		}),
		async execute(_toolCallId, params) {
			const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const matches = availableDeferredTools(pi)
				.map((tool) => ({
					tool,
					score: terms.reduce(
						(total, term) => total + (`${tool.name} ${tool.label} ${tool.keywords}`.includes(term) ? 1 : 0),
						0,
					),
				}))
				.filter((match) => match.score > 0)
				.sort((left, right) => right.score - left.score)
				.slice(0, params.limit ?? 3)
				.map((match) => match.tool.name);

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No deferred tools matched: ${params.query}` }],
					details: { matches: [], added: [] },
				};
			}

			const added = activateTools(pi, matches);
			return {
				content: [{
					type: "text",
					text: added.length > 0
						? `Loaded tools: ${added.join(", ")}`
						: `Matching tools already active: ${matches.join(", ")}`,
				}],
				details: { matches, added },
			};
		},
	});

	pi.on("session_start", () => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		resetDeferredTools(pi);
	});

	pi.registerCommand("deferred-tools", {
		description: "Show, load, or reset deferred tools: /deferred-tools [load <name>|reset]",
		handler: async (args, ctx) => {
			const [action, name] = args.trim().split(/\s+/, 2);
			const available = availableDeferredTools(pi);
			if (action === "reset") {
				resetDeferredTools(pi);
				report(ctx, "Deferred tools reset. Use search_tools to activate them when needed.");
				return;
			}
			if (action === "load" && name) {
				if (!available.some((tool) => tool.name === name)) {
					report(ctx, `Deferred tool is unavailable: ${name}`);
					return;
				}
				const added = activateTools(pi, [name]);
				report(ctx, added.length > 0 ? `Loaded ${name}` : `${name} is already active`);
				return;
			}

			const active = new Set(pi.getActiveTools());
			report(
				ctx,
				available.map((tool) => `${active.has(tool.name) ? "active" : "deferred"}: ${tool.name} — ${tool.label}`).join("\n"),
			);
		},
	});
}
