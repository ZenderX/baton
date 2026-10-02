/**
 * Task-list harness — drives core/extensions/task-list.ts together with
 * core/extensions/statusline.ts (both compose into one multi-line footer
 * through the shared footer-line registry) with a fake ExtensionAPI,
 * ExtensionContext, Theme, TUI and footer provider, plus the task tools of
 * core/extensions/engine/tasks.ts, to verify (without touching a live server
 * or the real agent dir):
 *
 *   1. Both on + a 7-task mixed-status store: 7 lines — line 0 the powerline
 *      (contains [harness-model]), lines 1-5 one task each ordered
 *      in_progress -> pending, line 6 a dim `2 more` row (no rotation
 *      indicator, no inline ` · ` separator).
 *   2. Stable window + store refresh on tick: the 3s tick leaves the task
 *      rows unchanged; a store mutation picked up on the next tick updates
 *      them (`3 more` row after an 8th task).
 *   3. <= 5 tasks: one row per task, no `more` row, completed struck through
 *      on its own row at the bottom.
 *   4. Missing store and empty store: exactly 1 line (powerline only).
 *   5. /tasklist off -> 1 line; on again -> 1 + N lines.
 *   6. /statusline off + tasklist on: exactly N lines = the task rows only
 *      (no [harness-model]).
 *   7. Both off: the footer factory is undefined (built-in restored; render
 *      throws "footer not applied").
 *   8. Active product: flags {} + globalThis baton.activeProduct set (a
 *      product shim's activation) -> 1 + N lines with the task rows.
 *  8b. Spawned child: the same with PI_CONDUCTOR_SPAWN_DEPTH=1 -> the footer
 *      stays off.
 *   9. Product transition: no product at session_start, then the refuter
 *      becomes active; turn_start auto-enables the task rows.
 *  10. Tool registration: the engine registers TaskCreate/TaskGet/TaskUpdate/
 *      TaskList at depth 0 and none of them at depth 1.
 *  11. Tool behaviour: create persists to the per-session store, an unknown
 *      addBlockedBy id rejects the update without persisting, `deleted`
 *      removes the task and every relation to it, and the last delete removes
 *      the store file.
 *  12. Narrow width: at 16 cells every task row fits the width with its
 *      subject truncated; at 7 cells the task rows hide (powerline only, or
 *      [""] with the statusline off), and they return at 8.
 *  13. Open-handle write: while another handle holds the store open for
 *      reading, TaskCreate and TaskUpdate persist; no `.tmp-` file appears.
 *  14. Parallel reads: TaskList and TaskGet called on setImmediate while a
 *      TaskUpdate is in flight never reject (no partial store is visible).
 *  15. Per-session store: two session ids in one project see disjoint lists;
 *      session_start reason `new` switches the footer to an empty list and
 *      leaves the old one intact; reason `resume` back to the first id shows
 *      its tasks again; emptying a list removes only that session's file.
 *
 * Run with: node --experimental-strip-types pi/scripts/tasklist-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOOTER_REFRESH_MS } from "../core/extensions/footer-lines.ts";
import { resolveTaskStorePath } from "../core/extensions/engine/tasks.ts";
import engine from "../core/extensions/engine/index.ts";
import statusline from "../core/extensions/statusline.ts";
import tasklist from "../core/extensions/task-list.ts";

// Mirrors extensions/engine/product-registry.ts's ACTIVE_PRODUCT_KEY: a real
// product shim writes this same globalThis slot on activation, so setting it
// directly here stands in for that shim without importing across packages.
const ACTIVE_PRODUCT_KEY = Symbol.for("baton.activeProduct");

function setActiveProduct(name: string | undefined): void {
	const channel = globalThis as Record<symbol, unknown>;
	if (name === undefined) delete channel[ACTIVE_PRODUCT_KEY];
	else channel[ACTIVE_PRODUCT_KEY] = name;
}

const PROJECT_CWD = "/home/u/proj";
const SESSION_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_SESSION_ID = "0199a1b2-c3d4-7e5f-8a9b-ffffffffffff";
const TASK_TOOL_NAMES = ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList"];

// A deliberately minimal structural subset of pi's footer component and the
// event/context/registry shapes the extensions read. Test-only seams.
interface FooterComponent {
	dispose?: () => void;
	invalidate: () => void;
	render: (width: number) => string[];
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

interface AppendedEntry {
	customType: string;
	data: unknown;
}

interface Env {
	pi: ExtensionAPI;
	fire: (name: string, event: unknown) => void;
	/** The full footer: line 0 the powerline, then one row per task (when present). */
	render: (width?: number) => string[];
	/** Fire session_shutdown (unregisters this env's shared-registry providers) and drop the component. */
	dispose: () => void;
	state: { model: unknown; contextUsage: unknown; branch: unknown[] };
	notified: string[];
	commands: Map<string, CommandHandler>;
	appended: AppendedEntry[];
	ctx: ExtensionContext;
	/** The id ctx.sessionManager.getSessionId() returns; switch it, then fire session_start, to model /new or /resume. */
	session: { id: string };
}

