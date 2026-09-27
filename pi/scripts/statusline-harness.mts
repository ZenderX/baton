/**
 * Statusline harness — drives core/extensions/statusline.ts with a fake ExtensionAPI,
 * ExtensionContext, Theme, TUI and footer provider to verify (without touching a
 * live server or the real agent dir):
 *
 *   1. Fail-soft: a dead server keeps the static window and warns (no throw).
 *   2. Gauge: a mock `/v1/models` server (max_model_len 200000) makes
 *      100000/200000 read 50% with 3 filled / 3 empty cells.
 *   3. tok/s: the decode rate clocked from the first streamed token (5s of no
 *      output then 400 chars ≈ 100 tokens over 1s reads "100 tok/s", not the
 *      ≈17 a message_start clock gives; nothing shows before the first rate; a
 *      slow 40-char/10s stream reads "1 tok/s"); once a message completes the
 *      figure holds its final rate (not "0 tok/s"), including across the next
 *      message's pre-first-token wait; a sub-200ms span keeps the previous
 *      held value; the figure is right-aligned to the footer's right edge.
 *   4. Cost: the $ figure only when total cost > 0.
 *   5. Self-heal: with a typical local provider structure in a temp agent dir
 *      (stale contextWindow 120000), a live 200000 from the mock server rewrites
 *      models.json to 200000 — atomically, preserving every other key, deferring
 *      registry.refresh() to turn_end, and emitting one notify.
 *   6. Product flag: a fresh session with --conductor, and separately
 *      --refuter (no statusline flag or active product), enables the footer
 *      at session_start.
 *   7. Active product: a session with globalThis baton.activeProduct already
 *      set (mirroring a product shim's session_start) enables the footer at
 *      session_start.
 *  7b. Spawned child: the same active product with PI_CONDUCTOR_SPAWN_DEPTH
 *      set (a subagent-tool child, see engine/spawn-depth.ts) leaves the
 *      footer off — children get their own brief, not the auto-enable.
 *   8. Product transition: no active product at session_start, then
 *      baton.activeProduct is set (mirroring a shim's /conductor or /refuter
 *      command), turn_start auto-enables the footer with one notify and
 *      appends no entry.
 *   9. Explicit off respected: a /statusline toggle-off after the auto-enable
 *      survives a further turn_start while the active product is unchanged.
 *  10. Empty-branch stream: with `state.branch = []`, `message_start` +
 *      `message_update` (400 chars over 1s after the first token) render the
 *      speedometer with no in/out items; `message_end` holds `100 tok/s`.
 *  11. Cache group: a message_end with 90 cache-read of 100 input-side
 *      tokens on a private baseUrl renders the hit rate only (90%) — no
 *      countdown, cold or time-left figure, no miss counter while every
 *      request hit the cache.
 *  12. Cache group: a message_end with cacheRead = 0 counts a miss
 *      (`1 miss`, then `2 miss`).
 *  13. Cache group: a non-private baseUrl renders no cache group.
 *  14. Subagent tok/s: a registry entry is clocked from its first delta
 *      (5s wait then 400 chars over 1s reads 100), holds that rate after
 *      message_end and through the next message's pre-first-delta wait, and
 *      the footer's agent group reads `1 agent | 100 tok/s`.
 *
 * Run with: node scripts/statusline-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusline from "../core/extensions/statusline.ts";
import {
	subagentLiveDelta,
	subagentLiveKey,
	subagentLiveMessageEnd,
	subagentLiveMessageStart,
	subagentLiveRemove,
	subagentLiveStart,
	subagentLiveTps,
} from "../core/extensions/subagent-live.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

// Mirrors extensions/engine/product-registry.ts's ACTIVE_PRODUCT_KEY: a real
// product shim writes this same globalThis slot on activation, so setting it
// directly here stands in for that shim without importing across packages.
const ACTIVE_PRODUCT_KEY = Symbol.for("baton.activeProduct");

function setActiveProduct(name: string | undefined): void {
	const channel = globalThis as Record<symbol, unknown>;
	if (name === undefined) delete channel[ACTIVE_PRODUCT_KEY];
	else channel[ACTIVE_PRODUCT_KEY] = name;
}

function getActiveProduct(): string | undefined {
	const value = (globalThis as Record<symbol, unknown>)[ACTIVE_PRODUCT_KEY];
	return typeof value === "string" ? value : undefined;
}

// A deliberately minimal structural subset of pi's footer component and the
// event/context/registry shapes the extension reads. Test-only seams.
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
	render: (width?: number) => string;
	/** Drop the live footer component (stops its 3s tick). */
	dispose: () => void;
	state: { model: unknown; contextUsage: unknown; branch: unknown[] };
	notified: string[];
	refreshes: number;
	commands: Map<string, CommandHandler>;
	appended: AppendedEntry[];
	ctx: ExtensionContext;
}

