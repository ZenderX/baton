/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Compacts the session context at turn end after a dispatched task completed.
 *
 * A child keeps this tool only if its frontmatter declares a `spawn:` allow-list;
 * the list reaches it as PI_CONDUCTOR_SPAWN_ALLOW and bounds what it may dispatch.
 * Independently of that list, PI_CONDUCTOR_SPAWN_DEPTH bounds how deep the tree
 * may nest: the root conductor is depth 0 and MAX_SPAWN_DEPTH is the first level
 * refused.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	isToolCallEventType,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	PACKAGE_AGENTS_DIR,
	PACKAGE_ROOT,
	discoverAgents,
	getSkillRoots,
} from "./agents.ts";
import { boundaryBlockReason, boundaryRoots, filesystemWideScan, isWithinBoundary } from "./boundary.ts";
import { memoryPreamble, registerMemoryLint } from "./memory.ts";
import { registerOrchestrator } from "./orchestrator.ts";
import { TASK_STORE_ENV, completeTaskStatus, registerTaskTools, resolveTaskStorePath } from "./tasks.ts";
import {
	formatTps,
	subagentLiveDelta,
	subagentLiveKey,
	subagentLiveMessageEnd,
	subagentLiveMessageStart,
	subagentLiveRemove,
	subagentLiveStart,
	subagentLiveTps,
} from "../subagent-live.ts";

/** Keys are exhaustive over `ThinkingLevel`: a level added upstream fails to compile here instead of being silently rejected. */
const THINKING_LEVEL_SET = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} satisfies Record<ThinkingLevel, true>;

const THINKING_LEVELS = Object.keys(THINKING_LEVEL_SET);

function isThinkingLevel(value: string): value is ThinkingLevel {
	return Object.hasOwn(THINKING_LEVEL_SET, value);
}

/** Test override: forces every spawned child onto one model, ignoring each agent's `model:`. */
function envModelOverride(): string | undefined {
	return process.env.PI_CONDUCTOR_MODEL || undefined;
}

function envThinkingOverride(): ThinkingLevel | undefined {
	const value = process.env.PI_CONDUCTOR_THINKING;
	if (!value) return undefined;
	if (!isThinkingLevel(value)) {
		console.warn(`PI_CONDUCTOR_THINKING: ignoring invalid value "${value}" (expected ${THINKING_LEVELS.join("|")})`);
		return undefined;
	}
	return value;
}

/** Set by the parent conductor process on every child: the agents this child may dispatch. Unset at the top level, where no allow-list applies. */
function envSpawnAllow(): Set<string> | undefined {
	const value = process.env.PI_CONDUCTOR_SPAWN_ALLOW;
	if (value === undefined) return undefined;
	const names = value
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	return new Set(names);
}

/** Root conductor is 0, its workers 1, planning's `research` child 2 — nothing spawns beyond that. */
const MAX_SPAWN_DEPTH = 2;

