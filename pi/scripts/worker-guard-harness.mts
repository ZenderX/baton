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
 *
 * Run with: node --experimental-strip-types pi/scripts/worker-guard-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import engine, { newRepeatLoopState, recordToolCall } from "../core/extensions/engine/index.ts";

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
	emit({ role: "assistant", content: [{ type: "text", text: "COMPLETE" }], usage, stopReason: "stop", model: "fake" });
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
					taskPlanRel: "plan.md",
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
	} finally {
		process.argv[1] = originalArgv1;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalDepth === undefined) delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
		else process.env.PI_CONDUCTOR_SPAWN_DEPTH = originalDepth;
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
