/**
 * Worker-guard harness — drives the engine's `subagent` tool
 * (core/extensions/engine/index.ts) against a fake child process that replays
 * a scripted `--mode json` event stream, plus the engine's worker `tool_call`
 * hook (core/extensions/engine/boundary.ts), to verify:
 *
 *   1. Exact-repeat state: the 3rd identical call (key order ignored) trips,
 *      3 calls with differing arguments do not.
 *   2. Turn cap: an agent with maxTurns 3 is killed at its 3rd turn and
 *      reaches the orchestrator as `BLOCKED: turn cap — ...` plus its calls.
 *   3. Not at N-1: the same agent after 2 turns is not killed; aborting it
 *      then returns its partial messages instead of throwing.
 *   4. Repeat kill: a worker issuing one call 3 times in a row is killed with
 *      `BLOCKED: repeat loop — ...`; 3 differing calls finish normally.
 *   5. Trace shape: at most 8 `→` lines, the last call last.
 *   6. Parallel and chain: a guard-killed task yields the BLOCKED text while
 *      the parallel sibling keeps its own result.
 *   7. Boundary hook: absent at depth 0; at depth 1 it blocks 2+ spellings of
 *      each root form of find/grep/rg/du/dir in bash and a root path in the
 *      find/grep/ls tools, and allows scoped and out-of-project scans. Root
 *      scans behind timeout/nohup/env/xargs/bash -c/sh -c, subshells and
 *      command substitutions are blocked; `grep -re "/" src` is allowed; the
 *      powershell tool blocks recursive root listings and Select-String over a
 *      root, and allows a non-recursive `Get-ChildItem C:\`.
 *   8. pi 0.87.1 stream: tool results arrive as `message_end` (role
 *      toolResult) beside `tool_execution_end`; each lands in the collected
 *      messages once, and the guard-kill trace still lists the calls.
 *   9. Drift detectors (core/extensions/engine/drift.ts, no model calls): a
 *      replay of a failed implement run (121 healthy calls, 79 scratch-heavy
 *      calls, 18 empty `TargetSymbol` greps) draws a no-progress nudge
 *      and a search/result nudge, with and without a Surface, for the grep
 *      tool and shell forms; read-heavy runs, repeated edit results, empty
 *      shell output, edit/check and edit/grep loops, and build output piped
 *      through grep or Select-String draw none; counters stay bounded.
 *  10. Per-child drift config: the engine hands each child PI_CONDUCTOR_DRIFT,
 *      with no-progress on only for `driftProgress: true` agents (the real
 *      implement and developer, not code-review) and the Surface prefixes of
 *      the `plan.md#<phase-id>` section the task names, read only from its
 *      own `<jobsRel>/<job-id>/` folder (never archive/ or a malformed id).
 *  11. drift-nudge extension: against a stubbed pi, the failed-run replay as
 *      tool_result events yields steer-only `[drift]` sends and no other pi
 *      or ctx call; no config, or depth 0, yields zero sends.
 *
 * Run with: node --experimental-strip-types pi/scripts/worker-guard-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import driftNudge from "../core/extensions/drift-nudge.ts";
import { PACKAGE_ROOT, discoverAgents } from "../core/extensions/engine/agents.ts";
import { DRIFT_ENV, childDriftConfig } from "../core/extensions/engine/drift-config.ts";
import engine, { newRepeatLoopState, recordToolCall } from "../core/extensions/engine/index.ts";
import {
	DRIFT_PREFIX,
	RESULT_WINDOW,
	SEARCH_WINDOW,
	isScratchPath,
	newDriftState,
	observeToolCall,
	shellSearchPattern,
} from "../core/extensions/engine/drift.ts";
import type { DriftConfig, ToolObservation } from "../core/extensions/engine/drift.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: { results: Array<{ messages: unknown[]; stopReason?: string }> };
	isError?: boolean;
}

interface CapturedTool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolResult) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
}

interface Scenario {
	calls: Array<{ name: string; args: Record<string, unknown> }>;
	/** After the calls: finish with a final text message, or keep running until killed. */
	then: "complete" | "hang";
	/** Replay pi 0.87.1's full json-mode sequence around each call instead of bare message_end events. */
	piStream?: boolean;
	/** On "complete", reply with this env var's value instead of COMPLETE. */
	echoEnv?: string;
	/** Free text riding along in the task, e.g. a `plan.md#<phase-id>` reference. */
	note?: string;
}

interface StreamMessage {
	role: string;
	toolCallId?: string;
	content?: Array<{ text?: string }>;
}

function isStreamMessage(value: unknown): value is StreamMessage {
	return typeof value === "object" && value !== null && "role" in value && typeof value.role === "string";
}

const PRODUCTS_KEY = Symbol.for("baton.products");
const ACTIVE_PRODUCT_KEY = Symbol.for("baton.activeProduct");
const RUN_TIMEOUT_MS = 15_000;