interface MakeEnvOptions {
	/** Flags the fake pi reports via getFlag; defaults to `{ statusline: true }`. */
	flags?: Record<string, boolean>;
	/** Session entries the fake session manager returns (checks may push into it). */
	entries?: unknown[];
}

function makeModel(id: string, provider: string, baseUrl: string, contextWindow: number): unknown {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	};
}

function assistantUsage(input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0): unknown {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantMessage(output: number, textChars = 0, usage?: unknown): unknown {
	const content = textChars > 0 ? [{ type: "text", text: "x".repeat(textChars) }] : [];
	return { role: "assistant", content, api: "openai-completions", provider: "harness", model: "harness-model", usage: usage ?? assistantUsage(0, output, 0), stopReason: "stop", timestamp: 0 };
}

/** A session "message" entry shaped for renderCost's cumulative totals. */
function messageEntry(input: number, output: number, cost: number): unknown {
	return { type: "message", message: { role: "assistant", usage: assistantUsage(input, output, cost) } };
}

function makeEnv(options: MakeEnvOptions = {}): Env {
	const { flags = { statusline: true }, entries = [] } = options;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const appended: AppendedEntry[] = [];
	const notified: string[] = [];
	let refreshes = 0;
	let footerFactory: ((t: unknown, th: unknown, fd: unknown) => FooterComponent) | undefined;

	const state: { model: unknown; contextUsage: unknown; branch: unknown[] } = { model: undefined, contextUsage: undefined, branch: [] };

	const tui = { requestRender: (): void => undefined };
	const theme = {
		fg: (_color: string, text: string): string => text,
		strikethrough: (text: string): string => `~~${text}~~`,
	};
	const footerData = { getGitBranch: (): string => "main", onBranchChange: (): (() => void) => () => undefined };

	// One live component per env (like a real session): the composite footer's
	// 3s tick keeps firing between renders.
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
			return "/home/u/proj";
		},
		get model(): unknown {
			return state.model;
		},
		get hasUI(): boolean {
			return true;
		},
		ui,
		sessionManager: { getEntries: (): unknown[] => entries, getBranch: (): unknown[] => state.branch },
		modelRegistry: {
			getApiKeyAndHeaders: async (): Promise<unknown> => ({ ok: true, apiKey: "local-secret", headers: {} }),
			refresh: async (): Promise<unknown> => {
				refreshes += 1;
				return undefined;
			},
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

	function render(width = 200): string {
		if (footerFactory === undefined) throw new Error("footer not applied");
		if (component === undefined) component = footerFactory(tui, theme, footerData);
		return component.render(width)[0];
	}

	function dispose(): void {
		// The shared footer-line registry lives on globalThis and is
		// process-wide: session_shutdown unregisters this env's providers
		// before the component is dropped, so nothing leaks into the next env.
		fire("session_shutdown", { type: "session_shutdown" });
		component?.dispose?.();
		component = undefined;
	}

	return { pi, fire, render, dispose, state, notified, ctx, commands, appended, get refreshes(): number {
		return refreshes;
	} };
}

/** A mock OpenAI-compatible server that reports max_model_len for one model. */
function startModelsServer(modelId: string, maxModelLen: number): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: modelId, max_model_len: maxModelLen }] }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ port, close: (): Promise<void> => new Promise((done) => server.close(() => done())) });
		});
	});
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

