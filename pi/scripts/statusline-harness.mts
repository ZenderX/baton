/**
 * Statusline harness — drives extensions/statusline.ts with a fake ExtensionAPI,
 * ExtensionContext, Theme, TUI and footer provider to verify (without touching a
 * live server or the real agent dir):
 *
 *   1. Fail-soft: a dead server keeps the static window and warns (no throw).
 *   2. Gauge: a mock `/v1/models` server (max_model_len 200000) makes
 *      100000/200000 read 50% with 3 filled / 3 empty cells.
 *   3. tok/s: a live speedometer of the streaming message (400 chars ≈ 100
 *      tokens over 1s of streaming reads "100t/s", a slow 40-char/10s stream
 *      reads "1.0t/s"); the figure reads "0t/s" once the message completes
 *      and is right-aligned to the footer's right edge.
 *   4. Cost: the $ figure only when total cost > 0.
 *   5. Self-heal: with a typical local provider structure in a temp agent dir
 *      (stale contextWindow 120000), a live 200000 from the mock server rewrites
 *      models.json to 200000 — atomically, preserving every other key, deferring
 *      registry.refresh() to turn_end, and emitting one notify.
 *   6. Conductor flag: a fresh session with --conductor (no statusline flag or
 *      entry) enables the footer at session_start.
 *   7. Conductor entry: a resumed session whose last conductor-mode entry is
 *      {enabled: true} enables the footer at session_start.
 *   8. Conductor transition: conductor off at session_start, entry flips on,
 *      turn_start auto-enables the footer with one notify and appends no entry.
 *   9. Explicit off respected: a /statusline toggle-off after the auto-enable
 *      survives a further turn_start while the conductor state is unchanged.
 *  10. Empty-branch stream: with `state.branch = []`, `message_start` +
 *      `message_update` (400-char partial, 1s) render the speedometer with no
 *      in/out items; `message_end` reads `0t/s`.
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
import statusline from "../extensions/statusline.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

function assistantUsage(input: number, output: number, cost: number): unknown {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantMessage(output: number, textChars = 0): unknown {
	const content = textChars > 0 ? [{ type: "text", text: "x".repeat(textChars) }] : [];
	return { role: "assistant", content, api: "openai-completions", provider: "harness", model: "harness-model", usage: assistantUsage(0, output, 0), stopReason: "stop", timestamp: 0 };
}

/** A session "message" entry shaped for renderCost's cumulative totals. */
function messageEntry(input: number, output: number, cost: number): unknown {
	return { type: "message", message: { role: "assistant", usage: assistantUsage(input, output, cost) } };
}