// The fake child: one assistant message per scripted call, then a final text or a hang.
const FAKE_CHILD = `
const task = process.argv[process.argv.length - 1].replace(/^Task: /, "");
const scenario = JSON.parse(task);
const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const emit = (message) => write({ type: "message_end", message });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
scenario.calls.forEach((call, i) => {
	const id = "c" + i;
	const assistant = { role: "assistant", content: [{ type: "toolCall", id, name: call.name, arguments: call.args }], usage, stopReason: "toolUse", model: "fake" };
	if (!scenario.piStream) return emit(assistant);
	// The order pi-agent-core 0.87.1's agent loop emits around one tool call.
	write({ type: "message_start", message: assistant });
	write({ type: "message_update", usage, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" } });
	emit(assistant);
	write({ type: "tool_execution_start", toolCallId: id, toolName: call.name, args: call.args });
	const result = { content: [{ type: "text", text: "result " + i }], details: {} };
	write({ type: "tool_execution_end", toolCallId: id, toolName: call.name, result, isError: false });
	const toolResult = { role: "toolResult", toolCallId: id, toolName: call.name, content: result.content, details: {}, isError: false, timestamp: 0 };
	write({ type: "message_start", message: toolResult });
	emit(toolResult);
	write({ type: "turn_end", message: assistant, toolResults: [toolResult] });
});
if (scenario.then === "complete") {
	const text = scenario.echoEnv ? String(process.env[scenario.echoEnv]) : "COMPLETE";
	emit({ role: "assistant", content: [{ type: "text", text }], usage, stopReason: "stop", model: "fake" });
} else {
	setInterval(() => {}, 1000);
}
`;

function textOf(result: ToolResult): string {
	return result.content[0]?.text ?? "";
}

function distinctReads(count: number): Scenario["calls"] {
	return Array.from({ length: count }, (_v, i) => ({ name: "read", args: { path: `src/file-${i}.ts` } }));
}

function task(scenario: Scenario): string {
	return JSON.stringify(scenario);
}

// Deliberately outside the OS temp dir, which the drift module treats as scratch.
const DRIFT_CWD = path.resolve("/work/proj");

interface Nudge {
	index: number;
	message: string;
}

function observation(toolName: string, input: Record<string, unknown>, resultText: string, isError = false): ToolObservation {
	return { toolName, input, resultText, isError };
}

function replayDrift(config: Partial<DriftConfig>, calls: ToolObservation[]): Nudge[] {
	const state = newDriftState({ noProgress: true, cwd: DRIFT_CWD, surface: [], ...config });
	const nudges: Nudge[] = [];
	calls.forEach((call, index) => {
		const message = observeToolCall(state, call);
		if (message !== undefined) nudges.push({ index, message });
	});
	return nudges;
}

/** 121 calls: an edit under crates/ every 15 calls (the last at call 112), varied reads, searches and checks. */
function healthyCalls(): ToolObservation[] {
	return Array.from({ length: 121 }, (_v, i) => {
		const file = `crates/app/src/part_${i}.rs`;
		if (i % 15 === 6) return observation("edit", { path: file, edits: [] }, `Successfully replaced text in ${file}.`);
		if (i % 5 === 0) return observation("grep", { pattern: `fn system_${i}`, path: "crates" }, `${file}:${i}: fn system_${i}() {`);
		if (i % 5 === 3) return observation("bash", { command: `cargo check -p app --lib # ${i}` }, `Finished dev profile in ${i}.4s`);
		return observation("read", { path: file }, `// part ${i}\npub fn part_${i}() {}`);
	});
}

/** 79 calls with no crates/ edit: 53 on tools/tmp_* scripts, 13 on a scratch cargo project, 13 reads. */
function scratchCalls(): ToolObservation[] {
	return Array.from({ length: 79 }, (_v, k) => {
		const script = `tools/tmp_probe_${k}.py`;
		if (k % 3 === 0) return observation("write", { path: script, content: "print(1)" }, `Successfully wrote 8 bytes to ${script}`);
		if (k % 3 === 1) return observation("bash", { command: `python ${script}` }, `probe ${k}: value=${k * 3}`);
		if (k % 6 === 2) return observation("write", { path: `scratch_tmp/src/main_${k}.rs`, content: "fn main() {}" }, `Successfully wrote 12 bytes`);
		return observation("read", { path: `crates/core/src/item_${k}.rs` }, `// item ${k}`);
	});
}

/** 18 empty searches for one symbol over different paths, as the grep tool or a shell command. */
function symbolGreps(form: "grep" | "bash"): ToolObservation[] {
	return Array.from({ length: 18 }, (_v, j) => {
		const dir = `crates/mod_${j}`;
		if (form === "grep") return observation("grep", { pattern: "TargetSymbol", path: dir }, "No matches found");
		return observation("bash", { command: `grep -rn "TargetSymbol" ${dir}` }, "(no output)\n\nCommand exited with code 1", true);
	});
}

interface DriftSend {
	message: unknown;
	options: unknown;
}

/** A stub whose every property is a function recording `<label>.<name>` in `calls`, except the ones in `own`. */
function recordingStub<T>(label: string, calls: string[], own: Record<string, unknown>): T {
	const target = {};
	return new Proxy(target, {
		get: (_t, prop) =>
			typeof prop === "string" && Object.hasOwn(own, prop)
				? own[prop]
				: (): void => {
						calls.push(`${label}.${String(prop)}`);
					},
	}) as T;
}

/** Load the drift-nudge extension against a stubbed pi, feed each observation as a tool_result event, release its claim. */
function replayNudgeExtension(calls: ToolObservation[]): { sends: DriftSend[]; otherCalls: string[] } {
	const sends: DriftSend[] = [];
	const otherCalls: string[] = [];
	const handlers = new Map<string, Handler[]>();
	const pi = recordingStub<ExtensionAPI>("pi", otherCalls, {
		on: (name: string, handler: Handler): void => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendUserMessage: (message: unknown, options: unknown): void => {
			sends.push({ message, options });
		},
	});
	const ctx = recordingStub<ExtensionContext>("ctx", otherCalls, { cwd: DRIFT_CWD, hasUI: false });
	driftNudge(pi);
	calls.forEach(({ toolName, input, resultText, isError }, i) => {
		const event = { type: "tool_result", toolCallId: `t${i}`, toolName, input, content: [{ type: "text", text: resultText }], isError };
		for (const handler of handlers.get("tool_result") ?? []) void handler(event, ctx);
	});
	for (const handler of handlers.get("session_shutdown") ?? []) void handler({ type: "session_shutdown" }, ctx);
	return { sends, otherCalls };
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter((w) => w !== "").length;
}