/** Depth of this process in the conductor tree. Unset at the top level, where nothing has spawned us yet. */
function envSpawnDepth(): number {
	const parsed = Number.parseInt(process.env.PI_CONDUCTOR_SPAWN_DEPTH ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Set by the auto-status block when a dispatched task completed; the turn_end handler compacts the session once. */
let compactRequested = false;

/** Conductor-aware compaction guidance: keep the working model, drop raw reports. */
const COMPACT_INSTRUCTIONS =
	"Compacting a conductor session. Preserve: the conductor's working model (decisions, established facts, corrections, Conductor notes on tasks), the task list state (ids, subjects, statuses, what each task established), and pending user decisions. Discard: raw subagent reports (already distilled), redundant tool output, harness mechanics.";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
/** message_update deltas arrive per chunk; cap how often the live update re-emits. */
const LIVE_UPDATE_THROTTLE_MS = 250;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			// Head+tail: commands sharing a long prefix (the `R=<registry>; grep ...` family) stay distinguishable by their tail.
			const preview = command.length > 60 ? `${command.slice(0, 30)}...${command.slice(-30)}` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 25)}...${argsStr.slice(-25)}` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** True when the run was terminated by the repeat/cycle/read-stall guard. */
	guardKill?: boolean;
	/** Live t/s while streaming (set by emitUpdate, cleared on close). */
	liveTps?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

// One-line dispatch form; Triage and every other verb are excluded — triage dispatches must not auto-complete.
export function parseDispatchTaskId(task: string): number | undefined {
	const match = /^(Plan|Implement|Review) task #(\d+)/.exec(task);
	return match ? Number(match[2]) : undefined;
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/** Cap on the tool calls shown in a guard-kill trace appended to the LLM-visible content. */
const GUARD_KILL_TRACE_CAP = 40;

/**
 * Plain-text call trace (→ lines) of a guard-killed run. The conductor LLM
 * never sees tool details, so the trace is appended to the result's content
 * where the conductor can forward it verbatim to triage.
 */
function formatGuardKillTrace(result: SingleResult): string {
	const calls = getDisplayItems(result.messages).filter(
		(item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall",
	);
	const toShow = calls.slice(-GUARD_KILL_TRACE_CAP);
	const lines = toShow.map((c) => `→ ${formatToolCall(c.name, c.args, (_c, t) => t)}`);
	if (calls.length > toShow.length) lines.unshift(`... ${calls.length - toShow.length} earlier calls`);
	return lines.join("\n");
}

/** A child that commits the same tool call (name + arguments) this many times in a row is killed. */
const REPEAT_LOOP_LIMIT = 3;

/** Cyclic-pattern detection: the last 2p calls equal the preceding p calls (p in 2..CYCLE_PERIOD_LIMIT) means the child is looping through a fixed sequence. */
const CYCLE_PERIOD_LIMIT = 7;

/** Default read-stall budget: at or past this many consecutive read-only calls the window is checked — a task-heavy or low-distinctness window is killed. Per-agent overridable via frontmatter `readStallLimit`; 0 = exempt from the read-stall guard. */
const READ_STALL_LIMIT = 25;

/** First words of a bash segment that never write a file; `sed`/`find` are additionally gated inside isReadOnlyCall. */
const READONLY_COMMANDS = new Set([
	"ls", "dir", "grep", "rg", "ag", "sed", "cat", "head", "tail", "wc", "find", "sort", "uniq", "awk",
	"stat", "du", "df", "file", "which", "where", "pwd", "date", "echo", "printf", "type", "test", "true", "cd",
]);

/** JSON with recursively sorted object keys, so key order never changes the result. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
	return `{${entries.join(",")}}`;
}

export interface RepeatLoopState {
	lastKey: string | null;
	streak: number;
	/** Last 2*CYCLE_PERIOD_LIMIT call keys, oldest first (cyclic-pattern detection). */
	window: string[];
	/** Consecutive read-only calls; reset by any non-read-only call. */
	readStreak: number;
	/** Effective read-stall budget for this run (frontmatter `readStallLimit`); 0 = exempt from the read-stall guard. */
	readStallLimit: number;
	/** Last `readStallLimit` read-only calls, oldest first; `task` marks TaskGet/TaskList. */
	readWindow: Array<{ key: string; task: boolean }>;
	hit: boolean;
	hitName: string | null;
	hitArgs: string | null;
	/** Cycle period when a cyclic pattern (not a consecutive-identical streak) was detected. */
	hitCycle?: number;
	/** True when the read-stall limit, not the repeat limit, tripped the guard. */
	hitReadStall: boolean;
	/** Read-stall class recorded at the hit: task-store scanning vs re-reading the same targets. */
	hitReadStallClass?: "repetitive" | "dossier-heavy";
	/** Read-stall fields recorded at the hit for the kill message. */
	hitReadStallAt?: number;
	hitReadStallTask?: number;
	hitReadStallDistinct?: number;
}

export function newRepeatLoopState(readStallLimit: number = READ_STALL_LIMIT): RepeatLoopState {
	return {
		lastKey: null,
		streak: 0,
		window: [],
		readStreak: 0,
		readStallLimit,
		readWindow: [],
		hit: false,
		hitName: null,
		hitArgs: null,
		hitReadStall: false,
	};
}

/**
 * Whether a tool call only reads: `read`, `TaskGet`, `TaskList`, or a `bash`
 * command made exclusively of read-only segments. Any other tool — or a bash
 * command with a `>` file redirect, `sed -i`, or `find -delete`/`-exec` — is
 * not read-only and resets the read-stall streak (conservative).
 */
export function isReadOnlyCall(name: string, args: unknown): boolean {
	if (name === "read" || name === "TaskGet" || name === "TaskList") return true;
	if (name !== "bash") return false;
	const command = (args as { command?: unknown } | null)?.command;
	if (typeof command !== "string") return false;
	// `2>/dev/null`-style stderr drops are not file writes; any remaining `>` is.
	const remainder = command.replace(/>\/dev\/null/g, "");
	if (remainder.includes(">")) return false;
	// Split on `;`, `&&`, `||`, newlines — NOT on a lone `|`: pipelines like `grep | head` stay read-only.
	for (const raw of remainder.split(/;|&&|\|\||\n/)) {
		// A leading env-var assignment is not a command; an assignment-only segment (e.g. `R="/path"`) is read-only.
		// Trailing whitespace is optional so a trailing bare assignment (no command after it) strips to empty.
		const segment = raw.replace(/^\s*(?:\w+=\S*\s*)*/, "").trim();
		if (segment === "") continue;
		const first = segment.split(/\s+/)[0];
		if (!READONLY_COMMANDS.has(first)) return false;
		if (first === "sed" && /-i\b/.test(segment)) return false;
		if (first === "find" && (segment.includes("-delete") || segment.includes("-exec"))) return false;
	}
	return true;
}

/**
 * Records one tool call in order; returns true exactly when the streak first
 * reaches REPEAT_LOOP_LIMIT, the call completes a repeated cycle, or — at or
 * past the read-stall budget — the window of the last `readStallLimit`
 * read-only calls is task-heavy (half or more TaskGet/TaskList) or
 * low-distinctness (fewer than half distinct keys).
 */
export function recordToolCall(state: RepeatLoopState, name: string, args: unknown): boolean {
	if (state.hit) return false;
	const key = `${name}\u0000${stableStringify(args)}`;
	if (isReadOnlyCall(name, args)) {
		state.readStreak++;
		if (state.readStallLimit > 0) {
			state.readWindow.push({ key, task: name === "TaskGet" || name === "TaskList" });
			if (state.readWindow.length > state.readStallLimit) state.readWindow.shift();
		}
	} else {
		state.readStreak = 0;
		state.readWindow = [];
	}
	state.streak = key === state.lastKey ? state.streak + 1 : 1;
	state.lastKey = key;
	state.window.push(key);
	if (state.window.length > 2 * CYCLE_PERIOD_LIMIT) state.window.shift();
	if (state.streak >= REPEAT_LOOP_LIMIT) {
		state.hit = true;
		state.hitName = name;
		state.hitArgs = stableStringify(args);
		return true;
	}
	// Cyclic pattern: the last p calls equal the preceding p calls.
	const w = state.window;
	for (let p = 2; p <= CYCLE_PERIOD_LIMIT; p++) {
		if (w.length < 2 * p) break;
		let match = true;
		for (let i = 0; i < p; i++) {
			if (w[w.length - 2 * p + i] !== w[w.length - p + i]) {
				match = false;
				break;
			}
		}
		if (match) {
			state.hit = true;
			state.hitName = name;
			state.hitArgs = stableStringify(args);
			state.hitCycle = p;
			return true;
		}
	}
	if (state.readStallLimit > 0 && state.readStreak >= state.readStallLimit) {
		const taskCount = state.readWindow.filter((w) => w.task).length;
		const distinct = new Set(state.readWindow.map((w) => w.key)).size;
		if (taskCount * 2 >= state.readStallLimit || distinct * 2 < state.readStallLimit) {
			state.hit = true;
			state.hitReadStall = true;
			state.hitReadStallClass = taskCount * 2 >= state.readStallLimit ? "dossier-heavy" : "repetitive";
			state.hitReadStallAt = state.readStreak;
			state.hitReadStallTask = taskCount;
			state.hitReadStallDistinct = distinct;
			state.hitName = name;
			state.hitArgs = stableStringify(args);
			return true;
		}
	}
	return false;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Providers with at least one model in the registry's availability snapshot. */
	authedProviders: ReadonlySet<string>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

/**
 * Children get skill *descriptions* from the package manifest only when it is
 * installed; under `-e` nothing is loaded, so the `--skill` dirs are listed here
 * as absolute SKILL.md paths for the agent to read on demand, not all up front.
 */
function skillsPreamble(agent: AgentConfig): string {
	if (agent.skillDirs.length === 0) return "";
	const lines = agent.skillDirs.map((dir) => `- ${path.join(dir, "SKILL.md")}`);
	return `Skill files available to this agent — read a SKILL.md in full with the read tool only when its procedure applies, never all up front:\n${lines.join("\n")}\n\n`;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const modelOverride = envModelOverride();
	const thinkingOverride = envThinkingOverride();
	const pinnedProvider = modelOverride ? undefined : agent.model?.split("/")[0];
	// A pinned model whose provider has no credentials here spawns a child that dies on the first turn.
	const unauthedPin = pinnedProvider !== undefined && !dispatchDefaults.authedProviders.has(pinnedProvider);
	const credentialNote = unauthedPin
		? `subagent ${agent.name}: no credentials for ${pinnedProvider}; falling back to ${dispatchDefaults.model ?? "the session default"}`
		: undefined;
	if (credentialNote) dispatchDefaults.notify(credentialNote, "warning");
	const inheritsDispatchConfig = !agent.model || unauthedPin;
	const model = modelOverride ?? (unauthedPin ? dispatchDefaults.model : agent.model) ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	const thinking = thinkingOverride ?? (unauthedPin ? undefined : agent.thinking);
	if (thinking) args.push("--thinking", thinking);
	else if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	const allowed = agent.spawn ?? [];
	// `--tools` is a strict allowlist, so `subagent` must be named there too when the agent pins its tools.
	const tools =
		allowed.length > 0 && agent.tools && !agent.tools.includes("subagent")
			? [...agent.tools, "subagent"]
			: agent.tools;
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	if (allowed.length === 0) {
		// No allow-list: a child that can call `subagent` would spawn its own children without bound.
		args.push("--exclude-tools", ["subagent", ...(agent.excludeTools ?? [])].join(","));
	} else if (agent.excludeTools && agent.excludeTools.length > 0) {
		args.push("--exclude-tools", agent.excludeTools.join(","));
	}
	for (const dir of agent.skillDirs) args.push("--skill", dir);
	// Always pass --approve: this tool only exists once project trust for the tree is resolved in the parent session, and a headless child without it ignores project-local resources when no saved decision exists (pi docs/security.md) — silently losing the package's tools (`subagent`), its MCP-provided tools, and spawn allow-list/depth enforcement inside workers.
	args.push("--approve");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: credentialNote ? `${credentialNote}
