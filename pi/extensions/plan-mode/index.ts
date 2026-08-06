/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts ordered tasks from `## Tasks (Ordered)` sections
 * - plan_progress tool to complete/block/finish execution steps
 * - [DONE:n] marker fallback for legacy progress tracking
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractDoneSteps, extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask-user"];
const PLAN_PROGRESS_TOOL = "plan_progress";
const FALLBACK_NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "ask-user"];

const PlanProgressParams = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("complete"),
		Type.Literal("block"),
		Type.Literal("finish"),
	], {
		description: "Action to perform: list current plan progress, complete a step, mark a step blocked, or finish execution.",
	}),
	step: Type.Optional(Type.Number({ description: "Plan step number for complete/block actions." })),
	reason: Type.Optional(Type.String({ description: "Reason for block/finish actions when work cannot continue." })),
});

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function sortTodosForDisplay(items: TodoItem[]): TodoItem[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => Number(a.item.completed) - Number(b.item.completed) || a.index - b.index)
		.map(({ item }) => item);
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let previousActiveTools: string[] | null = null;
	let lastPlanText: string | null = null;
	let clearContextExecution = false;
	let progressUpdatedThisTurn = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			const blocked = todoItems.filter((t) => t.blocked).length;
			const suffix = blocked > 0 ? ` blocked:${blocked}` : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}${suffix}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = sortTodosForDisplay(todoItems).map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				if (item.blocked) {
					const reason = item.blockReason ? ` — ${item.blockReason}` : "";
					return `${ctx.ui.theme.fg("warning", "⚠ ")}${item.text}${ctx.ui.theme.fg("muted", reason)}`;
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function getAvailableToolNames(names: string[]): string[] {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		return names.filter((name) => available.has(name));
	}

	function restoreNormalTools(): void {
		const restored = previousActiveTools?.length ? previousActiveTools : FALLBACK_NORMAL_MODE_TOOLS;
		pi.setActiveTools(getAvailableToolNames(restored.filter((name) => name !== PLAN_PROGRESS_TOOL)));
	}

	function enableExecutionTools(): void {
		const restored = previousActiveTools?.length ? previousActiveTools : FALLBACK_NORMAL_MODE_TOOLS;
		pi.setActiveTools(getAvailableToolNames([...new Set([...restored, PLAN_PROGRESS_TOOL])]));
	}

	function disablePlanProgressTool(): void {
		const active = pi.getActiveTools();
		if (active.includes(PLAN_PROGRESS_TOOL)) {
			pi.setActiveTools(active.filter((name) => name !== PLAN_PROGRESS_TOOL));
		}
	}

	function formatProgressList(): string {
		if (todoItems.length === 0) return "No active plan steps.";
		return todoItems
			.map((item) => {
				const mark = item.completed ? "x" : item.blocked ? "!" : " ";
				const reason = item.blocked && item.blockReason ? ` — blocked: ${item.blockReason}` : "";
				return `[${mark}] ${item.step}. ${item.text}${reason}`;
			})
			.join("\n");
	}

	function finishExecution(ctx: ExtensionContext, reason?: string): void {
		const completedList = todoItems
			.map((t) => {
				if (t.completed) return `~~${t.text}~~`;
				if (t.blocked) return `⚠ ${t.text}${t.blockReason ? ` — ${t.blockReason}` : ""}`;
				return `☐ ${t.text}`;
			})
			.join("\n");
		const allComplete = todoItems.length > 0 && todoItems.every((t) => t.completed);
		pi.sendMessage(
			{
				customType: allComplete ? "plan-complete" : "plan-finished",
				content: allComplete
					? `**Plan Complete!** ✓\n\n${completedList}`
					: `**Plan Execution Finished**${reason ? ` — ${reason}` : ""}\n\n${completedList}`,
				display: true,
			},
			{ triggerTurn: false },
		);
		executionMode = false;
		todoItems = [];
		lastPlanText = null;
		clearContextExecution = false;
		progressUpdatedThisTurn = false;
		restoreNormalTools();
		updateStatus(ctx);
		persistState();
	}

	function completeStep(step: number, ctx: ExtensionContext): string {
		const item = todoItems.find((t) => t.step === step);
		if (!executionMode || todoItems.length === 0) return "Error: no plan is currently executing.";
		if (!item) return `Error: step ${step} not found.\n\n${formatProgressList()}`;
		if (item.completed) return `Step ${step} was already complete.\n\n${formatProgressList()}`;

		item.completed = true;
		item.blocked = false;
		item.blockReason = undefined;
		progressUpdatedThisTurn = true;
		updateStatus(ctx);
		persistState();

		if (todoItems.every((t) => t.completed)) {
			finishExecution(ctx);
			return `Completed step ${step}. All plan steps are complete.`;
		}

		return `Completed step ${step}.\n\n${formatProgressList()}`;
	}

	function blockStep(step: number, reason: string | undefined, ctx: ExtensionContext): string {
		const item = todoItems.find((t) => t.step === step);
		if (!executionMode || todoItems.length === 0) return "Error: no plan is currently executing.";
		if (!item) return `Error: step ${step} not found.\n\n${formatProgressList()}`;

		item.blocked = true;
		item.blockReason = reason?.trim() || "No reason provided";
		progressUpdatedThisTurn = true;
		updateStatus(ctx);
		persistState();
		return `Marked step ${step} blocked: ${item.blockReason}\n\n${formatProgressList()}`;
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];
		lastPlanText = null;
		clearContextExecution = false;

		if (planModeEnabled) {
			previousActiveTools = pi.getActiveTools();
			const planTools = getAvailableToolNames(PLAN_MODE_TOOLS);
			pi.setActiveTools(planTools);
			ctx.ui.notify(`Plan mode enabled. Tools: ${planTools.join(", ")}`);
		} else {
			restoreNormalTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			previousActiveTools,
			lastPlanText,
			clearContextExecution,
		});
	}

	function resetTodoCompletion(items: TodoItem[]): TodoItem[] {
		return items.map((item, index) => ({
			step: index + 1,
			text: item.text,
			completed: false,
			blocked: false,
			blockReason: undefined,
		}));
	}

	function buildExecutionPrompt(clearContext: boolean): string {
		const sourcePlan = lastPlanText?.trim();
		const tasks = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
		const planBlock = sourcePlan || (tasks ? `## Tasks (Ordered)\n${tasks}` : "the plan from plan mode");
		const prefix = clearContext
			? "Prior planning context was cleared. Execute this plan now."
			: "Execute the plan.";
		return `${prefix}\n\n${planBlock}`;
	}

	function startPlanExecution(ctx: ExtensionContext, clearContext: boolean): void {
		if (todoItems.length === 0 && !lastPlanText?.trim()) {
			ctx.ui.notify("No plan found to execute.", "warning");
			return;
		}

		planModeEnabled = false;
		executionMode = todoItems.length > 0;
		clearContextExecution = clearContext;
		progressUpdatedThisTurn = false;
		if (clearContextExecution) {
			todoItems = resetTodoCompletion(todoItems);
		}
		if (executionMode) {
			enableExecutionTools();
		} else {
			restoreNormalTools();
		}
		updateStatus(ctx);
		persistState();

		const execMessage = clearContext
			? `${buildExecutionPrompt(true)}\n\nDo not regenerate or restate the plan. Start implementing step 1 now.`
			: todoItems.length > 0
				? `Execute the plan. Start with: ${todoItems[0].text}`
				: "Execute the plan you just created.";
		pi.sendMessage(
			{ customType: "plan-mode-execute", content: execMessage, display: true },
			{ triggerTurn: true },
		);
	}

	async function clearContextAndExecutePlan(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		startPlanExecution(ctx, true);
	}

	pi.registerTool({
		name: PLAN_PROGRESS_TOOL,
		label: "Plan progress",
		description:
			"Execution-only tool for updating plan progress. Use list to inspect steps, complete immediately after finishing a step, block when a step cannot continue, and finish when execution should end.",
		promptSnippet:
			"During plan execution, call plan_progress immediately after each completed or blocked step. Do not rely on text-only progress markers.",
		promptGuidelines: [
			"Only use plan_progress while executing a plan.",
			"Call action='complete' with the step number immediately after finishing that step.",
			"Call action='block' with the step number and reason when a step cannot be completed.",
			"Use action='list' to inspect current plan state before continuing if unsure.",
			"Use action='finish' only after all work is complete or execution must stop because steps are blocked.",
		],
		parameters: PlanProgressParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!executionMode) {
				return {
					content: [{ type: "text", text: "Error: plan_progress is only available while a plan is executing." }],
					details: { action: params.action, executing: false, todos: [...todoItems] },
				};
			}

			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: formatProgressList() }],
						details: { action: "list", executing: executionMode, todos: [...todoItems] },
					};

				case "complete": {
					if (params.step === undefined) {
						return {
							content: [{ type: "text", text: "Error: step is required for complete." }],
							details: { action: "complete", executing: executionMode, todos: [...todoItems], error: "step required" },
						};
					}
					const text = completeStep(params.step, ctx);
					return {
						content: [{ type: "text", text }],
						details: { action: "complete", step: params.step, executing: executionMode, todos: [...todoItems] },
					};
				}

				case "block": {
					if (params.step === undefined) {
						return {
							content: [{ type: "text", text: "Error: step is required for block." }],
							details: { action: "block", executing: executionMode, todos: [...todoItems], error: "step required" },
						};
					}
					const text = blockStep(params.step, params.reason, ctx);
					return {
						content: [{ type: "text", text }],
						details: { action: "block", step: params.step, reason: params.reason, executing: executionMode, todos: [...todoItems] },
					};
				}

				case "finish": {
					progressUpdatedThisTurn = true;
					const reason = params.reason?.trim();
					finishExecution(ctx, reason || undefined);
					return {
						content: [{ type: "text", text: reason ? `Plan execution finished: ${reason}` : "Plan execution finished." }],
						details: { action: "finish", executing: executionMode, todos: [...todoItems], reason },
					};
				}
			}
		},

		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "update";
			const step = typeof args.step === "number" ? ` step ${args.step}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("plan_progress ")) + theme.fg("muted", `${action}${step}`), 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-execute-clear", {
		description: "Clear context and execute the current plan",
		handler: async (_args, ctx) => clearContextAndExecutePlan(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No tasks found. Create a structured plan first with /plan", "info");
				return;
			}
			const list = todoItems
				.map((item, i) => `${i + 1}. ${item.completed ? "✓" : item.blocked ? "⚠" : "○"} ${item.text}${item.blockReason ? ` — ${item.blockReason}` : ""}`)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode.
	// For clear-context execution, keep only the execution marker and subsequent messages.
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		const withoutPlanModeContext = event.messages.filter((m) => {
			const msg = m as AgentMessage & { customType?: string };
			if (msg.customType === "plan-mode-context" || msg.customType === "plan-todo-list") return false;
			if (msg.role !== "user") return true;

			const content = msg.content;
			if (typeof content === "string") {
				return !content.includes("[PLAN MODE ACTIVE]");
			}
			if (Array.isArray(content)) {
				return !content.some(
					(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
				);
			}
			return true;
		});

		if (!clearContextExecution || !executionMode) {
			return { messages: withoutPlanModeContext };
		}

		let executeIndex = -1;
		for (let i = withoutPlanModeContext.length - 1; i >= 0; i--) {
			const msg = withoutPlanModeContext[i] as AgentMessage & { customType?: string };
			if (msg.customType === "plan-mode-execute") {
				executeIndex = i;
				break;
			}
		}

		return {
			messages: executeIndex >= 0 ? withoutPlanModeContext.slice(executeIndex) : withoutPlanModeContext,
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (executionMode) progressUpdatedThisTurn = false;

		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, ask-user
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the ask-user tool (batch questions when possible).
Do NOT include 'Other' in ask-user options; the tool appends it automatically.
Keep research grounded in the repository and allowed read-only commands.

Before writing the first plan draft, ask clarifying question(s) if anything is ambiguous.
Use the ask-user tool and batch questions in one call when possible.

Your plan MUST use exactly this structure:

## Goal
<one concise objective>

## Tasks (Ordered)
1. First concrete task in execution order
2. Second concrete task
3. ...

## Relevant Files
- path/to/file1
- path/to/file2

Rules:
- Tasks must be sequential, actionable, and ordered for execution.
- Relevant Files is required as the footer section. If paths are not known yet, use:
  - TBD after discovery
- If the draft does not match this structure, treat it as incomplete and regenerate it in the required format.

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute steps strictly in order.
You MUST call plan_progress with action="complete" and the completed step number immediately after finishing each step, before moving on.
If a step cannot continue, call plan_progress with action="block", the step number, and a concise reason.
Use plan_progress action="list" if you need to inspect current plan state.
Legacy [DONE:n] text markers are only a backward-compatible fallback; do not rely on them for primary progress tracking.
Update progress incrementally as you work.`,
					display: false,
				},
			};
		}
	});

	// Track legacy text-marker progress after each turn as a fallback.
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		for (const step of extractDoneSteps(text)) {
			const item = todoItems.find((t) => t.step === step);
			if (item && !item.completed) {
				completeStep(step, ctx);
			}
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				finishExecution(ctx);
				return;
			}

			if (!progressUpdatedThisTurn) {
				const remaining = todoItems.filter((t) => !t.completed);
				pi.sendMessage(
					{
						customType: "plan-progress-reconcile",
						content: `Execution mode is still active, but no structured progress update was recorded this turn. Before stopping or summarizing, call plan_progress for any completed step(s), or call plan_progress with action="block" for the current blocked step.\n\nRemaining steps:\n${remaining.map((t) => `${t.step}. ${t.text}`).join("\n")}`,
						display: false,
					},
					{ triggerTurn: true },
				);
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			lastPlanText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(lastPlanText);
			if (extracted.length > 0) {
				todoItems = extracted;
			}
			persistState();
		}

		// Show plan steps and prompt for next action
		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Tasks (Ordered) (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		} else {
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content:
						"No `## Tasks (Ordered)` section found. Regenerate the plan using: `## Goal`, `## Tasks (Ordered)`, and `## Relevant Files`.",
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"clear context and execute plan",
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "clear context and execute plan") {
			startPlanExecution(ctx, true);
		} else if (choice?.startsWith("Execute")) {
			startPlanExecution(ctx, false);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as {
				data?: {
					enabled: boolean;
					todos?: TodoItem[];
					executing?: boolean;
					previousActiveTools?: string[] | null;
					lastPlanText?: string | null;
					clearContextExecution?: boolean;
				};
			} | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			previousActiveTools = planModeEntry.data.previousActiveTools ?? previousActiveTools;
			lastPlanText = planModeEntry.data.lastPlanText ?? lastPlanText;
			clearContextExecution = planModeEntry.data.clearContextExecution ?? clearContextExecution;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			pi.setActiveTools(getAvailableToolNames(PLAN_MODE_TOOLS));
		} else if (executionMode) {
			enableExecutionTools();
		} else {
			disablePlanProgressTool();
		}
		updateStatus(ctx);
	});
}