interface MakeEnvOptions {
	/** Flags the fake pi reports via getFlag; defaults to `{ statusline: true, tasklist: true }`. */
	flags?: Record<string, boolean>;
	/** Session entries the fake session manager returns (checks may push into it). */
	entries?: unknown[];
}

interface HarnessTask {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed";
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
}

interface CapturedTool {
	name: string;
	execute: (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<ToolResult>;
}

interface StoredTask {
	id: number;
	subject: string;
	status: string;
	blocks: number[];
	blockedBy: number[];
}

function makeModel(id: string): unknown {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "harness",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 120000,
		maxTokens: 8192,
	};
}

function writeStore(storePath: string, tasks: HarnessTask[]): void {
	fs.writeFileSync(storePath, JSON.stringify({ nextId: tasks.length + 1, tasks }), "utf8");
}

function readStoredTasks(storePath: string): StoredTask[] {
	return (JSON.parse(fs.readFileSync(storePath, "utf8")) as { tasks: StoredTask[] }).tasks;
}

function makeEnv(options: MakeEnvOptions = {}): Env {
	const { flags = { statusline: true, tasklist: true }, entries = [] } = options;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const appended: AppendedEntry[] = [];
	const notified: string[] = [];
	const session = { id: SESSION_ID };
	let footerFactory: ((t: unknown, th: unknown, fd: unknown) => FooterComponent) | undefined;

	const state: { model: unknown; contextUsage: unknown; branch: unknown[] } = { model: undefined, contextUsage: undefined, branch: [] };

	const tui = { requestRender: (): void => undefined };
	const theme = {
		fg: (_color: string, text: string): string => text,
		strikethrough: (text: string): string => `~~${text}~~`,
	};
	const footerData = { getGitBranch: (): string => "main", onBranchChange: (): (() => void) => () => undefined };

	// One live component per env (like a real session): the composite footer's
	// 3s tick keeps firing between renders, which case 2's store refresh relies on.
	let component: FooterComponent | undefined;

	const ui = {
		setFooter: (factory: unknown): void => {
			// Re-install: dispose the previously created component and store the
			// new factory; render lazily recreates the component from it.
			component?.dispose?.();
			component = undefined;
			footerFactory = factory as (t: unknown, th: unknown, fd: unknown) => FooterComponent;
		},
		notify: (message: string): void => {
			notified.push(message);
		},
	};

	const ctx = {
		get cwd(): string {
			return PROJECT_CWD;
		},
		get model(): unknown {
			return state.model;
		},
		get hasUI(): boolean {
			return true;
		},
		ui,
		sessionManager: {
			getEntries: (): unknown[] => entries,
			getBranch: (): unknown[] => state.branch,
			getSessionId: (): string => session.id,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async (): Promise<unknown> => ({ ok: true, apiKey: "local-secret", headers: {} }),
			refresh: async (): Promise<unknown> => undefined,
		},
		getContextUsage: (): unknown => state.contextUsage,
	} as unknown as ExtensionContext;

	const pi = {
		registerFlag: (): void => undefined,
		registerCommand: (name: string, spec: { description: string; handler: CommandHandler }): void => {
			commands.set(name, spec.handler);
		},
		getFlag: (name: string): boolean => flags[name] === true,
		appendEntry: (customType: string, data: unknown): void => {
			appended.push({ customType, data });
		},
		on: (name: string, handler: Handler): void => {
			const list = handlers.get(name);
			if (list === undefined) {
				handlers.set(name, [handler]);
				return;
			}
			list.push(handler);
		},
	} as unknown as ExtensionAPI;

	function fire(name: string, event: unknown): void {
		const list = handlers.get(name);
		if (list === undefined) throw new Error(`no handler registered for ${name}`);
		for (const handler of list) void handler(event, ctx);
	}

	function render(width = 200): string[] {
		if (footerFactory === undefined) throw new Error("footer not applied");
		if (component === undefined) component = footerFactory(tui, theme, footerData);
		return component.render(width);
	}

	function dispose(): void {
		// The shared footer-line registry lives on globalThis and is
		// process-wide: session_shutdown unregisters this env's providers
		// before the component is dropped, so nothing leaks into the next env.
		fire("session_shutdown", { type: "session_shutdown" });
		component?.dispose?.();
		component = undefined;
	}

	return { pi, fire, render, dispose, state, notified, ctx, commands, appended, session };
}