/** Load the engine against a fake pi at the current spawn depth; releases its load-guard claim before returning. */
function loadEngine(): { tools: CapturedTool[]; toolCallHandlers: Handler[] } {
	const tools: CapturedTool[] = [];
	const toolCallHandlers: Handler[] = [];
	const shutdown: Handler[] = [];
	const pi = {
		on: (name: string, handler: Handler): void => {
			if (name === "session_shutdown") shutdown.push(handler);
			if (name === "tool_call") toolCallHandlers.push(handler);
		},
		registerTool: (tool: CapturedTool): void => {
			tools.push(tool);
		},
		registerCommand: (): void => {},
		registerFlag: (): void => {},
		getFlag: (): undefined => undefined,
	} as unknown as ExtensionAPI;
	engine(pi);
	for (const handler of shutdown) void handler({ type: "session_shutdown" }, {});
	return { tools, toolCallHandlers };
}

async function main(): Promise<void> {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "worker-guard-harness-"));
	const originalArgv1 = process.argv[1];
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalDepth = process.env.PI_CONDUCTOR_SPAWN_DEPTH;
	const originalDrift = process.env[DRIFT_ENV];
	const channel = globalThis as Record<symbol, unknown>;
	try {
		// 1. Exact-repeat state.
		{
			const state = newRepeatLoopState();
			assert.equal(recordToolCall(state, "read", { path: "a", limit: 5 }), false);
			assert.equal(recordToolCall(state, "read", { limit: 5, path: "a" }), false, "key order must not matter");
			assert.equal(recordToolCall(state, "read", { path: "a", limit: 5 }), true, "the 3rd identical call trips");
			const differing = newRepeatLoopState();
			for (const p of ["a", "b", "c"]) assert.equal(recordToolCall(differing, "read", { path: p }), false);
			const interrupted = newRepeatLoopState();
			recordToolCall(interrupted, "read", { path: "a" });
			recordToolCall(interrupted, "read", { path: "a" });
			recordToolCall(interrupted, "ls", { path: "." });
			assert.equal(recordToolCall(interrupted, "read", { path: "a" }), false, "an intervening call resets the streak");
			console.log("  [1] repeat state trips on the 3rd identical call only");
		}

		// Fake product, agents and child process for the engine's subagent tool.
		const agentsDir = path.join(scratch, "agents");
		fs.mkdirSync(agentsDir);
		fs.writeFileSync(
			path.join(agentsDir, "capped.md"),
			"---\r\nname: capped\r\ndescription: capped worker\r\nmaxTurns: 3\r\n---\r\nWork.\r\n",
		);
		fs.writeFileSync(path.join(agentsDir, "free.md"), "---\r\nname: free\r\ndescription: uncapped worker\r\n---\r\nWork.\r\n");
		fs.writeFileSync(
			path.join(agentsDir, "drifty.md"),
			"---\r\nname: drifty\r\ndescription: progress-tracked worker\r\ndriftProgress: true\r\n---\r\nWork.\r\n",
		);
		// The harness product's jobsRel resolves against the child's cwd (scratch); the dispatch path names the job.
		const jobsRel = path.join(".claude", "harness", "jobs");
		const jobRel = ".claude/harness/jobs/20260101-0900-a3f9";
		fs.mkdirSync(path.join(scratch, jobRel), { recursive: true });
		fs.writeFileSync(
			path.join(scratch, jobRel, "plan.md"),
			[
				"# Plan",
				"## p9-other",
				"**Surface:** `wrong/`",
				"## p9-x",
				"**Goal:** g",
				"**Surface:** `crates/app/`, `tools/{a,b}.rs` and `README`.",
				"**Out of scope:** `other/`",
				"",
			].join("\r\n"),
		);
		const fakeChild = path.join(scratch, "fake-child.mjs");
		fs.writeFileSync(fakeChild, FAKE_CHILD);
		process.argv[1] = fakeChild;
		const agentHome = path.join(scratch, "agent-home");
		fs.mkdirSync(agentHome);
		process.env.PI_CODING_AGENT_DIR = agentHome;
		delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
		channel[PRODUCTS_KEY] = new Map([
			[
				"harness",
				{
					name: "harness",
					packageRoot: scratch,
					agentsDir,
					orchestratorPromptPath: path.join(scratch, "orchestrator.md"),
					vaultDir: scratch,
					jobsRel,
				},
			],
		]);
		channel[ACTIVE_PRODUCT_KEY] = "harness";

		const rootEngine = loadEngine();
		const subagent = rootEngine.tools.find((t) => t.name === "subagent");
		assert.ok(subagent, "the engine registers the subagent tool");
		const ctx = {
			cwd: scratch,
			model: undefined,
			thinkingLevel: undefined,
			modelRegistry: { getAvailable: () => [] },
			ui: { notify: (): void => {}, confirm: async (): Promise<boolean> => true },
			hasUI: false,
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
		// The timeout aborts (and so kills) a hanging child whose guard failed to fire, turning a hang into a failed assertion.
		const run = (params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: ToolResult) => void) =>
			subagent.execute("call", params, signal ?? AbortSignal.timeout(RUN_TIMEOUT_MS), onUpdate, ctx);

		// 2. Turn cap fires at N.
		{
			const result = await run({ agent: "capped", task: task({ calls: distinctReads(3), then: "hang" }) });
			const text = textOf(result);
			assert.match(text, /^BLOCKED: turn cap — capped reached its 3-turn limit and was terminated\.\n\nLast calls:\n/);
			assert.equal(result.isError, undefined, "a guard kill is a result, not an error");
			assert.equal(result.details?.results[0]?.messages.length, 3, "the capped run keeps its messages");
			console.log("  [2] turn cap kills at N with a BLOCKED result");
		}

		// 3. Not at N-1; abort returns the partial log instead of throwing.
		{
			const controller = new AbortController();
			const result = await run({ agent: "capped", task: task({ calls: distinctReads(2), then: "hang" }) }, controller.signal, (partial) => {
				if ((partial.details?.results[0]?.messages.length ?? 0) >= 2) controller.abort();
			});
			const text = textOf(result);
			assert.doesNotMatch(text, /BLOCKED/, `N-1 turns must not trip the cap: ${text}`);
			assert.equal(text, "Agent aborted: Subagent was aborted");
			assert.equal(result.details?.results[0]?.stopReason, "aborted");
			assert.equal(result.details?.results[0]?.messages.length, 2, "the aborted run keeps its partial messages");
			console.log("  [3] N-1 turns are not capped; abort returns partial messages");
		}

		// 4 and 5. Repeat kill and trace shape.
		{
			const same = { name: "bash", args: { command: "ls src" } };
			const result = await run({ agent: "free", task: task({ calls: [...distinctReads(10), same, same, same], then: "hang" }) });
			const text = textOf(result);
			assert.match(text, /^BLOCKED: repeat loop — free issued the same bash call 3 times in a row and was terminated\.\n\nLast calls:\n/);
			const traceLines = text.split("\n").filter((line) => line.startsWith("→ "));
			assert.equal(traceLines.length, 8, "the trace is capped at 8 calls");
			assert.equal(traceLines[7], "→ $ ls src", "the trace ends with the last call");
			assert.equal(traceLines[0], "→ read src/file-5.ts");

			const differing = await run({
				agent: "free",
				task: task({ calls: [1, 2, 3].map((n) => ({ name: "bash", args: { command: `ls src/${n}` } })), then: "complete" }),
			});
			assert.equal(textOf(differing), "COMPLETE", "3 calls with differing arguments finish normally");
			console.log("  [4] repeat kill fires on the 3rd identical call, not on differing calls");
			console.log("  [5] BLOCKED text + trace of the last 8 calls");
		}

		// 6. Parallel and chain.
		{
			const same = { name: "read", args: { path: "a.ts" } };
			const looping = task({ calls: [same, same, same], then: "hang" });
			const parallel = await run({
				tasks: [
					{ agent: "free", task: looping },
					{ agent: "free", task: task({ calls: distinctReads(1), then: "complete" }) },
				],
			});
			const parallelText = textOf(parallel);
			assert.match(parallelText, /^Parallel: 1\/2 succeeded/);
			assert.match(parallelText, /### \[free\] failed \(aborted\)\n\nBLOCKED: repeat loop — /);
			assert.match(parallelText, /### \[free\] completed\n\nCOMPLETE/);

			const chain = await run({ chain: [{ agent: "free", task: looping }, { agent: "free", task: "{previous}" }] });
			assert.match(textOf(chain), /^BLOCKED: repeat loop — .*\n\nLast calls:\n(→ read a\.ts\n){2}→ read a\.ts\n\nChain stopped at step 1 \(free\)\.$/s);
			console.log("  [6] parallel and chain surface the BLOCKED text");
		}

		// 8. pi 0.87.1 stream shape (run before 7, which moves this process to depth 1).
		{
			const complete = await run({ agent: "free", task: task({ calls: distinctReads(2), then: "complete", piStream: true }) });
			assert.equal(textOf(complete), "COMPLETE");
			const messages = (complete.details?.results[0]?.messages ?? []).filter(isStreamMessage);
			assert.deepEqual(
				messages.map((m) => m.role),
				["assistant", "toolResult", "assistant", "toolResult", "assistant"],
				"each tool result is collected exactly once, in order",
			);
			assert.deepEqual(
				messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m.content?.[0]?.text]),
				[
					["c0", "result 0"],
					["c1", "result 1"],
				],
			);

			const capped = await run({ agent: "capped", task: task({ calls: distinctReads(3), then: "hang", piStream: true }) });
			assert.match(
				textOf(capped),
				/^BLOCKED: turn cap — .*\n\nLast calls:\n→ read src\/file-0\.ts\n→ read src\/file-1\.ts\n→ read src\/file-2\.ts$/,
			);
			const cappedRoles = (capped.details?.results[0]?.messages ?? []).filter(isStreamMessage).map((m) => m.role);
			assert.deepEqual(cappedRoles.slice(0, 5), ["assistant", "toolResult", "assistant", "toolResult", "assistant"]);
			console.log("  [8] pi 0.87.1 stream: tool results collected once via message_end; trace intact");
		}

		// 10. Per-child drift config (run before 7, at depth 0 like the other spawns).
		{
			const echo = async (agent: string, note: string): Promise<unknown> =>
				JSON.parse(textOf(await run({ agent, task: task({ calls: [], then: "complete", echoEnv: DRIFT_ENV, note }) })));
			assert.deepEqual(await echo("drifty", `Implement ${jobRel}/plan.md#p9-x.`), {
				agent: "drifty",
				noProgress: true,
				cwd: scratch,
				surface: ["crates/app/", "tools/"],
			});
			assert.deepEqual(await echo("drifty", `Fix ${jobRel}/issues.md#p9-x.`), {
				agent: "drifty",
				noProgress: true,
				cwd: scratch,
				surface: ["crates/app/", "tools/"],
			});
			// Only the dispatched job's own folder counts: never an archived job, a malformed job-id, or a plan outside the jobs folder.
			const planText = fs.readFileSync(path.join(scratch, jobRel, "plan.md"));
			for (const rel of [".claude/harness/jobs/archive/2026-09-30-x", ".claude/harness/jobs/current", "."]) {
				fs.mkdirSync(path.join(scratch, rel), { recursive: true });
				fs.writeFileSync(path.join(scratch, rel, "plan.md"), planText);
				assert.deepEqual(
					await echo("drifty", `Implement ${rel}/plan.md#p9-x.`),
					{ agent: "drifty", noProgress: true, cwd: scratch, surface: [] },
					`${rel} is not a job folder`,
				);
			}
			assert.deepEqual(await echo("drifty", "Implement plan.md#p9-x."), { agent: "drifty", noProgress: true, cwd: scratch, surface: [] });
			// A relative cwd resolves once, against ctx.cwd, for both the spawn and the config (plan.md read from there too).
			const sub = path.join(scratch, "sub");
			fs.mkdirSync(path.join(sub, jobRel), { recursive: true });
			fs.writeFileSync(path.join(sub, jobRel, "plan.md"), planText);
			const relative = await run({
				agent: "drifty",
				cwd: "sub",
				task: task({ calls: [], then: "complete", echoEnv: DRIFT_ENV, note: `Implement ${jobRel}/plan.md#p9-x.` }),
			});
			assert.deepEqual(JSON.parse(textOf(relative)), {
				agent: "drifty",
				noProgress: true,
				cwd: sub,
				surface: ["crates/app/", "tools/"],
			});
			assert.deepEqual(await echo("free", `Review ${jobRel}/plan.md#p9-missing.`),{ agent: "free", noProgress: false, cwd: scratch, surface: [] });
			assert.deepEqual(await echo("drifty", "no plan section"), { agent: "drifty", noProgress: true, cwd: scratch, surface: [] });

			const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
			const noProgressOf = (product: string, name: string): boolean => {
				const found = discoverAgents(scratch, "user", path.join(piRoot, product, "agents"), PACKAGE_ROOT).agents.find(
					(a) => a.name === name,
				);
				assert.ok(found !== undefined && found.source === "package", `${product}/${name} is a package agent`);
				return childDriftConfig(found.name, found.driftProgress, "task", scratch, undefined).noProgress;
			};
			assert.equal(noProgressOf("conductor", "implement"), true);
			assert.equal(noProgressOf("refuter", "developer"), true);
			assert.equal(noProgressOf("conductor", "code-review"), false);
			assert.equal(noProgressOf("refuter", "expert"), false);
			console.log("  [10] per-child drift config: no-progress for implement/developer only; Surface from the named plan section");
		}

		// 7. Boundary hook.
		{
			assert.equal(rootEngine.toolCallHandlers.length, 0, "no boundary hook at depth 0");
			process.env.PI_CONDUCTOR_SPAWN_DEPTH = "1";
			const child = loadEngine();
			assert.equal(child.toolCallHandlers.length, 1, "one boundary hook at depth 1");
			const hook = child.toolCallHandlers[0];
			const call = async (toolName: string, input: Record<string, unknown>): Promise<unknown> =>
				hook({ type: "tool_call", toolCallId: "t", toolName, input }, { cwd: path.join(scratch, "proj") });
			const blocked = async (toolName: string, input: Record<string, unknown>): Promise<void> => {
				const verdict = await call(toolName, input);
				assert.ok(
					typeof verdict === "object" && verdict !== null && "block" in verdict && verdict.block === true,
					`${toolName} ${JSON.stringify(input)} should be blocked`,
				);
			};
			const allowed = async (toolName: string, input: Record<string, unknown>): Promise<void> => {
				assert.equal(await call(toolName, input), undefined, `${toolName} ${JSON.stringify(input)} should be allowed`);
			};

			for (const command of [
				"find / -name '*.rs'",
				'find "/" -type f 2>/dev/null | head',
				"find C:\\ -name x",
				"find C:/ -name x",
				"cd x && find /c -name '*.rs'",
				"find /mnt/c/ -name x",
				"find ~ -name '*.md'",
				"find $HOME -maxdepth 9",
				"grep -rn foo /",
				"cat list | grep -r needle C:/",
				"grep -R -e needle /c/",
				"rg needle /",
				"rg -n needle 'C:\\'",
				"rg --files ~/",
				"du -sh /*",
				"sudo du -h C:\\",
				"cmd /c dir /s C:\\",
				"cmd.exe //c dir /s /b C:",
				"timeout 60 find / -name x",
				"timeout -s KILL 5m grep -rn needle C:\\",
				"nohup find / -name x &",
				"nohup rg needle /c > out.txt",
				"env find / -name x",
				"env -i LANG=C grep -r needle ~",
				"echo x | xargs grep -rl needle /",
				"cat f | xargs -0 -n1 rg needle C:/",
				"bash -c 'find / -name x'",
				'bash -lc "cd tmp && rg needle /"',
				'sh -c "du -sh /*"',
				"/bin/sh -c 'grep -r x /c/'",
				"(find / -name x)",
				"( cd tmp; du -sh C:\\ )",
				"echo $(find / -name x)",
				"for f in $(rg --files ~); do :; done",
				"echo `find / -name x`",
				"timeout 30 bash -c 'nohup find / -name x'",
				"grep -re needle /",
				"grep -rf patterns.txt /",
				'grep -r "a|b" /',
				"find / -name '*.rs' -exec grep -l x {} \\;",
				"find / \\( -name '*.ts' -o -name '*.mts' \\)",
				"grep -rn foo \\\n  /",
			]) {
				await blocked("bash", { command });
			}
			for (const target of ["/", "C:\\", "C:/", "/c", "~"]) {
				await blocked("find", { pattern: "*.rs", path: target });
				await blocked("grep", { pattern: "x", path: target });
				await blocked("ls", { path: target });
			}
			await blocked("find", { pattern: "*.md", path: "../../../../../../../../../../../../.." });

			for (const command of [
				"find . -name '*.rs'",
				"grep -rn '/' src",
				"rg -F '/' .",
				"du -sh .",
				"dir /s /b src",
				"ls /",
				"find ../claude/plugins/x/skills -name SKILL.md",
				"find /c/Users/you/proj -name x",
				"timeout 60 find . -name x",
				"nohup rg needle src &",
				"env LANG=C grep -rn needle src",
				"ls | xargs grep -l needle",
				"bash -c 'find src -name x'",
				"sh -c \"rg '/' .\"",
				"(cd src && find . -name x)",
				"echo $(rg -l needle src)",
				'grep -re "/" src',
				"rg -e / src",
				"grep -rne/ src",
				"rg --regexp=/ src",
				"grep -r -e / -e x src",
				"find . -name '*.rs' -exec grep -l x {} \\;",
				"find . \\( -name '*.ts' -o -name '*.mts' \\) -not -path '*/node_modules/*'",
				"grep -rn foo \\\n  src",
				"find . -name x \\\n  -type f",
				"rg -n needle \\\n  src",
				"rg -n needle \\\r\n  src",
			]) {
				await allowed("bash", { command });
			}
			for (const command of [
				"Get-ChildItem -Recurse C:\\",
				"gci -r C:\\",
				"ls -Recurse /",
				"dir -Recurse C:\\",
				"Get-ChildItem -Path C:\\ -Recurse",
				"GET-CHILDITEM -path:C:\\ -rec -Filter *.rs",
				"Get-ChildItem C:\\ -Depth 3",
				"Get-ChildItem -Recurse `\n  -Path C:\\",
				"Get-ChildItem -Recurse ~ | Select-String x",
				"Select-String -Path C:\\* -Pattern x",
				"sls x C:\\*",
				"cmd /c dir /s C:\\",
				'cmd.exe /C "dir /s /b C:\\"',
				"rg needle C:\\",
				"$x = Get-ChildItem -Recurse C:\\",
				"$x=gci -r C:\\",
				"$files += dir -Recurse /",
				"foreach ($f in Get-ChildItem -Recurse C:\\) { $f }",
				"foreach ($f in gci -r C:\\) {}",
				"$r = sls x -Path C:\\*",
				"$r=Select-String -Pattern x C:\\*",
				"Get-ChildItem -Recurse:$true C:\\",
				"Get-ChildItem -Recurse:$TRUE / ",
			]) {
				await blocked("powershell", { command });
			}
			for (const command of [
				"Get-ChildItem C:\\",
				"gci C:/",
				"gci -r src",
				"ls /",
				"Get-ChildItem -Recurse -Path .\\src",
				"dir C:\\Users\\you\\proj -Recurse",
				"Select-String -Pattern / -Path src\\*.ts",
				"sls '/' src",
				"$x = Get-ChildItem C:\\",
				"$x = gci -r src",
				"foreach ($f in gci -r src) { $f }",
				"$r = sls x -Path src\\*",
				"Get-ChildItem -Recurse:$false C:\\",
				"gci -r:$FALSE /",
				"Get-ChildItem -Recurse -Filter / .",
				"gci -r -Include C:\\ -Exclude / src",
			]) {
				await allowed("powershell", { command });
			}
			await allowed("find", { pattern: "SKILL.md", path: "../claude/plugins/x/skills" });
			await allowed("grep", { pattern: "x" });
			await allowed("ls", { path: "~/.pi" });
			await allowed("read", { path: "../claude/plugins/x/skills/SKILL.md" });
			console.log("  [7] boundary hook: off at depth 0, blocks root scans (wrapped, subshell, powershell), allows scoped and out-of-project scans");
		}

		// 9. Drift detectors.
		{
			assert.equal(isScratchPath("tools/tmp_probe.py", DRIFT_CWD), true);
			assert.equal(isScratchPath("scratch_tmp/src/main.rs", DRIFT_CWD), true);
			assert.equal(isScratchPath("out/TEMP/x.rs", DRIFT_CWD), true, "segment match is case-insensitive");
			assert.equal(isScratchPath("../other/a.rs", DRIFT_CWD), true, "outside cwd is scratch");
			assert.equal(isScratchPath(path.join(os.tmpdir(), "x.rs"), DRIFT_CWD), true, "the OS temp dir is scratch");
			assert.equal(isScratchPath("crates/a.rs", path.join(os.tmpdir(), "proj")), false, "a cwd under the OS temp dir is not all scratch");
			assert.equal(isScratchPath("crates/app/src/lib.rs", DRIFT_CWD), false);
			assert.equal(isScratchPath("templates/tmpl.rs", DRIFT_CWD), false, "tmp must be a whole segment or a tmp_/tmp- prefix");

			assert.equal(shellSearchPattern('cd crates && rg -n -g "*.rs" TargetSymbol src'), "TargetSymbol");
			assert.equal(shellSearchPattern("git grep -n -e Foo -- crates"), "Foo");
			assert.equal(shellSearchPattern('findstr /s /i /c:"Target Symbol" *.rs'), '"Target Symbol"');
			assert.equal(shellSearchPattern("Get-ChildItem -Recurse crates | Select-String -Path x -Pattern 'Foo'"), "'Foo'");
			assert.equal(shellSearchPattern("grep -A 3 needle src"), "needle", "a flag's value is not the pattern");
			assert.equal(shellSearchPattern("cargo check"), undefined);
			assert.equal(shellSearchPattern('grep "foo|bar" src'), '"foo|bar"', "a quoted | does not split the command");
			assert.equal(shellSearchPattern("rg 'a|b' crates"), "'a|b'");
			assert.equal(shellSearchPattern('cargo build 2>&1 | grep -E "^(error|warning)"'), undefined, "a piped grep filters output");
			assert.equal(shellSearchPattern("cargo test 2>&1 | Select-String FAIL"), undefined, "a piped Select-String filters output");

			for (const surface of [["crates/"], []]) {
				for (const form of ["grep", "bash"] as const) {
					const label = `surface ${JSON.stringify(surface)}, ${form} form`;
					const nudges = replayDrift({ surface }, [...healthyCalls(), ...scratchCalls(), ...symbolGreps(form)]);
					for (const { message } of nudges) {
						assert.ok(message.startsWith(`${DRIFT_PREFIX} `), `${label}: prefixed: ${message}`);
						assert.ok(wordCount(message) <= 50, `${label}: at most 50 words: ${message}`);
						assert.match(message, /write your result as BLOCKED with what is missing under Gaps\.$/);
					}
					assert.equal(nudges.filter((n) => n.index < 121).length, 0, `${label}: no nudge in the healthy calls`);
					const noProgress = nudges.find((n) => n.index >= 121);
					assert.ok(noProgress !== undefined && noProgress.index < 121 + 40, `${label}: no-progress nudge by call 40 of the stretch`);
					assert.match(noProgress.message, /^\[drift\] 40 tool calls since your last edit to the task's files; 16 writes in that stretch went to scratch/);
					const search = nudges.find((n) => n.index >= 200);
					assert.ok(search !== undefined && search.index < 205, `${label}: search or result nudge within the first 5 greps`);
					assert.match(search.message, /searched for "targetsymbol"|returned the same result/);
				}
			}

			// "No matches found" is not a repeated result, so near-repeat search fires at 5 of 10, then again once 5 more greps pass the 8-call cooldown.
			const greps = replayDrift({ noProgress: false }, symbolGreps("grep"));
			assert.deepEqual(
				greps.map((n) => n.index + 1),
				[5, 13],
			);
			assert.match(greps[0].message, /^\[drift\] You searched for "targetsymbol" in 5 of your last 10 tool calls\./);
			assert.match(greps[1].message, /^\[drift\] You searched for "targetsymbol" in 10 of your last 10 tool calls\./);
			// Unrelated searches and checks that come back empty share pi's sentinel text; that is not a repeated result.
			const emptyGreps = Array.from({ length: 8 }, (_v, i) =>
				i % 2 === 0
					? observation("read", { path: `crates/p${i}/src/lib.rs` }, `// crate ${i}`)
					: observation("grep", { pattern: `caller_${i}`, path: "crates" }, "No matches found"),
			);
			const emptyChecks = [
				"git grep -n maxTurns -- pi/core",
				"git grep -n -e readStallLimit -e triage -- pi/core",
				"git diff HEAD~1 -- pi/core | grep -E 'kill|abort'",
				"test -f pi/core/missing.ts",
			].map((command) => observation("bash", { command }, "(no output)\n\nCommand exited with code 1", true));
			for (const [label, calls] of [["empty grep results", emptyGreps], ["empty failing shell checks", emptyChecks]] as const) {
				assert.deepEqual(replayDrift({ noProgress: false, surface: [] }, calls), [], `${label}: no nudge`);
			}

			const readHeavy = Array.from({ length: 60 }, (_v, i) =>
				i % 4 === 0
					? observation("grep", { pattern: `impl Plugin for P${i}` }, `crates/p${i}/src/lib.rs:1: impl Plugin for P${i}`)
					: observation("read", { path: `crates/p${i}/src/lib.rs` }, `// crate ${i}`),
			);
			assert.deepEqual(replayDrift({ noProgress: false }, readHeavy), [], "a read-heavy run with no-progress off draws no nudge");
			assert.equal(replayDrift({ noProgress: true }, readHeavy).length, 1, "the same run with no-progress on nudges once, at call 40");

			const sameEdit = Array.from({ length: 12 }, () =>
				observation("edit", { path: "crates/app/src/lib.rs", edits: [] }, "Successfully replaced text in crates/app/src/lib.rs."),
			);
			assert.deepEqual(replayDrift({ surface: ["crates/"] }, sameEdit), [], "identical edit results draw no nudge");

			const quietShell = Array.from({ length: 16 }, (_v, i) =>
				i % 2 === 0
					? observation("bash", { command: `mkdir -p out/dir_${i}` }, "(no output)")
					: observation("powershell", { command: `New-Item -Force out\\f${i}.txt | Out-Null` }, "  "),
			);
			assert.deepEqual(replayDrift({ noProgress: false }, quietShell), [], "empty shell output draws no nudge");
			// An edit/check loop whose check output is byte-stable is progress, whether or not no-progress is on.
			const editCheck = Array.from({ length: 16 }, (_v, i) =>
				i % 2 === 0
					? observation("edit", { path: `crates/app/src/a${i}.rs`, edits: [] }, `Successfully replaced text in crates/app/src/a${i}.rs.`)
					: observation("bash", { command: "cargo test -p app" }, "All 12 tests passed."),
			);
			for (const surface of [["crates/"], []]) {
				for (const noProgress of [true, false]) {
					assert.deepEqual(replayDrift({ surface, noProgress }, editCheck), [], `edit/check loop, surface ${JSON.stringify(surface)}, noProgress ${noProgress}: no nudge`);
				}
			}
			// Build/test output filtered through a piped grep or Select-String is not a codebase search.
			const filteredChecks: Array<[string, string]> = [
				["bash", 'cargo build 2>&1 | grep -E "^(error|warning)"'],
				["powershell", "cargo test 2>&1 | Select-String FAIL"],
			];
			for (const [shell, command] of filteredChecks) {
				const loop = Array.from({ length: 20 }, (_v, i) =>
					i % 2 === 0
						? observation("edit", { path: `crates/app/src/m${i}.rs`, edits: [] }, `Successfully replaced text in crates/app/src/m${i}.rs.`)
						: observation(shell, { command }, `error[E0308]: mismatched types at crates/app/src/m${i - 1}.rs:${i}`),
				);
				for (const surface of [["crates/"], []]) {
					for (const noProgress of [true, false]) {
						assert.deepEqual(replayDrift({ surface, noProgress }, loop), [], `${shell} filtered check loop, surface ${JSON.stringify(surface)}, noProgress ${noProgress}: no nudge`);
					}
				}
			}
			// An edit/grep loop (chasing one symbol's call sites) repeats the pattern while making progress.
			const renameLoop = Array.from({ length: 20 }, (_v, i) =>
				i % 2 === 0
					? observation("edit", { path: `crates/app/src/r${i}.rs`, edits: [] }, `Successfully replaced text in crates/app/src/r${i}.rs.`)
					: observation("grep", { pattern: "old_name", path: "crates" }, `crates/app/src/r${i + 1}.rs:1: old_name()`),
			);
			assert.deepEqual(replayDrift({ surface: ["crates/"], noProgress: false }, renameLoop), [], "edit/grep loop: no nudge");
			// Counters hold only keys still in their window.
			const longRun = newDriftState({ noProgress: true, cwd: DRIFT_CWD, surface: [] });
			for (let i = 0; i < 1000; i++) {
				observeToolCall(longRun, observation("grep", { pattern: `symbol_${i}` }, `crates/a/src/f${i}.rs:1: symbol_${i}`));
			}
			assert.ok(longRun.searchCounts.size <= SEARCH_WINDOW, `searchCounts bounded, got ${longRun.searchCounts.size}`);
			assert.ok(longRun.resultCounts.size <= RESULT_WINDOW, `resultCounts bounded, got ${longRun.resultCounts.size}`);
			console.log("  [9] drift: failed-run replay nudges (no-progress, then search/result), quiet runs draw none");
		}

		// 11. drift-nudge extension (this process is at depth 1 since case 7).
		{
			const failedRun = [...healthyCalls(), ...scratchCalls(), ...symbolGreps("grep")];
			const childConfig = { agent: "implement", noProgress: true, cwd: DRIFT_CWD, surface: ["crates/"] };
			process.env[DRIFT_ENV] = JSON.stringify(childConfig);
			const child = replayNudgeExtension(failedRun);
			assert.ok(child.sends.length >= 2, `at least two nudges, got ${child.sends.length}`);
			for (const { message, options } of child.sends) {
				assert.deepEqual(options, { deliverAs: "steer" });
				assert.ok(typeof message === "string" && message.startsWith(`${DRIFT_PREFIX} `), `prefixed: ${String(message)}`);
			}
			assert.deepEqual(
				child.sends.map(({ message }) => message),
				replayDrift({ surface: ["crates/"] }, failedRun).map(({ message }) => message),
				"the extension sends exactly what the detectors return",
			);
			assert.deepEqual(child.otherCalls, [], "no pi or ctx call besides on and sendUserMessage (nothing kills or aborts)");

			process.env.PI_CONDUCTOR_SPAWN_DEPTH = "0";
			const topLevel = replayNudgeExtension(failedRun);
			assert.deepEqual(topLevel.sends, [], "the top-level session never sends, even with config");
			process.env.PI_CONDUCTOR_SPAWN_DEPTH = "1";

			delete process.env[DRIFT_ENV];
			const unconfigured = replayNudgeExtension(failedRun);
			assert.deepEqual(unconfigured.sends, [], "no drift config, no sends");
			assert.deepEqual([...topLevel.otherCalls, ...unconfigured.otherCalls], []);
			console.log(`  [11] drift-nudge: ${child.sends.length} steer sends on the failed-run replay; none without config or at depth 0`);
		}
	} finally {
		process.argv[1] = originalArgv1;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalDepth === undefined) delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
		else process.env.PI_CONDUCTOR_SPAWN_DEPTH = originalDepth;
		if (originalDrift === undefined) delete process.env[DRIFT_ENV];
		else process.env[DRIFT_ENV] = originalDrift;
		delete channel[PRODUCTS_KEY];
		delete channel[ACTIVE_PRODUCT_KEY];
		fs.rmSync(scratch, { recursive: true, force: true });
	}

	console.log("\nAll worker-guard harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
