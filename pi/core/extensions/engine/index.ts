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
 * A child keeps this tool only if its frontmatter declares a `spawn:` allow-list;
 * the list reaches it as PI_CONDUCTOR_SPAWN_ALLOW and bounds what it may dispatch.
 * Independently of that list, PI_CONDUCTOR_SPAWN_DEPTH bounds how deep the tree
 * may nest: the root conductor is depth 0 and MAX_SPAWN_DEPTH is the first level
 * refused. PI_CONDUCTOR_PRODUCT names which product (conductor/refuter) the
 * dispatch resolved to, so the child's own agent roster and shim activation
 * stay in step with its parent (see resolveActiveProduct, product-registry.ts).
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
	PACKAGE_ROOT,
	discoverAgents,
} from "./agents.ts";
import { BOUNDARY_PROMPT_LINE, boundaryBlockReason, filesystemWideScan, isRootToolPath, powershellRootScan } from "./boundary.ts";
import { DRIFT_ENV, childDriftConfig } from "./drift-config.ts";
import { registerOrchestrator } from "./orchestrator.ts";
import { type ProductDescriptor, getActiveProductName, getProduct, listProducts } from "./product-registry.ts";
import { envSpawnDepth } from "./spawn-depth.ts";
import { registerTaskTools } from "./tasks.ts";
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
import { claimExtension } from "../load-guard.ts";

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

/** Root conductor is 0, its workers 1, their `research`/`scout` children 2 — nothing spawns beyond that. */
const MAX_SPAWN_DEPTH = 2;

/**
 * Which product's agent roster this call should use: the product a shim has
 * made active on `Symbol.for("baton.activeProduct")`, falling back to
 * PI_CONDUCTOR_PRODUCT (set by the parent on every spawned child, in case the
 * child's own shim has not activated it yet) and, failing that, the sole
 * registered product when exactly one package is loaded.
 */
function resolveActiveProduct(): { descriptor: ProductDescriptor } | { errorText: string } {
	const activeName = getActiveProductName() ?? process.env.PI_CONDUCTOR_PRODUCT;
	if (activeName !== undefined) {
		const descriptor = getProduct(activeName);
		if (descriptor !== undefined) return { descriptor };
	}
	const products = listProducts();
	if (products.length === 1) return { descriptor: products[0] };
	return { errorText: "enable a mode first: /conductor or /refuter" };
}

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
			// args is raw model JSON (unvalidated on guard-kill paths); a non-string command must not throw.
			const command = String(args.command || "...").replace(/\s*\r?\n\s*/g, " ");
			// ~10 cols for the "→ $ " prefix plus container padding; non-TTY callers get the 120-col fallback.
			const max = Math.max(60, (process.stdout.columns || 120) - 10);
			const half = Math.floor((max - 3) / 2);
			// Head+tail: commands sharing a long prefix stay distinguishable by their tail.
			const preview = command.length > max ? `${command.slice(0, half)}...${command.slice(-half)}` : command;
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
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
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
	/** Set when the engine killed the child: the turn cap or the exact-repeat guard. */
	guardKill?: GuardKill;
	/** Live t/s while streaming (set by emitUpdate, cleared on close). */
	liveTps?: number;
}