/** The slice of ExtensionContext the task tools read: the store is keyed by the session id, not the cwd. */
function toolCtx(sessionId: string): ExtensionContext {
	return { cwd: PROJECT_CWD, sessionManager: { getSessionId: (): string => sessionId } } as unknown as ExtensionContext;
}

/** Load the engine against a fake pi that captures registered tools; releases its load-guard claim before returning. */
function loadEngineTools(): CapturedTool[] {
	const tools: CapturedTool[] = [];
	const shutdown: Handler[] = [];
	const pi = {
		on: (name: string, handler: Handler): void => {
			if (name === "session_shutdown") shutdown.push(handler);
		},
		registerTool: (tool: CapturedTool): void => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	engine(pi);
	for (const handler of shutdown) void handler({ type: "session_shutdown" }, {} as ExtensionContext);
	return tools;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` (real clock) until true or `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000, intervalMs = 15): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await sleep(intervalMs);
	}
}

/** Both extensions into one env, session started, model set. */
async function startEnv(options: MakeEnvOptions = {}): Promise<Env> {
	const env = makeEnv(options);
	env.state.model = makeModel("harness-model");
	env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
	env.state.branch = [];
	statusline(env.pi);
	tasklist(env.pi);
	await env.fire("session_start", { type: "session_start" });
	return env;
}