function count(haystack: string, needle: string): number {
	let n = 0;
	for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + needle.length)) n++;
	return n;
}

/** The right-aligned figure at the line's end (formatTps: `<int> tok/s`); "" when absent. */
function trailingFigure(line: string): string {
	const match = line.match(/\d+ tok\/s$/u);
	return match === null ? "" : match[0];
}

async function main(): Promise<void> {
	// Redirect the agent dir to a temp dir so the self-heal write path is exercised
	// deterministically and the real ~/.pi/agent/models.json is never touched.
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-statusline-harness-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const modelsPath = path.join(agentDir, "models.json");
	const modelsFile = {
		providers: {
			local: {
				baseUrl: "http://127.0.0.1:11111/v1",
				api: "openai-completions",
				apiKey: "local-secret",
				models: [
					{
						id: "example-27b",
						name: "Example 27B (local)",
						reasoning: true,
						thinkingLevelMap: { minimal: null, high: "xhigh", xhigh: "xhigh" },
						input: ["text"],
						contextWindow: 120000,
						maxTokens: 8192,
					},
				],
			},
		},
	};
	fs.writeFileSync(modelsPath, JSON.stringify(modelsFile, null, 2) + "\n", "utf8");

	try {
		// --- 1. Fail-soft: dead port keeps the static window and warns (no throw) ---
		{
			const originalWarn = console.warn;
			let warnCount = 0;
			console.warn = (): void => {
				warnCount += 1;
			};
			try {
				const env = makeEnv();
				env.state.model = makeModel("dead-model", "harness", "http://127.0.0.1:9/v1", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [messageEntry(50000, 2000, 0.05)];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });

				await until(() => warnCount > 0);
				const line = env.render();
				assert.ok(line.includes("120k"), `fail-soft should keep the static window (120k), got: ${line}`);
				assert.ok(!line.includes("200k"), `fail-soft must not adopt a live window, got: ${line}`);
				assert.ok(warnCount >= 1, "fail-soft should warn at least once on a dead server");
				console.log("  [1] fail-soft keeps static window:", line);
				env.dispose();
			} finally {
				console.warn = originalWarn;
			}
		}

		// --- 2. Live window + gauge + tok/s + cost visibility ---
		const server = await startModelsServer("harness-model", 200000);
		try {
			const env = makeEnv();
			env.state.model = makeModel("harness-model", "harness", `http://127.0.0.1:${server.port}/v1`, 120000);
			env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
			env.state.branch = [messageEntry(50000, 2000, 0.05)];
			statusline(env.pi);
			await env.fire("session_start", { type: "session_start" });

			// Wait for the background refresh to cache the live 200000 window.
			await until(() => env.render().includes("100k/200k"));

			const realNow = Date.now;
			try {
				// tok/s A: 5s of queue/prefill with no output, then 400 chars (≈ 100 tokens)
				// over 1s after the first token reads "100 tok/s" — a message_start clock reads ≈17.
				Date.now = (): number => 1_000_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(41) });
				Date.now = (): number => 1_003_000;
				const lineWait = env.render();
				assert.equal(trailingFigure(lineWait), "", `no rate may show before the session's first token, got: ${lineWait}`);
				Date.now = (): number => 1_005_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(41, 4) });
				Date.now = (): number => 1_006_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(41, 404) });

				const line = env.render();
				assert.ok(line.includes("50%"), `gauge at 100000/200000 should read 50%, got: ${line}`);
				assert.ok(line.includes("100k/200k"), `gauge trailing should use the live window, got: ${line}`);
				assert.equal(count(line, "█"), 3, `gauge should fill 3 cells, got: ${line}`);
				assert.equal(count(line, "░"), 3, `gauge should empty 3 cells, got: ${line}`);
				assert.ok(line.endsWith("100 tok/s"), `the live speedometer should end at the right edge, got: ${line}`);
				assert.equal(visibleWidth(line), 200, `the padded line should fill exactly the render width, got: ${line}`);
				assert.ok(line.includes("$"), `nonzero cost should show the $ figure, got: ${line}`);
				assert.ok(line.includes("↑50k") && line.includes("↓2.0k"), `cost group should show in/out totals, got: ${line}`);
				console.log("  [2] live gauge 50% + 100 tok/s streaming + $:", line);

				// Once the message completes the speedometer holds its final rate.
				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 404) });
				Date.now = (): number => 1_009_000;
				const lineA = env.render();
				assert.equal(trailingFigure(lineA), "100 tok/s", `the completed message should hold 100 tok/s, got: ${lineA}`);
				assert.equal(visibleWidth(lineA), 200, `the padded line should fill exactly the render width, got: ${lineA}`);

				// tok/s B: the next message holds 100 until its first token, then a slow
				// 40-char stream (10 tokens) over 10s reads "1 tok/s" live.
				Date.now = (): number => 1_100_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(47) });
				Date.now = (): number => 1_104_000;
				const lineWaitB = env.render();
				assert.equal(trailingFigure(lineWaitB), "100 tok/s", `the pre-first-token wait should hold the previous rate, got: ${lineWaitB}`);
				env.fire("message_update", { type: "message_update", message: assistantMessage(47, 4) });
				Date.now = (): number => 1_114_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(47, 44) });

				const lineB = env.render();
				assert.equal(trailingFigure(lineB), "1 tok/s", `a slow stream should read 1 tok/s, got: ${lineB}`);
				assert.equal(visibleWidth(lineB), 200, `the padded line should fill exactly the render width, got: ${lineB}`);
				console.log("  [3] live speedometer 1 tok/s:", lineB);

				// The new message's completion holds 1 tok/s.
				env.fire("message_end", { type: "message_end", message: assistantMessage(47, 44) });
				const lineB2 = env.render();
				assert.equal(trailingFigure(lineB2), "1 tok/s", `the completed message should hold 1 tok/s, got: ${lineB2}`);

				// A sub-200ms first-token span keeps the previous held value instead of a spike.
				Date.now = (): number => 1_200_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(48) });
				env.fire("message_update", { type: "message_update", message: assistantMessage(48, 4) });
				Date.now = (): number => 1_200_050;
				env.fire("message_update", { type: "message_update", message: assistantMessage(48, 400) });
				assert.equal(trailingFigure(env.render()), "1 tok/s", "a sub-200ms live span should show the held value");
				env.fire("message_end", { type: "message_end", message: assistantMessage(48, 400) });
				const lineShort = env.render();
				assert.equal(trailingFigure(lineShort), "1 tok/s", `a sub-200ms message should keep the held 1 tok/s, got: ${lineShort}`);

				// A single-chunk message (all output in its first non-empty update) ending
				// ≥1s later has no tokens after the first chunk, so it keeps the held value.
				Date.now = (): number => 1_300_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(49) });
				env.fire("message_update", { type: "message_update", message: assistantMessage(49, 300) });
				Date.now = (): number => 1_301_500;
				assert.equal(trailingFigure(env.render()), "1 tok/s", "a single-chunk live message should show the held value");
				env.fire("message_end", { type: "message_end", message: assistantMessage(49, 300) });
				const lineSingle = env.render();
				assert.equal(trailingFigure(lineSingle), "1 tok/s", `a single-chunk message should keep the held 1 tok/s, got: ${lineSingle}`);
				console.log("  [3] single-chunk message keeps held 1 tok/s:", lineSingle);

				// Zero cost hides the $ figure.
				env.state.branch = [messageEntry(50000, 2000, 0)];
				const lineC = env.render();
				assert.ok(!lineC.includes("$"), `zero cost should hide the $ figure, got: ${lineC}`);
				assert.equal(trailingFigure(lineC), "1 tok/s", `the held figure should stay right-aligned when the $ figure disappears, got: ${lineC}`);
				assert.equal(visibleWidth(lineC), 200, `the padded line should fill exactly the render width, got: ${lineC}`);
				console.log("  [4] zero cost hides $:", lineC);

				// The harness provider is absent from the temp models.json, so no self-heal notify.
				assert.equal(env.notified.length, 0, "no self-heal notify for an untracked provider");
			} finally {
				Date.now = realNow;
			}
			env.dispose();
		} finally {
			await server.close();
		}

		// --- 5. Self-heal: stale models.json is rewritten from the live window ---
		const readModels = (): number => JSON.parse(fs.readFileSync(modelsPath, "utf8")).providers.local.models[0].contextWindow;
		const readRaw = (): string => fs.readFileSync(modelsPath, "utf8");

		assert.equal(readModels(), 120000, "precondition: temp models.json starts stale at 120000");

		const healServer = await startModelsServer("example-27b", 200000);
		try {
			const env = makeEnv();
			env.state.model = makeModel("example-27b", "local", `http://127.0.0.1:${healServer.port}/v1`, 120000);
			env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
			env.state.branch = [];
			statusline(env.pi);
			await env.fire("session_start", { type: "session_start" });

			await until(() => readModels() === 200000);
			assert.equal(readModels(), 200000, "self-heal should rewrite contextWindow to 200000");

			// Every other key is preserved.
			const rewritten = JSON.parse(readRaw());
			const model = rewritten.providers.local.models[0];
			assert.equal(model.name, "Example 27B (local)", "model name preserved");
			assert.equal(model.reasoning, true, "reasoning preserved");
			assert.equal(model.maxTokens, 8192, "maxTokens preserved");
			assert.deepEqual(model.thinkingLevelMap, { minimal: null, high: "xhigh", xhigh: "xhigh" }, "thinkingLevelMap preserved");
			assert.equal(rewritten.providers.local.apiKey, "local-secret", "apiKey preserved");
			assert.equal(rewritten.providers.local.baseUrl, "http://127.0.0.1:11111/v1", "baseUrl preserved");
			assert.ok(readRaw().endsWith("\n"), "trailing newline preserved");

			// No stray tmp files left behind.
			const tmpFiles = fs.readdirSync(agentDir).filter((f) => f.endsWith(".tmp"));
			assert.deepEqual(tmpFiles, [], "atomic write should leave no .tmp files");

			// The notify fires from the write (self-heal). The registry refresh is
			// deferred to turn_end so it never runs mid-request (that would drop the
			// in-flight auth resolution and make pi throw "Provider is not configured").
			assert.equal(env.notified.length, 1, "exactly one self-heal notify");
			assert.ok(env.notified[0]?.includes("200k") && env.notified[0]?.includes("200000"), `notify should name the synced window, got: ${env.notified[0]}`);
			assert.equal(env.refreshes, 0, "no registry refresh before turn_end (avoids the mid-request race)");

			await env.fire("turn_end", { type: "turn_end" });
			await until(() => env.refreshes >= 1);
			assert.ok(env.refreshes >= 1, "registry.refresh should be called on turn_end after a self-heal write");
			console.log("  [5] self-heal rewrote models.json:", JSON.stringify(env.notified[0]));

			// Re-running with the now-correct value is a no-op (no second write/notify/refresh).
			// The first session shuts down first: its double-load guard claim (extensions/load-guard.ts) holds until then.
			env.dispose();
			const second = makeEnv();
			second.state.model = makeModel("example-27b", "local", `http://127.0.0.1:${healServer.port}/v1`, 200000);
			second.state.contextUsage = { tokens: 100000, contextWindow: 200000, percent: null };
			second.state.branch = [];
			statusline(second.pi);
			await second.fire("session_start", { type: "session_start" });
			await sleep(150);
			assert.equal(readModels(), 200000, "no-op re-run keeps 200000");
			assert.equal(second.notified.length, 0, "no notify when the value is already correct");
			await second.fire("turn_end", { type: "turn_end" });
			await sleep(50);
			assert.equal(second.refreshes, 0, "no registry refresh when the value is already correct");
			second.dispose();
		} finally {
			await healServer.close();
		}

		// --- 6. Product flag: a fresh --conductor (then --refuter) session enables the footer ---
		{
			const originalArgv = process.argv;
			try {
				process.argv = [...originalArgv, "--conductor"];
				const conductorEnv = makeEnv({ flags: {} });
				conductorEnv.state.model = makeModel("harness-model", "harness", "", 120000);
				conductorEnv.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				conductorEnv.state.branch = [];
				statusline(conductorEnv.pi);
				await conductorEnv.fire("session_start", { type: "session_start" });

				const line = conductorEnv.render();
				assert.ok(line.includes("100k/120k"), `the --conductor argv flag should enable the footer, got: ${line}`);
				assert.ok(visibleWidth(line) < 200, `with no t/s figure the line must not be padded to width, got: ${line}`);
				console.log("  [6] conductor flag enables footer:", line);
				conductorEnv.dispose();

				// --refuter is the other flag the engine checks.
				process.argv = [...originalArgv, "--refuter"];
				const refuterEnv = makeEnv({ flags: {} });
				refuterEnv.state.model = makeModel("harness-model", "harness", "", 120000);
				refuterEnv.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				refuterEnv.state.branch = [];
				statusline(refuterEnv.pi);
				await refuterEnv.fire("session_start", { type: "session_start" });
				const refuterLine = refuterEnv.render();
				assert.ok(refuterLine.includes("100k/120k"), `the --refuter argv flag should enable the footer, got: ${refuterLine}`);
				console.log("  [6] refuter flag enables footer:", refuterLine);
				refuterEnv.dispose();

				// Faithfulness: with neither flag in argv the footer stays off, proving the argv path (not a flag) enables it.
				process.argv = originalArgv;
				const noFlagEnv = makeEnv({ flags: {} });
				noFlagEnv.state.model = makeModel("harness-model", "harness", "", 120000);
				noFlagEnv.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				noFlagEnv.state.branch = [];
				statusline(noFlagEnv.pi);
				await noFlagEnv.fire("session_start", { type: "session_start" });
				assert.throws(() => noFlagEnv.render(), /footer not applied/, "removing --conductor/--refuter from argv leaves the footer off");
				noFlagEnv.dispose();
			} finally {
				process.argv = originalArgv;
			}
		}

		// --- 7. Active product: globalThis baton.activeProduct set before session_start enables the footer ---
		{
			assert.ok(!process.argv.includes("--conductor") && !process.argv.includes("--refuter"), "check 7 must not rely on an argv flag");
			setActiveProduct("conductor");
			try {
				const env = makeEnv({ flags: {} });
				env.state.model = makeModel("harness-model", "harness", "", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });

				const line = env.render();
				assert.ok(line.includes("100k/120k"), `an active product should enable the footer, got: ${line}`);
				console.log("  [7] active product enables footer:", line);
				env.dispose();
			} finally {
				setActiveProduct(undefined);
			}
		}

		// --- 7b. Spawned child: an active product with PI_CONDUCTOR_SPAWN_DEPTH set leaves the footer off ---
		{
			assert.ok(!process.argv.includes("--conductor") && !process.argv.includes("--refuter"), "check 7b must not rely on an argv flag");
			setActiveProduct("conductor");
			const originalSpawnDepth = process.env.PI_CONDUCTOR_SPAWN_DEPTH;
			process.env.PI_CONDUCTOR_SPAWN_DEPTH = "1";
			try {
				const env = makeEnv({ flags: {} });
				env.state.model = makeModel("harness-model", "harness", "", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });

				assert.throws(
					() => env.render(),
					/footer not applied/,
					"a spawned child (PI_CONDUCTOR_SPAWN_DEPTH > 0) must not auto-enable the footer even with an active product",
				);
				console.log("  [7b] spawned child leaves the footer off despite an active product");
				env.dispose();
			} finally {
				setActiveProduct(undefined);
				if (originalSpawnDepth === undefined) delete process.env.PI_CONDUCTOR_SPAWN_DEPTH;
				else process.env.PI_CONDUCTOR_SPAWN_DEPTH = originalSpawnDepth;
			}
		}

		// --- 8. Off->on active-product transition auto-enables on turn_start ---
		// --- 9. An explicit /statusline off survives a further turn_start ---
		{
			assert.ok(!process.argv.includes("--conductor") && !process.argv.includes("--refuter"), "check 8 must not rely on an argv flag");
			assert.equal(getActiveProduct(), undefined, "check 8 must start with no active product");
			try {
				const env = makeEnv({ flags: {} });
				env.state.model = makeModel("harness-model", "harness", "", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });

				assert.throws(() => env.render(), /footer not applied/, "no active product at session_start leaves the default footer");

				// The shim's /conductor (or /refuter) command sets this synchronously; the next turn_start observes it.
				setActiveProduct("conductor");
				env.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

				const line = env.render();
				assert.ok(line.includes("100k/120k"), `an off->on active-product transition should auto-enable the footer, got: ${line}`);
				assert.equal(env.notified.length, 1, "exactly one auto-enable notify");
				assert.equal(env.appended.length, 0, "the auto-enable must not persist a statusline entry");
				console.log("  [8] product transition auto-enables:", line);

				// The explicit /statusline toggle-off wins until the product is toggled again.
				const toggle = env.commands.get("statusline");
				assert.ok(toggle !== undefined, "the /statusline command handler must be captured");
				await toggle("", env.ctx);
				assert.equal(env.appended.length, 1, "the explicit /statusline off persists a statusline entry");

				env.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
				assert.throws(() => env.render(), /footer not applied/, "an explicit off is respected while the active product is unchanged");
				assert.equal(env.notified.length, 2, "no second auto-enable notify without a fresh transition");
				console.log("  [9] explicit /statusline off respected");
				env.dispose();
			} finally {
				setActiveProduct(undefined);
			}
		}

		// --- 10. Empty-branch stream: the speedometer shows before any usage is on the branch ---
		{
			const env = makeEnv();
			env.state.model = makeModel("harness-model", "harness", "", 120000);
			env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
			env.state.branch = [];
			statusline(env.pi);
			await env.fire("session_start", { type: "session_start" });

			const realNow = Date.now;
			try {
				Date.now = (): number => 1_000_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(41) });
				env.fire("message_update", { type: "message_update", message: assistantMessage(41, 4) });
				Date.now = (): number => 1_001_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(41, 404) });

				const line = env.render();
				assert.equal(trailingFigure(line), "100 tok/s", `an empty-branch stream should read exactly 100 tok/s, got: ${line}`);
				assert.equal(visibleWidth(line), 200, `the padded line should fill exactly the render width, got: ${line}`);
				assert.ok(!line.includes("↑"), `an empty branch must show no in/out items, got: ${line}`);
				console.log("  [10] empty-branch stream 100 tok/s:", line);

				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 404) });
				const lineEnd = env.render();
				assert.equal(trailingFigure(lineEnd), "100 tok/s", `the completed empty-branch stream should hold exactly 100 tok/s, got: ${lineEnd}`);
				assert.ok(!lineEnd.includes("↑"), `an empty branch must show no in/out items, got: ${lineEnd}`);
			} finally {
				Date.now = realNow;
			}
			env.dispose();
		}

		// --- 11. Cache group: hit rate only, real data on a private server ---
		{
			const env = makeEnv();
			const originalWarn = console.warn;
			let warnCount = 0;
			try {
				// The dead-port window probe warns once; the cache group itself never fetches.
				console.warn = (): void => {
					warnCount += 1;
				};
				env.state.model = makeModel("harness-model", "harness", "http://127.0.0.1:9/v1", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });
				// Let the dead-port window probe warn while it is still suppressed.
				await until(() => warnCount > 0);
				// A request with 90 cache-read tokens of 100 input-side tokens: 90% hit rate.
				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 0, assistantUsage(10, 41, 0, 90, 0)) });

				const line = env.render();
				assert.ok(line.includes("90%"), `the hit rate should read 90%, got: ${line}`);
				assert.ok(!line.includes("cold"), `no cold figure may be shown, got: ${line}`);
				assert.ok(!line.includes("10m"), `no full-window countdown figure may be shown, got: ${line}`);
				assert.ok(!line.includes("8m"), `no countdown figure may be shown, got: ${line}`);
				assert.ok(!line.includes("30s"), `no countdown figure may be shown, got: ${line}`);
				assert.ok(!line.includes("miss"), `no miss counter while every request hit the cache, got: ${line}`);
				console.log("  [11] cache group 90%:", line);
			} finally {
				console.warn = originalWarn;
				env.dispose();
			}
		}

		// --- 12. Cache group: a zero-cacheRead request counts a miss ---
		{
			const env = makeEnv();
			const originalWarn = console.warn;
			let warnCount = 0;
			try {
				console.warn = (): void => {
					warnCount += 1;
				};
				env.state.model = makeModel("harness-model", "harness", "http://127.0.0.1:9/v1", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });
				await until(() => warnCount > 0);
				// A full cold prefill: zero cache-read tokens.
				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 0, assistantUsage(10, 41, 0, 0, 0)) });
				const line = env.render();
				assert.ok(line.includes("0%"), `a cold prefill should read a 0% hit rate, got: ${line}`);
				assert.ok(line.includes("1 miss"), `a zero-cacheRead request should count one miss, got: ${line}`);
				console.log("  [12] cache miss counted:", line);

				// A second cold request accumulates.
				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 0, assistantUsage(10, 41, 0, 0, 0)) });
				const line2 = env.render();
				assert.ok(line2.includes("2 miss"), `the miss counter should accumulate, got: ${line2}`);
				console.log("  [12] cache misses accumulate:", line2);
			} finally {
				console.warn = originalWarn;
				env.dispose();
			}
		}

		// --- 13. Cache group: a non-private baseUrl renders no cache group ---
		{
			const env = makeEnv();
			try {
				env.state.model = makeModel("harness-model", "harness", "https://api.openai.com/v1", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });
				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 0, assistantUsage(10, 41, 0, 90, 0)) });
				const line = env.render();
				assert.ok(!line.includes("miss"), `a public API should render no miss counter, got: ${line}`);
				assert.ok(!line.includes("cold"), `a public API should render no cold figure, got: ${line}`);
				assert.ok(!line.includes("10m"), `a public API should render no warm window, got: ${line}`);
				assert.ok(!line.includes("90%"), `a public API should render no hit rate, got: ${line}`);
				console.log("  [13] no cache group for a public baseUrl:", line);
			} finally {
				env.dispose();
			}
		}

		// --- 14. Subagent tok/s: clocked from the first delta, held after message_end ---
		{
			const env = makeEnv();
			const key = subagentLiveKey();
			const realNow = Date.now;
			try {
				env.state.model = makeModel("harness-model", "harness", "", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });

				subagentLiveStart(key, "worker");
				Date.now = (): number => 2_000_000;
				subagentLiveMessageStart(key);
				Date.now = (): number => 2_005_000;
				assert.equal(subagentLiveTps(key), 0, "no subagent rate before its first delta");
				subagentLiveDelta(key, 4);
				Date.now = (): number => 2_006_000;
				subagentLiveDelta(key, 400);
				assert.equal(Math.round(subagentLiveTps(key)), 100, "a delayed first delta should read 100 tok/s, not ≈17");

				subagentLiveMessageEnd(key);
				Date.now = (): number => 2_009_000;
				assert.equal(Math.round(subagentLiveTps(key)), 100, "the subagent should hold its last rate after message_end");
				const line = env.render();
				assert.ok(line.endsWith("1 agent | 100 tok/s"), `the agent group should show the held rate, got: ${line}`);
				console.log("  [14] subagent holds its rate:", line);

				subagentLiveMessageStart(key);
				Date.now = (): number => 2_012_000;
				assert.equal(Math.round(subagentLiveTps(key)), 100, "the next message's pre-first-delta wait should hold the previous rate");

				// A single-delta message ending ≥1s later has no chars after its first delta, so it keeps the held rate.
				subagentLiveDelta(key, 300);
				Date.now = (): number => 2_013_500;
				subagentLiveMessageEnd(key);
				assert.equal(Math.round(subagentLiveTps(key)), 100, "a single-delta subagent message should keep the held rate, not 0");
			} finally {
				Date.now = realNow;
				subagentLiveRemove(key);
				env.dispose();
			}
		}
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}

	console.log("\nAll statusline harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