` : "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const liveKey = subagentLiveKey();
	subagentLiveStart(liveKey, agentName);

	const emitUpdate = () => {
		if (onUpdate) {
			const tps = subagentLiveTps(liveKey);
			currentResult.liveTps = tps;
			onUpdate({
				content: [
					{ type: "text", text: (getFinalOutput(currentResult.messages) || "(running...)") + (tps > 0 ? ` ${formatTps(tps)}` : "") },
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		let systemPrompt =
			skillsPreamble(agent) +
			(agent.memory === "project" ? memoryPreamble(defaultCwd, agent.name, getSkillRoots(PACKAGE_ROOT)) : "") +
			agent.systemPrompt;
		if (agent.maxTurns !== undefined) {
			systemPrompt += `\n\nTurn budget: this run is hard-capped at ${agent.maxTurns} assistant turns; the conductor terminates the process at the cap. Near the end, stop starting new work and produce the final report from what you have.`;
		}
		systemPrompt += `\n\nBoundary: stay within the project root (your session cwd) and the ~/.pi config dir. Use files only within project scope; never run filesystem-wide scans (\`find /\`, \`grep -r /\`, \`rg /\`, \`du /\`, drive roots like \`C:\`) — scope every scan to the project root instead (e.g. \`find . -name "*.rs"\`). Calls outside the boundary are blocked.`;
		if (systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let turnCapHit = false;
		const repeatLoop = newRepeatLoopState(agent.readStallLimit ?? READ_STALL_LIMIT);
		let closeSignal: string | null = null;
		let lastLiveEmit = 0;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Always set, empty included, so a grandchild never inherits its parent's allow-list.
				env: {
					...process.env,
					PI_CONDUCTOR_SPAWN_ALLOW: allowed.join(","),
					PI_CONDUCTOR_SPAWN_DEPTH: String(envSpawnDepth() + 1),
					// The child must hit the parent's task store even when dispatched with another cwd.
					[TASK_STORE_ENV]: resolveTaskStorePath(defaultCwd),
				},
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") {
					subagentLiveMessageStart(liveKey);
				}

				if (event.type === "message_update") {
					// The wire omits the cumulative message on message_update; assistantMessageEvent marks an assistant stream.
					const subEvent = event.assistantMessageEvent;
					if (subEvent && typeof subEvent.delta === "string") {
						subagentLiveDelta(liveKey, subEvent.delta.length);
						const now = Date.now();
						if (now - lastLiveEmit >= LIVE_UPDATE_THROTTLE_MS) {
							lastLiveEmit = now;
							emitUpdate();
						}
					}
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						subagentLiveMessageEnd(liveKey);
						currentResult.usage.turns++;
						if (agent.maxTurns !== undefined && !turnCapHit && currentResult.usage.turns >= agent.maxTurns) {
							turnCapHit = true;
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, 5000);
						}
						if (!repeatLoop.hit) {
							for (const part of msg.content) {
								if (part.type !== "toolCall") continue;
								if (recordToolCall(repeatLoop, part.name, part.arguments)) {
									proc.kill("SIGTERM");
									setTimeout(() => {
										if (!proc.killed) proc.kill("SIGKILL");
									}, 5000);
									break;
								}
							}
						}
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				subagentLiveRemove(liveKey);
				closeSignal = signal;
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				currentResult.stderr += `spawn error: ${err.message}\n`;
				subagentLiveRemove(liveKey);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.liveTps = undefined;
		// Return, don't throw: a thrown error discards currentResult — and with it every message captured up to the kill.
		// The child ran with --no-session, so the tool result's details are the only copy of the run's log.
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
		}
		// A SIGTERM-killed child closes with code null (→ 0) on this Node/Windows, so the close signal is the only evidence of the kill.
		// Repeat-loop wins over the turn cap when both are set: it is the more specific diagnosis.
		if (repeatLoop.hit && (exitCode !== 0 || closeSignal !== null)) {
			currentResult.stopReason = "aborted";
			currentResult.guardKill = true;
			const lastCall = `${repeatLoop.hitName} ${(repeatLoop.hitArgs ?? "").slice(0, 80)}`;
			const triagePointer = " Run guard-kill triage first (dispatch triage with the call trace).";
			if (repeatLoop.hitReadStall) {
				currentResult.errorMessage =
					repeatLoop.hitReadStallClass === "dossier-heavy"
						? `Task-store scan detected: ${agent.name} made ${repeatLoop.hitReadStallAt} consecutive read-only calls, ${repeatLoop.hitReadStallTask} of them TaskGet/TaskList (last call: ${lastCall}); terminated. The worker was scanning sibling task dossiers — scope drift, not fact-gathering. Re-dispatch with a Conductor note: read only your own dossier; a missing fact belongs in Findings, not in sibling tasks.${triagePointer}`
						: `Read stall detected: ${agent.name} made ${repeatLoop.hitReadStallAt} consecutive read-only calls over ${repeatLoop.hitReadStallDistinct} distinct targets (${repeatLoop.hitReadStallTask} TaskGet/TaskList), re-reading the same targets (last call: ${lastCall}); terminated. The worker is re-verifying facts the dossier should have provided — re-dispatch with the missing facts as Conductor notes or a richer verified-facts file, a narrower scope, or a stronger model.${triagePointer}`;
			} else {
				const loopDetail = repeatLoop.hitCycle
					? `repeated the same ${repeatLoop.hitCycle}-call sequence of tool calls back to back (last call: ${lastCall})`
					: `invoked the same tool call ${REPEAT_LOOP_LIMIT} times in a row (${lastCall})`;
				currentResult.errorMessage = `Repeat loop detected: ${agent.name} ${loopDetail}; terminated. The run was stuck repeating itself — re-dispatch with a stopping rule, pre-verified facts, or a narrower scope.${triagePointer}`;
			}
		} else if (turnCapHit && (exitCode !== 0 || closeSignal !== null)) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = `Turn cap hit: ${agent.name} was terminated at its ${agent.maxTurns}-turn limit; partial output preserved. Re-dispatch with a narrower scope or raise maxTurns in the agent's frontmatter.`;
		}
		// Auto-status: a complete return from a Plan/Implement/Review dispatch mechanically completes the task.
		// Store failures must never break the dispatch; the conductor's own TaskUpdate stays valid and idempotent.
		const dispatchTaskId = parseDispatchTaskId(task);
		if (dispatchTaskId !== undefined && !isFailedResult(currentResult) && !currentResult.guardKill && !turnCapHit) {
			try {
				await completeTaskStatus(resolveTaskStorePath(defaultCwd), dispatchTaskId);
				// Set only on success: a store failure must not request a compaction.
				compactRequested = true;
			} catch (err: unknown) {
				console.warn(`Auto-status: failed to mark task #${dispatchTaskId} completed:`, err);
			}
		}
		return currentResult;
	} finally {
		// Idempotent with the close/error removals; covers a reject before the child's handlers are registered.
		subagentLiveRemove(liveKey);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Package agents (from ${PACKAGE_AGENTS_DIR}) are always available; user or project agents of the same name override them.`,
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			"If PI_CONDUCTOR_MODEL or PI_CONDUCTOR_THINKING is set in the environment, it overrides every agent's own model or thinking level.",
			"If an agent pins a model whose provider has no credentials in this session, it falls back to the session's own model and thinking level with a warning.",
			"Inside a conductor child, only the agents in its `spawn:` allow-list can be dispatched; the list is exported as PI_CONDUCTOR_SPAWN_ALLOW.",
			`Nesting is capped at ${MAX_SPAWN_DEPTH} levels below the root conductor, tracked as PI_CONDUCTOR_SPAWN_DEPTH; a call from the deepest level is refused.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				authedProviders: new Set(ctx.modelRegistry.getAvailable().map((m) => m.provider)),
				notify: (message, type) => ctx.ui.notify(message, type),
			};
			const discovery = discoverAgents(ctx.cwd, agentScope, PACKAGE_AGENTS_DIR);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const currentDepth = envSpawnDepth();
			if (currentDepth >= MAX_SPAWN_DEPTH) {
				return {
					content: [
						{
							type: "text",
							text: `Spawn depth limit reached (depth ${currentDepth} of ${MAX_SPAWN_DEPTH}); this agent cannot dispatch subagents. Report back to the agent that spawned you instead.`,
						},
					],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					isError: true,
				};
			}

			const spawnAllow = envSpawnAllow();
			if (spawnAllow) {
				const requested = new Set<string>();
				if (params.chain) for (const step of params.chain) requested.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);

				const list = Array.from(spawnAllow).join(", ") || "none";
				const denied = Array.from(requested).find((name) => !spawnAllow.has(name));
				if (denied !== undefined) {
					return {
						content: [
							{
								type: "text",
								text: `Agent "${denied}" is not in this agent's spawn allow-list (${list})`,
							},
						],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						isError: true,
					};
				}
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						const trace = result.guardKill ? `\n\nCall trace:\n${formatGuardKillTrace(result)}` : "";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${trace}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// exitCode cannot mean "running": a streaming task's result (exitCode 0) reaches
				// allResults on its first delta, so started/completed track running state instead.
				const started = new Set<number>();
				const completed = new Set<number>();

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const done = completed.size;
						let running = 0;
						const runningTpsList: string[] = [];
						for (let i = 0; i < allResults.length; i++) {
							if (!started.has(i) || completed.has(i)) continue;
							running += 1;
							runningTpsList.push(`${allResults[i].agent} ${formatTps(allResults[i].liveTps ?? 0)}`);
						}
						const runningTps = runningTpsList.join(", ");
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...${runningTps ? ` (${runningTps})` : ""}`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					started.add(index);
					try {
						const result = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							// Per-task update callback: the -1 placeholder stays authoritative (exitCode -1
							// means "running" for the renderResult guards), so copy live state into it.
							(partial) => {
								const streaming = partial.details?.results[0];
								if (streaming === undefined) return;
								allResults[index].messages = streaming.messages;
								allResults[index].liveTps = streaming.liveTps;
								emitParallelUpdate();
							},
							makeDetails("parallel"),
						);
						allResults[index] = result;
						completed.add(index);
						emitParallelUpdate();
						return result;
					} catch (err: unknown) {
						// A throw must not reject the whole dispatch: that would discard every task's details —
						// the children ran with --no-session, so details are the only copy of their logs.
						const failed: SingleResult = {
							...allResults[index],
							exitCode: 1,
							liveTps: undefined,
							stopReason: "error",
							errorMessage: err instanceof Error ? err.message : String(err),
						};
						allResults[index] = failed;
						completed.add(index);
						emitParallelUpdate();
						return failed;
					}
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					let output = getResultOutput(r);
					if (r.guardKill) output += `\n\nCall trace:\n${formatGuardKillTrace(r)}`;
					const truncated = truncateParallelOutput(output);
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${truncated}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					const trace = result.guardKill ? `\n\nCall trace:\n${formatGuardKillTrace(result)}` : "";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${trace}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 30)}...${args.task.slice(-30)}` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const tps = r.liveTps ?? 0;
					const tpsSuffix = r.exitCode === -1 && tps > 0 ? ` ${theme.fg("dim", formatTps(tps))}` : "";
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${tpsSuffix}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	registerTaskTools(pi);
	// Workers (depth ≥ 1) are mechanically confined to the project root + ~/.pi; the conductor (depth 0)
	// gets the boundary as a prompt instruction only — it legitimately reads pi docs from the npm global dir.
	pi.on("tool_call", async (event, ctx) => {
		if (envSpawnDepth() < 1) return;
		const roots = boundaryRoots(ctx.cwd);
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const resolved = path.resolve(ctx.cwd, event.input.path);
			if (!isWithinBoundary(resolved, roots)) return { block: true, reason: boundaryBlockReason(event.toolName, resolved) };
			return;
		}
		if (isToolCallEventType("find", event) || isToolCallEventType("grep", event) || isToolCallEventType("ls", event)) {
			const resolved = path.resolve(ctx.cwd, event.input.path ?? ".");
			if (!isWithinBoundary(resolved, roots)) return { block: true, reason: boundaryBlockReason(event.toolName, resolved) };
			return;
		}
		if (isToolCallEventType("bash", event) && filesystemWideScan(event.input.command)) {
			return { block: true, reason: boundaryBlockReason("bash", event.input.command) };
		}
	});
	// Manual compaction aborts the current agent operation, so it runs only at
	// turn end, when the agent is idle.
	pi.on("turn_end", async (_event, ctx) => {
		if (!compactRequested) return;
		compactRequested = false;
		try {
			ctx.compact({
				customInstructions: COMPACT_INSTRUCTIONS,
				onError: (err) => console.warn(`Post-task compaction failed:`, err),
			});
		} catch (err: unknown) {
			console.warn(`Post-task compaction failed:`, err);
		}
	});

	// A flag left by a previous session in the same process must not trigger a
	// stray compaction on the next one.
	pi.on("session_start", () => {
		compactRequested = false;
	});

	registerMemoryLint(pi, PACKAGE_ROOT);

	registerOrchestrator(pi, {
		packageRoot: PACKAGE_ROOT,
		skillRoots: () => getSkillRoots(PACKAGE_ROOT),
		discover: (cwd) => discoverAgents(cwd, "user", PACKAGE_AGENTS_DIR).agents,
	});
}