async function main(): Promise<void> {
	// Redirect the agent dir to a temp dir: the task store resolves under it, and
	// the statusline's self-heal write path never touches the real ~/.pi/agent.
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasklist-harness-"));
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	const originalSpawnDepth = process.env.PI_CONDUCTOR_SPAWN_DEPTH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
	setActiveProduct(undefined);
	const taskStorePath = resolveTaskStorePath(SESSION_ID);
	assert.ok(taskStorePath.startsWith(agentDir), `the store must resolve under the temp agent dir, got: ${taskStorePath}`);
	fs.mkdirSync(path.dirname(taskStorePath), { recursive: true });

	try {
		// --- 1. Both on + 7 mixed-status tasks: one row per task, ordered, then a `2 more` row ---
		{
			writeStore(taskStorePath, [
				{ id: 1, subject: "alpha", status: "pending" },
				{ id: 2, subject: "bravo", status: "completed" },
				{ id: 3, subject: "charlie", status: "in_progress" },
				{ id: 4, subject: "delta", status: "pending" },
				{ id: 5, subject: "echo", status: "completed" },
				{ id: 6, subject: "foxtrot", status: "in_progress" },
				{ id: 7, subject: "golf", status: "pending" },
			]);
			const env = await startEnv();

			// session_start's initial refresh loads the snapshot; the window holds the first five tasks.
			await until(() => (env.render()[6] ?? "") === "2 more");
			const lines = env.render();
			assert.equal(lines.length, 7, `powerline + 5 task rows + a more row expected, got: ${JSON.stringify(lines)}`);
			assert.ok(lines[0].includes("[harness-model]"), `line 0 should be the powerline, got: ${lines[0]}`);
			assert.deepEqual(
				lines.slice(1),
				["▶ #3 charlie", "▶ #6 foxtrot", "· #1 alpha", "· #4 delta", "· #7 golf", "2 more"],
				`one row per task ordered in_progress -> pending, then the overflow row, got: ${JSON.stringify(lines)}`,
			);
			assert.ok(!lines.some((line) => line.includes("1/7")), `no rotation indicator, got: ${JSON.stringify(lines)}`);
			assert.ok(!lines.some((line) => line.includes("bravo") || line.includes("echo")), `completed tasks outside the window must not render, got: ${JSON.stringify(lines)}`);
			console.log("  [1] task rows 5 of 7, ordered:", JSON.stringify(lines.slice(1)));

			// The 3s tick leaves the static window unchanged (no rotation).
			const stable = env.render();
			await sleep(FOOTER_REFRESH_MS + 300);
			assert.deepEqual(env.render(), stable, `the tick must leave the window unchanged, got: ${JSON.stringify(env.render())}`);

			// A store mutation picked up on the next tick updates the rows.
			writeStore(taskStorePath, [
				{ id: 1, subject: "alpha", status: "pending" },
				{ id: 2, subject: "bravo", status: "completed" },
				{ id: 3, subject: "charlie", status: "in_progress" },
				{ id: 4, subject: "delta", status: "pending" },
				{ id: 5, subject: "echo", status: "completed" },
				{ id: 6, subject: "foxtrot", status: "in_progress" },
				{ id: 7, subject: "golf", status: "pending" },
				{ id: 8, subject: "hotel", status: "pending" },
			]);
			await until(() => (env.render()[6] ?? "") === "3 more", 8000);
			const lines2 = env.render();
			assert.equal(lines2.length, 7, `the window stays 5 rows + a more row, got: ${JSON.stringify(lines2)}`);
			assert.equal(lines2[6], "3 more", `the tick should pick up the 8th task with a 3 more row, got: ${JSON.stringify(lines2)}`);
			assert.equal(lines2[1], "▶ #3 charlie", `the in_progress task should still lead, got: ${JSON.stringify(lines2)}`);
			assert.ok(!lines2.some((line) => line.includes("hotel")), `the 8th task sits outside the window, got: ${JSON.stringify(lines2)}`);
			console.log("  [2] stable window, store refresh on tick:", JSON.stringify(lines2.slice(1)));
			env.dispose();
		}

		// --- 3. <= 5 tasks: one row each, no more row, completed struck through ---
		{
			writeStore(taskStorePath, [
				{ id: 1, subject: "active work", status: "in_progress" },
				{ id: 2, subject: "done thing", status: "completed" },
				{ id: 3, subject: "waiting", status: "pending" },
			]);
			const env = await startEnv();

			await until(() => env.render().length === 4);
			const lines = env.render();
			assert.deepEqual(
				lines.slice(1),
				["▶ #1 active work", "· #3 waiting", "#2 ~~done thing~~"],
				`one row per task, completed struck through at the bottom, got: ${JSON.stringify(lines)}`,
			);
			assert.ok(!lines.some((line) => line.includes("more") || line.includes("/3")), `no more row or position indicator when the store has <= 5 tasks, got: ${JSON.stringify(lines)}`);
			console.log("  [3] one row per task, completed struck through:", JSON.stringify(lines.slice(1)));
			env.dispose();
		}

		// --- 4. Missing store and empty store: exactly 1 line (powerline only) ---
		{
			fs.rmSync(taskStorePath, { force: true });
			const env = await startEnv();
			// Give the async refresh time to observe the missing file.
			await sleep(50);
			const lines = env.render();
			assert.equal(lines.length, 1, `a missing store should render the powerline line only, got: ${JSON.stringify(lines)}`);
			assert.ok(lines[0].includes("[harness-model]"), `the powerline line should still render, got: ${lines[0]}`);
			console.log("  [4] missing store renders powerline only:", lines[0]);
			env.dispose();

			fs.writeFileSync(taskStorePath, JSON.stringify({ nextId: 1, tasks: [] }), "utf8");
			const empty = await startEnv();
			await sleep(50);
			const lines2 = empty.render();
			assert.equal(lines2.length, 1, `an empty store should render the powerline line only, got: ${JSON.stringify(lines2)}`);
			console.log("  [4] empty store renders powerline only:", lines2[0]);
			empty.dispose();
		}

		// --- 5. /tasklist off -> 1 line; on again -> 1 + 3 lines ---
		{
			writeStore(taskStorePath, [
				{ id: 1, subject: "active work", status: "in_progress" },
				{ id: 2, subject: "done thing", status: "completed" },
				{ id: 3, subject: "waiting", status: "pending" },
			]);
			const env = await startEnv();
			await until(() => env.render().length === 4);

			const toggle = env.commands.get("tasklist");
			assert.ok(toggle !== undefined, "the /tasklist command handler must be captured");
			await toggle("", env.ctx);
			const lines = env.render();
			assert.equal(lines.length, 1, `/tasklist off should leave the powerline line only, got: ${JSON.stringify(lines)}`);
			assert.ok(lines[0].includes("[harness-model]"), `the powerline line should still render, got: ${lines[0]}`);
			assert.deepEqual(env.appended.at(-1), { customType: "tasklist", data: { enabled: false } }, "/tasklist off persists the toggle");
			console.log("  [5] /tasklist off leaves powerline only:", lines[0]);

			await toggle("", env.ctx);
			await until(() => env.render().length === 4);
			const lines2 = env.render();
			assert.equal(lines2[1], "▶ #1 active work", `/tasklist on again should restore the task rows, got: ${JSON.stringify(lines2)}`);
			console.log("  [5] /tasklist on restores the task rows:", JSON.stringify(lines2.slice(1)));
			env.dispose();
		}

		// --- 6. /statusline off + tasklist on: the task rows stand alone ---
		{
			writeStore(taskStorePath, [
				{ id: 1, subject: "active work", status: "in_progress" },
				{ id: 2, subject: "done thing", status: "completed" },
				{ id: 3, subject: "waiting", status: "pending" },
			]);
			const env = await startEnv();
			await until(() => env.render().length === 4);

			const toggle = env.commands.get("statusline");
			assert.ok(toggle !== undefined, "the /statusline command handler must be captured");
			await toggle("", env.ctx);
			const lines = env.render();
			assert.deepEqual(
				lines,
				["▶ #1 active work", "· #3 waiting", "#2 ~~done thing~~"],
				`/statusline off should leave the task rows only (no [harness-model]), got: ${JSON.stringify(lines)}`,
			);
			console.log("  [6] /statusline off leaves the task rows alone:", JSON.stringify(lines));
			env.dispose();
		}

		// --- 7. Both off: the built-in footer is restored ---
		{
			writeStore(taskStorePath, [
				{ id: 1, subject: "active work", status: "in_progress" },
				{ id: 2, subject: "done thing", status: "completed" },
			]);
			const env = await startEnv();
			await until(() => env.render().length === 3);

			const toggleTasklist = env.commands.get("tasklist");
			const toggleStatusline = env.commands.get("statusline");
			assert.ok(toggleTasklist !== undefined && toggleStatusline !== undefined, "both command handlers must be captured");
			await toggleTasklist("", env.ctx);
			await toggleStatusline("", env.ctx);
			assert.throws(() => env.render(), /footer not applied/, "both off restores the built-in footer");
			console.log("  [7] both off restores the built-in footer");
			env.dispose();
		}

		// --- 8. Active product: a session with a product already active enables both lines ---
		{
			assert.ok(!process.argv.includes("--conductor") && !process.argv.includes("--refuter"), "check 8 must not rely on an argv flag");
			writeStore(taskStorePath, [
				{ id: 1, subject: "active work", status: "in_progress" },
				{ id: 2, subject: "done thing", status: "completed" },
			]);
			setActiveProduct("conductor");
			try {
				const env = await startEnv({ flags: {} });
				await until(() => env.render().length === 3);
				const lines = env.render();
				assert.ok(lines[0].includes("[harness-model]"), `the active product should enable the powerline line, got: ${lines[0]}`);
				assert.deepEqual(lines.slice(1), ["▶ #1 active work", "#2 ~~done thing~~"], `the active product should enable the task rows, got: ${JSON.stringify(lines)}`);
				console.log("  [8] active product enables powerline + task rows:", JSON.stringify(lines.slice(1)));
				env.dispose();
			} finally {
				setActiveProduct(undefined);
			}
		}

		// --- 8b. Spawned child: an active product at depth 1 leaves the footer off ---
		{
			setActiveProduct("conductor");
			process.env.PI_CONDUCTOR_SPAWN_DEPTH = "1";
			try {
				const env = await startEnv({ flags: {} });
				await sleep(50);
				assert.throws(() => env.render(), /footer not applied/, "a spawned child must not auto-enable the task line");
				console.log("  [8b] spawned child leaves the footer off despite an active product");
				env.dispose();
			} finally {
				delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
				setActiveProduct(undefined);
			}
		}

		// --- 9. Off->on product transition auto-enables the task line on turn_start ---
		{
			const env = await startEnv({ flags: {} });
			assert.throws(() => env.render(), /footer not applied/, "no active product at session_start leaves the default footer");
			setActiveProduct("refuter");
			try {
				env.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
				await until(() => env.render().length === 3);
				const lines = env.render();
				assert.deepEqual(lines.slice(1), ["▶ #1 active work", "#2 ~~done thing~~"], `the refuter's activation should enable the task rows, got: ${JSON.stringify(lines)}`);
				assert.ok(env.notified.includes("Task list enabled by refuter mode."), `one task-list auto-enable notify expected, got: ${JSON.stringify(env.notified)}`);
				assert.ok(!env.appended.some(({ customType }) => customType === "tasklist"), "the auto-enable must not persist a tasklist entry");
				console.log("  [9] product transition auto-enables:", JSON.stringify(lines.slice(1)));
				env.dispose();
			} finally {
				setActiveProduct(undefined);
			}
		}

		// --- 10. Tool registration: root only ---
		{
			const rootNames = loadEngineTools().map(({ name }) => name);
			for (const name of TASK_TOOL_NAMES) assert.ok(rootNames.includes(name), `the root engine should register ${name}, got: ${rootNames.join(", ")}`);
			process.env.PI_CONDUCTOR_SPAWN_DEPTH = "1";
			try {
				const childNames = loadEngineTools().map(({ name }) => name);
				assert.ok(childNames.includes("subagent"), `the child engine still registers subagent, got: ${childNames.join(", ")}`);
				for (const name of TASK_TOOL_NAMES) assert.ok(!childNames.includes(name), `a child must not register ${name}, got: ${childNames.join(", ")}`);
			} finally {
				delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
			}
			console.log("  [10] task tools registered at depth 0 only");
		}

		// --- 11. Tool behaviour: persist, reject unknown ids, delete removes ---
		{
			fs.rmSync(taskStorePath, { force: true });
			const tools = new Map(loadEngineTools().map((tool) => [tool.name, tool]));
			const call = async (name: string, params: unknown): Promise<string> => {
				const tool = tools.get(name);
				assert.ok(tool !== undefined, `${name} must be registered`);
				const result = await tool.execute("call", params, undefined, undefined, toolCtx(SESSION_ID));
				return result.content[0]?.text ?? "";
			};

			assert.equal(await call("TaskCreate", { subject: "p1", description: "phase one" }), "Created task #1: p1");
			assert.equal(await call("TaskCreate", { subject: "Review: job", description: "review" }), "Created task #2: Review: job");
			await call("TaskUpdate", { taskId: "#2", addBlockedBy: ["1"] });
			await call("TaskUpdate", { taskId: "1", status: "in_progress" });
			let stored = readStoredTasks(taskStorePath);
			assert.deepEqual(stored.map(({ id, status }) => [id, status]), [[1, "in_progress"], [2, "pending"]], "create and update persist to the per-session store");
			assert.deepEqual(stored[1].blockedBy, [1], "addBlockedBy persists the relation");
			assert.equal(await call("TaskList", {}), "#1 [in_progress] p1\n#2 [pending] Review: job (blocked by #1)");

			await assert.rejects(call("TaskUpdate", { taskId: "2", status: "completed", addBlockedBy: ["99"] }), /Unknown task id\(s\) referenced: 99/);
			assert.equal(readStoredTasks(taskStorePath)[1].status, "pending", "a rejected update persists nothing");

			await call("TaskUpdate", { taskId: "1", status: "deleted" });
			stored = readStoredTasks(taskStorePath);
			assert.deepEqual(stored.map(({ id }) => id), [2], "a deleted task disappears from the store");
			assert.deepEqual(stored[0].blockedBy, [], "deleting a task drops every relation to it");
			await assert.rejects(call("TaskGet", { taskId: "1" }), /Task #1 not found/);
			await call("TaskUpdate", { taskId: "2", status: "deleted" });
			assert.equal(await call("TaskList", {}), "No tasks.");
			assert.ok(!fs.existsSync(taskStorePath), "deleting the last task removes the session's store file");
			console.log("  [11] task tools persist, reject unknown ids, and delete");
		}

		// --- 12. Narrow width: each task row truncates to the width; below 8 cells the rows hide ---
		{
			writeStore(taskStorePath, [
				{ id: 1, subject: "a very long in-progress subject", status: "in_progress" },
				{ id: 2, subject: "a very long completed subject", status: "completed" },
				{ id: 3, subject: "a very long pending subject", status: "pending" },
			]);
			const env = await startEnv();
			await until(() => env.render().length === 4);

			const narrow = env.render(16);
			assert.equal(narrow.length, 4, `powerline + 3 task rows expected at width 16, got: ${JSON.stringify(narrow)}`);
			const rows = narrow.slice(1);
			for (const row of rows) assert.ok(visibleWidth(row) <= 16, `each task row must fit width 16, got ${visibleWidth(row)}: ${JSON.stringify(row)}`);
			assert.deepEqual(rows.map((row) => row.slice(0, 6)), ["▶ #1 a", "· #3 a", "#2 ~~a"], `rows keep their order and markers when truncated, got: ${JSON.stringify(rows)}`);
			assert.ok(rows.every((row) => row.includes("...") && !row.includes("subject")), `long subjects must be truncated with an ellipsis, got: ${JSON.stringify(rows)}`);
			console.log("  [12] width 16 truncates each task row:", JSON.stringify(rows));

			const tiny = env.render(7);
			assert.equal(tiny.length, 1, `below 8 cells only the powerline row should render, got: ${JSON.stringify(tiny)}`);
			assert.ok(!tiny[0].includes("#1"), `no task row below 8 cells, got: ${JSON.stringify(tiny)}`);

			const toggle = env.commands.get("statusline");
			assert.ok(toggle !== undefined, "the /statusline command handler must be captured");
			await toggle("", env.ctx);
			assert.deepEqual(env.render(7), [""], `statusline off + width 7 should render the blank row only, got: ${JSON.stringify(env.render(7))}`);
			assert.equal(env.render(8).length, 3, `width 8 is the threshold where the task rows render again, got: ${JSON.stringify(env.render(8))}`);
			console.log("  [12] below 8 cells the task rows hide");
			env.dispose();
		}

		// --- 13. Open-handle write: a reader holding the store open (footer poll, AV) must not block writes ---
		{
			fs.rmSync(taskStorePath, { force: true });
			const tools = new Map(loadEngineTools().map((tool) => [tool.name, tool]));
			const call = async (name: string, params: unknown): Promise<string> => {
				const tool = tools.get(name);
				assert.ok(tool !== undefined, `${name} must be registered`);
				const result = await tool.execute("call", params, undefined, undefined, toolCtx(SESSION_ID));
				return result.content[0]?.text ?? "";
			};
			assert.equal(await call("TaskCreate", { subject: "first", description: "first" }), "Created task #1: first");
			const readHandle = fs.openSync(taskStorePath, "r");
			try {
				assert.equal(await call("TaskCreate", { subject: "second", description: "second" }), "Created task #2: second");
				await call("TaskUpdate", { taskId: "1", status: "in_progress" });
				const stored = readStoredTasks(taskStorePath);
				assert.deepEqual(stored.map(({ subject }) => subject), ["first", "second"], "a create lands while another handle has the store open");
				assert.equal(stored[0].status, "in_progress", "an update lands while another handle has the store open");
				const tmpSiblings = fs.readdirSync(path.dirname(taskStorePath)).filter((name) => name.includes(".tmp-"));
				assert.deepEqual(tmpSiblings, [], "the write is in place, no tmp sibling");
			} finally {
				fs.closeSync(readHandle);
			}
			console.log("  [13] writes succeed while another handle holds the store open");
		}

		// --- 14. Parallel reads: TaskList/TaskGet racing an in-flight TaskUpdate never see a partial store ---
		{
			fs.rmSync(taskStorePath, { force: true });
			const tools = new Map(loadEngineTools().map((tool) => [tool.name, tool]));
			const call = async (name: string, params: unknown): Promise<string> => {
				const tool = tools.get(name);
				assert.ok(tool !== undefined, `${name} must be registered`);
				const result = await tool.execute("call", params, undefined, undefined, toolCtx(SESSION_ID));
				return result.content[0]?.text ?? "";
			};
			// A larger store widens the window an async truncate-then-write would leave open.
			for (let i = 1; i <= 40; i++) await call("TaskCreate", { subject: `task ${i}`, description: "x".repeat(200) });
			let reads = 0;
			for (let trial = 0; trial < 50; trial++) {
				let settled = false;
				const update = call("TaskUpdate", { taskId: "1", status: trial % 2 === 0 ? "in_progress" : "pending" }).finally(() => {
					settled = true;
				});
				while (!settled) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					if (settled) break;
					await call("TaskList", {});
					await call("TaskGet", { taskId: "1" });
					reads++;
				}
				await update;
			}
			assert.ok(reads > 0, "at least one read must overlap an in-flight update");
			console.log(`  [14] ${reads} parallel TaskList/TaskGet reads during in-flight updates, none rejected`);
		}

		// --- 15. Per-session store: parallel sessions are disjoint, /new starts empty, /resume restores ---
		{
			fs.rmSync(taskStorePath, { force: true });
			const newSessionId = "0199a1b2-c3d4-7e5f-8a9b-000000000000";
			const otherStorePath = resolveTaskStorePath(OTHER_SESSION_ID);
			assert.notEqual(otherStorePath, taskStorePath, "two session ids in one project must resolve to different stores");
			const tools = new Map(loadEngineTools().map((tool) => [tool.name, tool]));
			const call = async (ctx: ExtensionContext, name: string, params: unknown): Promise<string> => {
				const tool = tools.get(name);
				assert.ok(tool !== undefined, `${name} must be registered`);
				const result = await tool.execute("call", params, undefined, undefined, ctx);
				return result.content[0]?.text ?? "";
			};

			await call(toolCtx(SESSION_ID), "TaskCreate", { subject: "mine", description: "session A" });
			await call(toolCtx(OTHER_SESSION_ID), "TaskCreate", { subject: "theirs", description: "session B" });
			assert.equal(await call(toolCtx(SESSION_ID), "TaskList", {}), "#1 [pending] mine", "session A must not see session B's task");
			assert.equal(await call(toolCtx(OTHER_SESSION_ID), "TaskList", {}), "#1 [pending] theirs", "session B must not see session A's task");
			console.log("  [15] two sessions in one project see disjoint lists");

			const env = await startEnv();
			await until(() => env.render()[1] === "· #1 mine");

			env.session.id = newSessionId;
			env.fire("session_start", { type: "session_start", reason: "new" });
			await until(() => env.render().length === 1);
			assert.equal(await call(env.ctx, "TaskList", {}), "No tasks.", "a /new session starts with an empty list");
			assert.deepEqual(readStoredTasks(taskStorePath).map(({ subject }) => subject), ["mine"], "/new leaves the previous session's list intact");
			console.log("  [15] session_start reason new: empty list, old list intact");

			env.session.id = SESSION_ID;
			env.fire("session_start", { type: "session_start", reason: "resume" });
			await until(() => env.render()[1] === "· #1 mine");
			assert.equal(await call(env.ctx, "TaskList", {}), "#1 [pending] mine", "resuming a session returns its own list");
			console.log("  [15] session_start reason resume: earlier tasks restored");
			env.dispose();

			await call(toolCtx(SESSION_ID), "TaskUpdate", { taskId: "1", status: "deleted" });
			assert.ok(!fs.existsSync(taskStorePath), "an emptied list removes its store file");
			assert.ok(fs.existsSync(otherStorePath), "emptying one session's list leaves another session's file");
			await call(toolCtx(OTHER_SESSION_ID), "TaskUpdate", { taskId: "1", status: "deleted" });
			assert.ok(!fs.existsSync(otherStorePath), "the other session's emptied list removes its own file");
			console.log("  [15] an emptied list removes only its own session's file");
		}
	} finally {
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		if (originalSpawnDepth === undefined) delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
		else process.env.PI_CONDUCTOR_SPAWN_DEPTH = originalSpawnDepth;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}

	console.log("\nAll tasklist harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
