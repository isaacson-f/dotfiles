import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskUserQuestion {
	id: string;
	prompt: string;
	options: string[];
}

interface AskUserAnswer {
	id: string;
	prompt: string;
	selected_option: string;
	notes?: string;
}

interface AskUserDetails {
	answers: AskUserAnswer[];
	cancelled: boolean;
}

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique question id (e.g. scope, priority, api_strategy)" }),
	prompt: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(Type.String(), {
		description: "Single-select options for the user. Do NOT include 'Other' (it is appended automatically).",
		minItems: 1,
	}),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask in one batch. Must contain 1-10 questions.",
		minItems: 1,
		maxItems: 10,
	}),
});

const OTHER_LABEL = "Other";

function formatQa(answers: AskUserAnswer[]): string {
	return answers
		.map((a) => {
			const answerText = a.notes ? `${a.selected_option} — ${a.notes}` : a.selected_option;
			return `Q: ${a.prompt}\nA: ${answerText}`;
		})
		.join("\n\n");
}

function validateQuestions(questions: AskUserQuestion[]): string | null {
	if (questions.length === 0) return "Error: questions cannot be empty";
	if (questions.length > 10) return "Error: at most 10 questions are allowed per ask-user call";

	const ids = new Set<string>();
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		if (!q.id?.trim()) return `Error: question ${i + 1} is missing id`;
		if (!q.prompt?.trim()) return `Error: question ${i + 1} is missing prompt`;
		if (!Array.isArray(q.options) || q.options.length === 0) {
			return `Error: question ${i + 1} must include at least one option`;
		}
		if (ids.has(q.id)) return `Error: duplicate question id: ${q.id}`;
		ids.add(q.id);
	}
	return null;
}

function isPrintableInput(data: string): boolean {
	if (!data || data.length !== 1) return false;
	const code = data.charCodeAt(0);
	return code >= 32 && code !== 127;
}

type AskOneResult = { action: "answer"; selected_option: string; notes?: string } | { action: "previous" } | null;

async function askOneQuestion(
	ctx: ExtensionContext,
	question: AskUserQuestion,
	index: number,
	total: number,
	previousAnswer?: Pick<AskUserAnswer, "selected_option" | "notes">,
): Promise<AskOneResult> {
	const options = [...question.options, OTHER_LABEL];
	const initialOptionIndex = previousAnswer ? options.indexOf(previousAnswer.selected_option) : -1;

	return ctx.ui.custom<AskOneResult>((tui, theme, _kb, done) => {
		let optionIndex = initialOptionIndex >= 0 ? initialOptionIndex : 0;
		let notesText = previousAnswer?.notes ?? "";
		let cachedLines: string[] | undefined;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleBackspace() {
			if (notesText.length > 0) {
				notesText = notesText.slice(0, -1);
				refresh();
			}
		}

		function submitNotesIfValid() {
			const trimmed = notesText.trim();
			if (!trimmed) {
				ctx.ui.notify("Notes are required when selecting Other.", "warning");
				return;
			}
			done({ action: "answer", selected_option: "Other", notes: trimmed });
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.left) && index > 0) {
				done({ action: "previous" });
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(options.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			const selected = options[optionIndex];
			const isOtherSelected = selected === OTHER_LABEL;

			if (matchesKey(data, Key.enter)) {
				if (isOtherSelected) {
					submitNotesIfValid();
				} else {
					done({ action: "answer", selected_option: selected });
				}
				return;
			}

			if (!isOtherSelected) return;

			if (data === "\u007f" || data === "\b") {
				handleBackspace();
				return;
			}

			if (isPrintableInput(data)) {
				notesText += data;
				refresh();
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", ` (${index + 1}/${total}) ${question.prompt}`));
			lines.push("");

			for (let i = 0; i < options.length; i++) {
				const selected = i === optionIndex;
				const isOther = options[i] === OTHER_LABEL;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const color = selected ? "accent" : "text";

				if (isOther) {
					add(prefix + theme.fg(color, `${i + 1}. ${options[i]}: ${notesText}`));
				} else {
					add(prefix + theme.fg(color, `${i + 1}. ${options[i]}`));
				}
			}

			lines.push("");
			const previousHint = index > 0 ? " • ← previous question" : "";
			add(theme.fg("dim", ` ↑↓ navigate • Enter select${previousHint} • Esc cancel`));
			add(theme.fg("dim", " When 'Other' is highlighted, just type notes inline"));
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

export default function askUserExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask-user",
		label: "Ask user",
		description:
			"Ask the user one or more clarification questions in a single tool call. Each question is single-select and automatically includes an 'Other' path for notes.",
		promptSnippet: "Use ask-user to batch clarifying questions and collect concise Q/A before continuing.",
		promptGuidelines: [
			"Use this tool when requirements are ambiguous or multiple decisions need user input.",
			"Batch multiple clarifications into one ask-user call instead of interrupting repeatedly.",
			"Provide specific options to reduce user effort.",
			"Single-select only. Include meaningful options in priority order.",
			"Do NOT include 'Other' in options; this tool appends it automatically.",
			"Correct: options: ['A', 'B', 'C']",
			"Avoid: options: ['A', 'B', 'Other'] (duplicates 'Other' in UI)",
			"If the user selects 'Other', notes are required.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { answers: [], cancelled: true } as AskUserDetails,
				};
			}

			const validationError = validateQuestions(params.questions);
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: { answers: [], cancelled: true } as AskUserDetails,
				};
			}

			const answers: AskUserAnswer[] = [];

			let i = 0;
			while (i < params.questions.length) {
				const q = params.questions[i];
				const result = await askOneQuestion(ctx, q, i, params.questions.length, answers[i]);

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled ask-user" }],
						details: { answers, cancelled: true } as AskUserDetails,
					};
				}

				if (result.action === "previous") {
					i = Math.max(0, i - 1);
					continue;
				}

				answers[i] = {
					id: q.id,
					prompt: q.prompt,
					selected_option: result.selected_option,
					notes: result.notes,
				};
				i++;
			}

			return {
				content: [{ type: "text", text: formatQa(answers) }],
				details: { answers, cancelled: false } as AskUserDetails,
			};
		},

		renderCall(args, theme) {
			const questions = (args.questions as AskUserQuestion[] | undefined) ?? [];
			return new Text(
				theme.fg("toolTitle", theme.bold("ask-user ")) +
					theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const answered = details.answers.length;
			return new Text(
				theme.fg("success", `✓ Collected ${answered} clarification answer${answered === 1 ? "" : "s"}`),
				0,
				0,
			);
		},
	});
}