interface GuardKill {
	guard: "turn cap" | "repeat loop";
	reason: string;
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

function getResultOutput(result: SingleResult): string {
	if (result.guardKill) return formatGuardKill(result, result.guardKill);
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

/** Tool calls shown in a guard kill's trace; enough to see the loop without flooding the orchestrator. */
const GUARD_KILL_TRACE_CAP = 8;

/**
 * The orchestrator-facing text of a guard-killed run: a `BLOCKED:` line like a
 * worker's own reply, then the last calls, since the killed worker may have
 * written no result file. The orchestrator never sees tool details, so the
 * trace must live in the content.
 */
function formatGuardKill(result: SingleResult, kill: GuardKill): string {
	const calls = getDisplayItems(result.messages).filter(
		(item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall",
	);
	const lines = calls.slice(-GUARD_KILL_TRACE_CAP).map((c) => `→ ${formatToolCall(c.name, c.args, (_c, t) => t)}`);
	const trace = lines.length > 0 ? lines.join("\n") : "(no tool calls)";
	return `BLOCKED: ${kill.guard} — ${kill.reason}\n\nLast calls:\n${trace}`;
}

/** A child that issues the same tool call (name + arguments) this many times in a row is killed. */
const REPEAT_LOOP_LIMIT = 3;

/** JSON with recursively sorted object keys, so key order never changes the result. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const entries = Object.entries(value)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
	return `{${entries.join(",")}}`;
}

export interface RepeatLoopState {
	lastKey: string | null;
	streak: number;
	/** Name of the call that tripped the guard; null until then. */
	hitName: string | null;
}

export function newRepeatLoopState(): RepeatLoopState {
	return { lastKey: null, streak: 0, hitName: null };
}

/** Records one tool call in order; true exactly when the identical-call streak first reaches REPEAT_LOOP_LIMIT. */
export function recordToolCall(state: RepeatLoopState, name: string, args: unknown): boolean {
	if (state.hitName !== null) return false;
	const key = `${name}\u0000${stableStringify(args)}`;
	state.streak = key === state.lastKey ? state.streak + 1 : 1;
	state.lastKey = key;
	if (state.streak < REPEAT_LOOP_LIMIT) return false;
	state.hitName = name;
	return true;
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
 * as absolute SKILL.md paths the agent is told to read before starting.
 */
function skillsPreamble(agent: AgentConfig): string {
	if (agent.skillDirs.length === 0) return "";
	const lines = agent.skillDirs.map((dir) => `- ${path.join(dir, "SKILL.md")}`);
	return `Skills to read in full (use the read tool) before starting:\n${lines.join("\n")}\n\n`;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	productName: string,
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
		let systemPrompt = skillsPreamble(agent) + agent.systemPrompt;
		if (agent.maxTurns !== undefined) {
			systemPrompt += `\n\nTurn budget: this run is hard-capped at ${agent.maxTurns} assistant turns; the engine terminates the process at the cap. Near the end, stop starting new work and write your result from what you have.`;
		}
		systemPrompt += `\n\n${BOUNDARY_PROMPT_LINE}`;
		const tmp = await writePromptToTempFile(agent.name, systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let turnCapHit = false;
		const repeatLoop = newRepeatLoopState();
		let closeSignal: NodeJS.Signals | null = null;
		let lastLiveEmit = 0;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			// Absolute so the drift config and the spawn agree: drift.ts resolves relative paths against this cwd.
			const childCwd = path.resolve(defaultCwd, cwd ?? ".");
			const jobsRel = getProduct(productName)?.jobsRel;
			const drift = childDriftConfig(
				agent.name,
				agent.driftProgress,
				task,
				childCwd,
				jobsRel === undefined ? undefined : path.join(childCwd, jobsRel),
			);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: childCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Always set, empty included, so a grandchild never inherits its parent's allow-list.
				// PI_CONDUCTOR_PRODUCT routes the child's own subagent tool and its shim's
				// activation to the same product this dispatch resolved, even before the
				// child session sets globalThis.baton.activeProduct itself.
				env: {
					...process.env,
					PI_CONDUCTOR_SPAWN_ALLOW: allowed.join(","),
					PI_CONDUCTOR_SPAWN_DEPTH: String(envSpawnDepth() + 1),
					PI_CONDUCTOR_PRODUCT: productName,
					[DRIFT_ENV]: JSON.stringify(drift),
				},
			});
			let buffer = "";

			const terminate = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

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

				// Tool results also arrive here (role "toolResult"); tool_execution_end only repeats them, so it is not parsed.
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						subagentLiveMessageEnd(liveKey);
						currentResult.usage.turns++;
						if (agent.maxTurns !== undefined && !turnCapHit && currentResult.usage.turns >= agent.maxTurns) {
							turnCapHit = true;
							terminate();
						}
						if (repeatLoop.hitName === null) {
							for (const part of msg.content) {
								if (part.type !== "toolCall") continue;
								if (recordToolCall(repeatLoop, part.name, part.arguments)) {
									terminate();
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

			proc.on("close", (code, closedBy) => {
				if (buffer.trim()) processLine(buffer);
				subagentLiveRemove(liveKey);
				closeSignal = closedBy;
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
					terminate();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.liveTps = undefined;
		// Return, don't throw: the child ran with --no-session, so these messages are the only copy of its log.
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
			return currentResult;
		}
		// A SIGTERM-killed child can close with code null (read as 0), so the close signal is the evidence of the kill;
		// a child that finished on its own before the kill landed is not a guard kill.
		const killed = exitCode !== 0 || closeSignal !== null;
		if (!killed) return currentResult;
		// The repeat guard wins when both fire: it is the more specific diagnosis.
		if (repeatLoop.hitName !== null) {
			currentResult.stopReason = "aborted";
			currentResult.guardKill = {
				guard: "repeat loop",
				reason: `${agent.name} issued the same ${repeatLoop.hitName} call ${REPEAT_LOOP_LIMIT} times in a row and was terminated.`,
			};
		} else if (turnCapHit) {
			currentResult.stopReason = "aborted";
			currentResult.guardKill = {
				guard: "turn cap",
				reason: `${agent.name} reached its ${agent.maxTurns}-turn limit and was terminated.`,
			};
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
	if (!claimExtension(pi, "core.engine")) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Package agents ship with the active product (conductor or refuter) and are always available; user or project agents of the same name override them.",
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

			const resolvedProduct = resolveActiveProduct();
			if ("errorText" in resolvedProduct) {
				return {
					content: [{ type: "text", text: resolvedProduct.errorText }],
					details: { mode: "single", agentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}
			const product = resolvedProduct.descriptor;

			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				authedProviders: new Set(ctx.modelRegistry.getAvailable().map((m) => m.provider)),
				notify: (message, type) => ctx.ui.notify(message, type),
			};
			const discovery = discoverAgents(ctx.cwd, agentScope, product.agentsDir, PACKAGE_ROOT);
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
						product.name,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					if (result.guardKill) {
						return {
							content: [
								{ type: "text", text: `${getResultOutput(result)}

Chain stopped at step ${i + 1} (${step.agent}).` },
							],
							details: makeDetails("chain")(results),
						};
					}
					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
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
							product.name,
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
						// A throw must not reject the whole dispatch: that would discard every task's messages,
						// and the children ran with --no-session, so those are the only copy of their logs.
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
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
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
					product.name,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				if (result.guardKill) {
					return {
						content: [{ type: "text", text: getResultOutput(result) }],
						details: makeDetails("single")([result]),
					};
				}
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
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
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
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

	registerOrchestrator(pi);
	// Workers take their input from the job folder; only the root orchestrator keeps the status board.
	if (envSpawnDepth() === 0) {
		registerTaskTools(pi);
		return;
	}
	// Workers only: the root orchestrator is trusted with its own scans and gets no hook.
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const { command } = event.input;
			return filesystemWideScan(command) ? { block: true, reason: boundaryBlockReason(command) } : undefined;
		}
		if (isToolCallEventType("powershell", event)) {
			const { command } = event.input;
			return powershellRootScan(command) ? { block: true, reason: boundaryBlockReason(command) } : undefined;
		}
		if (isToolCallEventType("find", event) || isToolCallEventType("grep", event) || isToolCallEventType("ls", event)) {
			const target = event.input.path;
			if (target !== undefined && isRootToolPath(target, ctx.cwd)) return { block: true, reason: boundaryBlockReason(target) };
		}
		return undefined;
	});
}