function makeEnv(options: MakeEnvOptions = {}): Env {
	const { flags = { statusline: true }, entries = [] } = options;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandHandler>();
	const appended: AppendedEntry[] = [];
	const notified: string[] = [];
	let refreshes = 0;
	let footerFactory: ((t: unknown, th: unknown, fd: unknown) => FooterComponent) | undefined;

	const state: { model: unknown; contextUsage: unknown; branch: unknown[] } = { model: undefined, contextUsage: undefined, branch: [] };

	const tui = { requestRender: (): void => undefined };
	const theme = { fg: (_color: string, text: string): string => text };
	const footerData = { getGitBranch: (): string => "main", onBranchChange: (): (() => void) => () => undefined };

	const ui = {
		setFooter: (factory: unknown): void => {
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
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;

	function fire(name: string, event: unknown): void {
		const handler = handlers.get(name);
		if (handler === undefined) throw new Error(`no handler registered for ${name}`);
		void handler(event, ctx);
	}

	function render(width = 200): string {
		if (footerFactory === undefined) throw new Error("footer not applied");
		const component = footerFactory(tui, theme, footerData);
		const line = component.render(width)[0];
		component.dispose?.();
		return line;
	}

	return { pi, fire, render, state, notified, ctx, commands, appended, get refreshes(): number {
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

/** The trailing non-space run of a padded line — the right-aligned t/s figure. */
function trailingFigure(line: string): string {
	return line.slice(line.lastIndexOf(" ") + 1);
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
				// tok/s A: a 400-char partial (≈ 100 tokens) streamed over 1s reads "100t/s" live.
				Date.now = (): number => 1_000_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(41) });
				Date.now = (): number => 1_001_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(41, 400) });

				const line = env.render();
				assert.ok(line.includes("50%"), `gauge at 100000/200000 should read 50%, got: ${line}`);
				assert.ok(line.includes("100k/200k"), `gauge trailing should use the live window, got: ${line}`);
				assert.equal(count(line, "█"), 3, `gauge should fill 3 cells, got: ${line}`);
				assert.equal(count(line, "░"), 3, `gauge should empty 3 cells, got: ${line}`);
				assert.ok(line.endsWith("100t/s"), `the live speedometer should end at the right edge, got: ${line}`);
				assert.equal(visibleWidth(line), 200, `the padded line should fill exactly the render width, got: ${line}`);
				assert.ok(line.includes("$"), `nonzero cost should show the $ figure, got: ${line}`);
				assert.ok(line.includes("↑50k") && line.includes("↓2.0k"), `cost group should show in/out totals, got: ${line}`);
				console.log("  [2] live gauge 50% + 100t/s streaming + $:", line);

				// Once the message completes the speedometer reads 0t/s.
				Date.now = (): number => 1_002_000;
				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 400) });
				const lineA = env.render();
				assert.ok(lineA.endsWith("0t/s"), `the completed message should read 0t/s, got: ${lineA}`);
				assert.equal(trailingFigure(lineA), "0t/s", `the completed message should read exactly 0t/s, got: ${lineA}`);
				assert.equal(visibleWidth(lineA), 200, `the padded line should fill exactly the render width, got: ${lineA}`);

				// tok/s B: a slow 40-char partial (10 tokens) over 10s reads "1.0t/s" live.
				Date.now = (): number => 1_000_000;
				env.fire("message_start", { type: "message_start", message: assistantMessage(47) });
				Date.now = (): number => 1_010_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(47, 40) });

				const lineB = env.render();
				assert.ok(lineB.endsWith("1.0t/s"), `a slow stream should read 1.0t/s, got: ${lineB}`);
				assert.equal(visibleWidth(lineB), 200, `the padded line should fill exactly the render width, got: ${lineB}`);
				assert.ok(!lineB.includes("100t/s"), `stale tok/s should be replaced, got: ${lineB}`);
				console.log("  [3] live speedometer 1.0t/s:", lineB);

				// The new message's completion also reads 0t/s.
				env.fire("message_end", { type: "message_end", message: assistantMessage(47, 40) });
				const lineB2 = env.render();
				assert.ok(lineB2.endsWith("0t/s"), `the completed message should read 0t/s, got: ${lineB2}`);
				assert.equal(trailingFigure(lineB2), "0t/s", `the completed message should read exactly 0t/s, got: ${lineB2}`);

				// Zero cost hides the $ figure.
				env.state.branch = [messageEntry(50000, 2000, 0)];
				const lineC = env.render();
				assert.ok(!lineC.includes("$"), `zero cost should hide the $ figure, got: ${lineC}`);
				assert.ok(lineC.endsWith("0t/s"), `the idle 0t/s figure should stay right-aligned when the $ figure disappears, got: ${lineC}`);
				assert.equal(trailingFigure(lineC), "0t/s", `the idle figure should read exactly 0t/s, got: ${lineC}`);
				assert.equal(visibleWidth(lineC), 200, `the padded line should fill exactly the render width, got: ${lineC}`);
				console.log("  [4] zero cost hides $:", lineC);

				// The harness provider is absent from the temp models.json, so no self-heal notify.
				assert.equal(env.notified.length, 0, "no self-heal notify for an untracked provider");
			} finally {
				Date.now = realNow;
			}
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
		} finally {
			await healServer.close();
		}

		// --- 6. Conductor flag: a fresh --conductor session enables the footer ---
		{
			const originalArgv = process.argv;
			try {
				process.argv = [...originalArgv, "--conductor"];
				const env = makeEnv({ flags: {} });
				env.state.model = makeModel("harness-model", "harness", "", 120000);
				env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				env.state.branch = [];
				statusline(env.pi);
				await env.fire("session_start", { type: "session_start" });

				const line = env.render();
				assert.ok(line.includes("100k/120k"), `the --conductor argv flag should enable the footer, got: ${line}`);
				assert.ok(visibleWidth(line) < 200, `with no t/s figure the line must not be padded to width, got: ${line}`);
				console.log("  [6] conductor flag enables footer:", line);

				// Faithfulness: with --conductor absent from argv the footer stays off, proving the argv path (not a flag) enables it.
				process.argv = originalArgv;
				const noFlag = makeEnv({ flags: {} });
				noFlag.state.model = makeModel("harness-model", "harness", "", 120000);
				noFlag.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
				noFlag.state.branch = [];
				statusline(noFlag.pi);
				await noFlag.fire("session_start", { type: "session_start" });
				assert.throws(() => noFlag.render(), /footer not applied/, "removing --conductor from argv leaves the footer off");
			} finally {
				process.argv = originalArgv;
			}
		}

		// --- 7. Conductor entry: a resumed session with conductor on enables the footer ---
		{
			assert.ok(!process.argv.includes("--conductor"), "check 7 must not rely on the --conductor argv flag");
			const env = makeEnv({ flags: {}, entries: [{ type: "custom", customType: "conductor-mode", data: { enabled: true } }] });
			env.state.model = makeModel("harness-model", "harness", "", 120000);
			env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
			env.state.branch = [];
			statusline(env.pi);
			await env.fire("session_start", { type: "session_start" });

			const line = env.render();
			assert.ok(line.includes("100k/120k"), `a conductor-mode entry should enable the footer, got: ${line}`);
			console.log("  [7] conductor entry enables footer:", line);
		}

		// --- 8. Off->on conductor transition auto-enables on turn_start ---
		// --- 9. An explicit /statusline off survives a further turn_start ---
		{
			assert.ok(!process.argv.includes("--conductor"), "check 8 must not rely on the --conductor argv flag");
			const entries: unknown[] = [];
			const env = makeEnv({ flags: {}, entries });
			env.state.model = makeModel("harness-model", "harness", "", 120000);
			env.state.contextUsage = { tokens: 100000, contextWindow: 120000, percent: null };
			env.state.branch = [];
			statusline(env.pi);
			await env.fire("session_start", { type: "session_start" });

			assert.throws(() => env.render(), /footer not applied/, "conductor off at session_start leaves the default footer");

			// The /conductor command appends its entry synchronously; the next turn_start observes it.
			entries.push({ type: "custom", customType: "conductor-mode", data: { enabled: true } });
			env.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

			const line = env.render();
			assert.ok(line.includes("100k/120k"), `an off->on conductor transition should auto-enable the footer, got: ${line}`);
			assert.equal(env.notified.length, 1, "exactly one auto-enable notify");
			assert.equal(env.appended.length, 0, "the auto-enable must not persist a statusline entry");
			console.log("  [8] conductor transition auto-enables:", line);

			// The explicit /statusline toggle-off wins until the conductor is toggled again.
			const toggle = env.commands.get("statusline");
			assert.ok(toggle !== undefined, "the /statusline command handler must be captured");
			await toggle("", env.ctx);
			assert.equal(env.appended.length, 1, "the explicit /statusline off persists a statusline entry");

			env.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
			assert.throws(() => env.render(), /footer not applied/, "an explicit off is respected while the conductor state is unchanged");
			assert.equal(env.notified.length, 2, "no second auto-enable notify without a fresh transition");
			console.log("  [9] explicit /statusline off respected");
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
				Date.now = (): number => 1_001_000;
				env.fire("message_update", { type: "message_update", message: assistantMessage(41, 400) });

				const line = env.render();
				assert.equal(trailingFigure(line), "100t/s", `an empty-branch stream should read exactly 100t/s, got: ${line}`);
				assert.equal(visibleWidth(line), 200, `the padded line should fill exactly the render width, got: ${line}`);
				assert.ok(!line.includes("↑"), `an empty branch must show no in/out items, got: ${line}`);
				console.log("  [10] empty-branch stream 100t/s:", line);

				env.fire("message_end", { type: "message_end", message: assistantMessage(41, 400) });
				const lineEnd = env.render();
				assert.equal(trailingFigure(lineEnd), "0t/s", `the completed empty-branch stream should read exactly 0t/s, got: ${lineEnd}`);
				assert.ok(!lineEnd.includes("↑"), `an empty branch must show no in/out items, got: ${lineEnd}`);
			} finally {
				Date.now = realNow;
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
