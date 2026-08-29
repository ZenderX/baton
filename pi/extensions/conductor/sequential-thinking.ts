/**
 * Sequential Thinking Tool
 *
 * Native reimplementation of the upstream `sequential-thinking` MCP server as
 * a first-class pi tool: same nine parameters, same state-echo response shape.
 * State lives in a closure per registration call, matching the upstream
 * server's in-memory, per-process lifetime (here: per pi session).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SequentialThinkingParams = Type.Object({
	thought: Type.String({ description: "Your current thinking step" }),
	nextThoughtNeeded: Type.Boolean({ description: "Whether another thought step is needed" }),
	thoughtNumber: Type.Integer({ minimum: 1, description: "Current thought number" }),
	totalThoughts: Type.Integer({ minimum: 1, description: "Estimated total thoughts needed" }),
	isRevision: Type.Optional(Type.Boolean({ description: "Whether this revises previous thinking" })),
	revisesThought: Type.Optional(Type.Integer({ minimum: 1, description: "Which thought is being reconsidered" })),
	branchFromThought: Type.Optional(Type.Integer({ minimum: 1, description: "Branching point thought number" })),
	branchId: Type.Optional(Type.String({ description: "Branch identifier" })),
	needsMoreThoughts: Type.Optional(Type.Boolean({ description: "If more thoughts are needed" })),
});

type SequentialThinkingArgs = {
	thought: string;
	nextThoughtNeeded: boolean;
	thoughtNumber: number;
	totalThoughts: number;
	isRevision?: boolean;
	revisesThought?: number;
	branchFromThought?: number;
	branchId?: string;
	needsMoreThoughts?: boolean;
};

type ThoughtRecord = SequentialThinkingArgs;

interface SequentialThinkingSummary {
	thoughtNumber: number;
	totalThoughts: number;
	nextThoughtNeeded: boolean;
	branches: string[];
	thoughtHistoryLength: number;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function registerSequentialThinking(pi: ExtensionAPI): void {
	const history: ThoughtRecord[] = [];
	const branches: Record<string, ThoughtRecord[]> = {};

	pi.registerTool({
		name: "sequential_thinking",
		label: "Sequential Thinking",
		description: [
			"A tool for dynamic and reflective problem-solving through a sequence of thoughts.",
			"Break a problem into steps, revise earlier thoughts, and branch into alternatives as understanding deepens.",
			"Set nextThoughtNeeded to false only once you have reached a satisfactory answer.",
		].join(" "),
		promptSnippet: "sequential_thinking: reason step by step through a multi-thought chain before acting",
		parameters: SequentialThinkingParams,

		async execute(_toolCallId, params) {
			const record: ThoughtRecord = { ...params };
			const totalThoughts = record.thoughtNumber > record.totalThoughts ? record.thoughtNumber : record.totalThoughts;
			record.totalThoughts = totalThoughts;

			history.push(record);
			if (record.branchFromThought && record.branchId) {
				const branch = branches[record.branchId] ?? (branches[record.branchId] = []);
				branch.push(record);
			}

			const summary: SequentialThinkingSummary = {
				thoughtNumber: record.thoughtNumber,
				totalThoughts,
				nextThoughtNeeded: record.nextThoughtNeeded,
				branches: Object.keys(branches),
				thoughtHistoryLength: history.length,
			};

			return {
				content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
				details: summary,
			};
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("sequential_thinking ")) +
				theme.fg("accent", `${args.thoughtNumber}/${args.totalThoughts}`);
			if (args.isRevision) text += theme.fg("muted", ` rev of #${args.revisesThought ?? "?"}`);
			if (args.branchFromThought && args.branchId) text += theme.fg("muted", " [branch]");
			text += `\n  ${theme.fg("dim", truncate(args.thought, 60))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("dim", text?.type === "text" ? text.text : "(no output)"), 0, 0);
		},
	});
}
