/**
 * Statusline Footer
 *
 * Replaces pi's built-in footer with the powerline layout from
 * `claude/plugins/statusline/scripts/statusline.sh`:
 *
 *   ▌dir on branch │ [model] ██▌░░░ 40% 397k/1M │ ↑in ↓out · $cost    41 tok/s
 *
 * Two separator weights: │ divides the groups (where you are / what you are
 * talking to and how full it is / what the session has cost), · separates items
 * within a group. The right-side figure is right-aligned at the edge with no
 * separator from the left groups (a single space only when it falls back to a
 * left-aligned line). All tok/s figures use the unified plain-integer `tok/s`
 * format (extensions/subagent-live.ts formatTps). Bars are six cells read in half-cells (▌) = 8.3% resolution.
 * Severity: green under 60%, amber past 60%, red past 85%.
 *
 * Context gauge: for openai-compatible models served over a loopback/private
 * host, the gauge denominator is the window the server actually reports —
 * fetched from `${baseUrl}/models` (`data[].max_model_len`), cached 60s, and
 * failing soft to the static models.json value on any error (mirrors
 * `lmstudio-reasoning.ts`). When that live value differs from models.json the
 * file is self-healed (atomic read-modify-write + registry refresh) on
 * session_start, model_select and the footer's 3s tick — in any run mode, not
 * just the TUI.
 *
 * Right side: the tok/s speedometer, right-aligned at the edge (left-aligned
 * fallback when it does not fit). The root figure is a live speedometer of the
 * streaming assistant message — estimated output tokens (chars / 4, mirroring
 * pi's context estimate) over elapsed time since message_start, repainted on
 * the footer's 3s tick — reading 0 tok/s once the message completes. It
 * shows even while the first message of a session streams, before any usage is
 * on the branch. When conductor subagents run (shared in-memory registry,
 * extensions/subagent-live.ts), the right side carries the agent group
 * `N agent(s) | N tok/s` — the SUM of the concurrent per-child rates — and
 * an idle root figure is suppressed; with both active the block is
 * `N tok/s · N agent(s) | N tok/s`, right-aligned as one unit.
 *
 * Left side: two live groups join location/model/cost. The cache group
 * (local servers only, isPrivateServer gate) shows only real data: the last
 * request's cache hit rate (the server reports per-request `cached_tokens`,
 * mapped to `usage.cacheRead`) and a session miss counter (requests with
 * zero cacheRead are full uncached prefills), shown only when greater than
 * 0. No time-based figure is shown because the server exposes no cache state
 * or TTL — invented values are not displayed (user instruction). Additional
 * footer lines (e.g. a task list) compose in below the powerline line via
 * the shared footer-line registry (extensions/footer-lines.ts); none is
 * registered in this repo today.
 *
 * The shell script's plan-usage group (Anthropic OAuth usage endpoint) has no
 * pi equivalent and is intentionally dropped.
 *
 * Toggle with the `--statusline` flag or the `/statusline` command; an active
 * product (whichever shim's `--conductor`/`--refuter` flag or `/conductor`/
 * `/refuter` command is on — see extensions/engine/product-registry.ts)
 * enables it automatically.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CustomEntry, ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTps, subagentLiveSnapshot, type SubagentLiveSample } from "./subagent-live.ts";
import { registerFooterApplier, registerFooterLine, registerFooterTick, unregisterFooterApplier, unregisterFooterLine, unregisterFooterTick } from "./footer-lines.ts";
import { getActiveProductName } from "./engine/product-registry.ts";
import { envSpawnDepth } from "./engine/spawn-depth.ts";

const STATE_KEY = "statusline";

const BAR_CELLS = 6;
const AMBER_AT = 60;
const RED_AT = 85;
const WINDOW_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5000;

interface StatuslineState {
	enabled: boolean;
}

/** A server-reported context window and when it was fetched. */
interface LiveWindow {
	window: number;
	at: number;
}

/** OpenAI-compatible `GET {baseUrl}/models` payload. */
interface OpenAIModelInfo {
	id?: string;
	max_model_len?: number;
}

interface OpenAIModelsResponse {
	data?: OpenAIModelInfo[];
}

/** models.json shape, narrowed to what self-heal reads and writes. */
interface ModelsFile {
	providers?: Record<string, ModelsFileProvider>;
}

interface ModelsFileProvider {
	models?: ModelsFileModel[];
}

interface ModelsFileModel {
	id?: string;
	contextWindow?: number;
}

/** Cache state for the last assistant request on a local server. */
interface CacheState {
	/** cacheRead / (input + cacheRead + cacheWrite) of the last request, 0..1. */
	hitRate: number;
}

function isStatuslineEntry(entry: SessionEntry): entry is CustomEntry<StatuslineState> {
	return entry.type === "custom" && entry.customType === STATE_KEY;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isModelsResponse(value: unknown): value is OpenAIModelsResponse {
	if (typeof value !== "object" || value === null) return false;
	const { data } = value as { data?: unknown };
	return data === undefined || Array.isArray(data);
}

function isModelsFile(value: unknown): value is ModelsFile {
	if (typeof value !== "object" || value === null) return false;
	const providers = (value as { providers?: unknown }).providers;
	return providers === undefined || (typeof providers === "object" && providers !== null);
}

/** 600000 -> 600k, 1000000 -> 1M, 1500000 -> 1.5M, 9600 -> 9.6k */
function formatNumber(n: number): string {
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
	}
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

const CHARS_PER_TOKEN = 4;

/** A toolCall block as it appears on a streaming partial message. */
interface StreamingToolCall {
	type: "toolCall";
	name: string;
	arguments?: unknown;
	partialArgs?: unknown;
}

function toolCallChars(call: StreamingToolCall): number {
	let chars = call.name.length;
	if (typeof call.partialArgs === "string") {
		// While streaming, arguments accumulate as a raw JSON string until toolcall_end.
		chars += call.partialArgs.length;
	} else if (call.arguments !== undefined) {
		chars += JSON.stringify(call.arguments).length;
	}
	return chars;
}

/** Estimated output tokens, mirroring pi's chars/4 context estimate. */
function estimateOutputTokens(message: AssistantMessage): number {
	let chars = 0;
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				chars += block.text.length;
				break;
			case "thinking":
				chars += block.thinking.length;
				break;
			case "toolCall":
				chars += toolCallChars(block);
				break;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function severityColor(percent: number): "success" | "warning" | "error" {
	if (percent >= RED_AT) return "error";
	if (percent >= AMBER_AT) return "warning";
	return "success";
}

/** Six cells in half-cell steps: halves = round(pct * 12 / 100). */
function renderGauge(theme: Theme, percent: number, trailing: string): string {
	const clamped = Math.min(100, Math.max(0, percent));
	const halves = Math.min(BAR_CELLS * 2, Math.round((clamped * BAR_CELLS * 2) / 100));
	const fulls = Math.floor(halves / 2);
	const half = halves % 2;
	const empties = BAR_CELLS - fulls - half;

	const color = severityColor(clamped);
	const fill = theme.fg(color, "█".repeat(fulls) + (half === 1 ? "▌" : ""));
	const empty = theme.fg("borderMuted", "░".repeat(empties));
	const pct = theme.fg(color, `${Math.round(clamped)}%`);

	// Token figures stay dim below the amber threshold and brighten with severity.
	const trail = trailing === "" ? "" : ` ${theme.fg(clamped >= AMBER_AT ? "muted" : "dim", trailing)}`;
	return `${fill}${empty} ${pct}${trail}`;
}

function renderLocation(theme: Theme, cwd: string, branch: string | null): string {
	const dirName = path.basename(cwd) || cwd;
	const location = theme.fg("accent", "▌") + theme.fg("text", dirName);
	if (branch === null) return location;
	return `${location} ${theme.fg("dim", "on")} ${theme.fg("mdLink", branch)}`;
}

/** Right-side agent group: `N agent(s) | N tok/s` (sum of sample rates); "" when none. */
function renderAgents(theme: Theme, samples: SubagentLiveSample[]): string {
	if (samples.length === 0) return "";
	const total = samples.reduce((sum, { tps }) => sum + tps, 0);
	const count = `${samples.length} ${samples.length === 1 ? "agent" : "agents"}`;
	return theme.fg("muted", count) + theme.fg("dim", " | ") + theme.fg("dim", formatTps(total));
}

/** Cache group: the last request's hit rate; ` · n miss` when misses > 0. */
function renderCache(theme: Theme, cache: CacheState | null, misses: number): string {
	if (cache === null) return "";
	const items = [theme.fg("muted", `${Math.round(cache.hitRate * 100)}%`)];
	if (misses > 0) items.push(theme.fg("dim", `${misses} miss`));
	return items.join(theme.fg("dim", " · "));
}

function renderModel(theme: Theme, ctx: ExtensionContext, liveWindow: number | undefined): string {
	const model = ctx.model;
	if (model === undefined) return "";

	const label = theme.fg("muted", `[${model.id}]`);
	const usage = ctx.getContextUsage();
	if (usage === undefined || usage.tokens === null || usage.contextWindow <= 0) return label;

	// Prefer the server-reported window over the static models.json value.
	const window = liveWindow ?? usage.contextWindow;
	if (window <= 0) return label;
	const percent = (usage.tokens / window) * 100;
	const trailing = `${formatNumber(usage.tokens)}/${formatNumber(window)}`;
	return `${label} ${renderGauge(theme, percent, trailing)}`;
}

function renderCost(theme: Theme, ctx: ExtensionContext): string {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isAssistantMessage(message)) continue;
		input += message.usage.input;
		output += message.usage.output;
		cost += message.usage.cost.total;
	}

	if (input === 0 && output === 0) return "";

	// $ figure only when present; items separated by a dim " · ".
	const items = [theme.fg("dim", `↑${formatNumber(input)} ↓${formatNumber(output)}`)];
	if (cost > 0) items.push(theme.fg("dim", `$${cost.toFixed(3)}`));
	return items.join(theme.fg("dim", " · "));
}

function windowKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function modelsUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "") + "/models";
}

function isPrivateHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "::1") return true;
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || !octets.every((n) => Number.isInteger(n))) return false;
	const [a, b] = octets;
	if (a === 127 || a === 10) return true;
	if (a === 192 && b === 168) return true;
	return a === 172 && b >= 16 && b <= 31;
}

/** Never fire the probe at a public API: only loopback/private hosts qualify. */
function isPrivateServer(baseUrl: string): boolean {
	try {
		return isPrivateHost(new URL(baseUrl).hostname);
	} catch {
		return false;
	}
}

function findMaxModelLen(list: OpenAIModelInfo[] | undefined, modelId: string): number | undefined {
	for (const entry of list ?? []) {
		if (entry.id !== modelId) continue;
		const len = entry.max_model_len;
		if (typeof len === "number" && Number.isFinite(len) && len > 0) return len;
	}
	return undefined;
}

/** A `null` header value means "suppress this header", so it is dropped rather than sent. */
function definedHeaders(headers: ProviderHeaders | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result[name] = value;
	}
	return result;
}

async function authHeaders(registry: ExtensionContext["modelRegistry"], model: Model<Api>): Promise<Record<string, string>> {
	const resolved = await registry.getApiKeyAndHeaders(model);
	if (!resolved.ok) return {};

	const headers = definedHeaders(resolved.headers);
	if (!headers["Authorization"] && !headers["authorization"] && resolved.apiKey) {
		headers["Authorization"] = `Bearer ${resolved.apiKey}`;
	}
	return headers;
}

/**
 * Fetch `max_model_len` for the model from an OpenAI-compatible server. Returns
 * undefined on any failure so the caller keeps the static window; a given
 * server is warned about at most once.
 */
async function fetchWindow(
	baseUrl: string,
	modelId: string,
	headers: Record<string, string>,
	warned: Set<string>
): Promise<number | undefined> {
	try {
		const response = await fetch(modelsUrl(baseUrl), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok) throw new Error(`HTTP status ${response.status}`);
		const data: unknown = await response.json();
		if (!isModelsResponse(data)) throw new Error("unexpected /models payload");
		const window = findMaxModelLen(data.data, modelId);
		if (window === undefined) throw new Error(`no max_model_len for ${modelId}`);
		return window;
	} catch (error: unknown) {
		if (!warned.has(baseUrl)) {
			warned.add(baseUrl);
			const reason = error instanceof Error ? error.message : String(error);
			console.warn(`statusline: could not read context window from ${baseUrl} (${reason}); keeping static value.`);
		}
		return undefined;
	}
}

/**
 * Rewrite models.json `contextWindow` to the server-reported value when it
 * differs. Atomic: write a sibling tmp file and rename over the target; every
 * other key and the trailing newline are preserved. Fail soft on any error.
 *
 * Returns whether the in-memory static window still lags the live one, so the
 * caller can defer a registry refresh to turn_end. Refreshing mid-request drops
 * the in-flight auth resolution, so pi throws "Provider is not configured"; the
 * footer gauge reads the live window, so it is accurate without the refresh.
 */
async function selfHeal(ctx: ExtensionContext, model: Model<Api>, liveWindow: number): Promise<boolean> {
	const modelsPath = path.join(getAgentDir(), "models.json");
	let raw: string;
	try {
		raw = await fs.readFile(modelsPath, "utf8");
	} catch {
		return false;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	if (!isModelsFile(parsed)) return false;

	const provider = parsed.providers?.[model.provider];
	const entry = provider?.models?.find(({ id }) => id === model.id);
	if (entry === undefined) return false;

	let changed = false;
	if (entry.contextWindow !== liveWindow) {
		entry.contextWindow = liveWindow;

		// Preserve every other key and the file's trailing-newline convention.
		const serialized = JSON.stringify(parsed, null, 2) + (raw.endsWith("\n") ? "\n" : "");
		const tmpPath = `${modelsPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fs.writeFile(tmpPath, serialized, "utf8");
			await fs.rename(tmpPath, modelsPath);
			changed = true;
		} catch {
			await fs.unlink(tmpPath).catch(() => {});
		}
	}

	if (changed && ctx.hasUI) {
		ctx.ui.notify(`Context window synced to ${formatNumber(liveWindow)} — server reports max_model_len ${liveWindow}`, "info");
	}

	return model.contextWindow !== liveWindow;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	// Last observed conductor state; the auto-enable fires only on an off->on edge.
	let lastConductorState = false;

	// Server-reported context windows keyed by provider/model; in-flight fetches
	// deduped per key so the 3s tick never double-fires.
	const liveWindows = new Map<string, LiveWindow>();
	const inFlight = new Map<string, Promise<void>>();
	const warnedServers = new Set<string>();
	const warnedRefresh = new Set<string>();

	// Live speedometer for the streaming assistant message's tok/s: t0 is the
	// message_start baseline, lastPartial the newest partial message, lastTps
	// the idle display value (0 once a message completes).
	let t0: number | null = null;
	let lastPartial: AssistantMessage | null = null;
	let lastTps: number | undefined = undefined;
	// Set by selfHeal when the in-memory static window still lags the live one;
	// cleared once turn_end refreshes the registry.
	let needsRegistryRefresh = false;

	// Cache tracking for local servers, recorded on assistant message_end.
	let cacheState: CacheState | null = null;
	let cacheMisses = 0;

	pi.registerFlag("statusline", {
		description: "Replace the built-in footer with the powerline statusline",
		type: "boolean",
		default: false,
	});

	function liveWindowFor(model: Model<Api>): number | undefined {
		return liveWindows.get(windowKey(model))?.window;
	}

	async function refreshWindow(ctx: ExtensionContext): Promise<void> {
		const model = ctx.model;
		if (model === undefined || model.api !== "openai-completions") return;
		if (typeof model.baseUrl !== "string" || model.baseUrl === "") return;
		if (!isPrivateServer(model.baseUrl)) return;

		const key = windowKey(model);
		const cached = liveWindows.get(key);
		if (cached !== undefined && Date.now() - cached.at < WINDOW_TTL_MS) return;

		const pending = inFlight.get(key);
		if (pending !== undefined) {
			await pending;
			return;
		}

		const run = (async (): Promise<void> => {
			try {
				const headers = await authHeaders(ctx.modelRegistry, model);
				const window = await fetchWindow(model.baseUrl, model.id, headers, warnedServers);
				if (window === undefined) return;
				liveWindows.set(key, { window, at: Date.now() });
				needsRegistryRefresh = await selfHeal(ctx, model, window);
			} catch (error: unknown) {
				// The session can end while the fetch is in flight (print mode),
				// leaving the captured ctx stale — a normal stop, not a fault.
				const stale = error instanceof Error && error.message.includes("stale");
				if (!stale && !warnedRefresh.has(key)) {
					warnedRefresh.add(key);
					const reason = error instanceof Error ? error.message : String(error);
					console.warn(`statusline: context-window refresh failed (${reason}); keeping static value.`);
				}
			}
		})();

		inFlight.set(key, run);
		try {
			await run;
		} finally {
			inFlight.delete(key);
		}
	}

	/** The powerline line only; the task line below it is a separate footer-line provider. */
	function renderStatuslineLine(width: number, theme: Theme, footerData: ReadonlyFooterDataProvider, ctx: ExtensionContext): string {
		const separator = theme.fg("border", " │ ");
		const dimSep = theme.fg("dim", " · ");
		const model = ctx.model;
		const liveWindow = model === undefined ? undefined : liveWindowFor(model);
		let tokensPerSecond: number | null;
		if (t0 !== null) {
			const elapsedMs = Date.now() - t0;
			const tokens = lastPartial === null ? 0 : estimateOutputTokens(lastPartial);
			tokensPerSecond = elapsedMs > 0 ? tokens / (elapsedMs / 1000) : 0;
		} else {
			tokensPerSecond = lastTps ?? null;
		}
		const cost = renderCost(theme, ctx);
		const samples = subagentLiveSnapshot();
		const left = [
			renderLocation(theme, ctx.cwd, footerData.getGitBranch()),
			renderModel(theme, ctx, liveWindow),
			renderCache(theme, cacheState, cacheMisses),
			cost,
		].filter((group) => group !== "").join(separator);

		// Right side: root t/s and/or the agent group, one right-aligned unit.
		const rootFigure = tokensPerSecond === null ? null : theme.fg("dim", formatTps(tokensPerSecond));
		const agents = renderAgents(theme, samples);
		let right = "";
		if (agents !== "") {
			// An idle root figure is suppressed while agents run.
			right = t0 !== null && rootFigure !== null ? rootFigure + dimSep + agents : agents;
		} else {
			right = rootFigure ?? "";
		}

		if (right === "") return truncateToWidth(left, width);
		// Right-align the block to the edge; fall back to the
		// left-aligned line when it does not fit. No separator between
		// the left groups and the right block — a single space in the
		// fallback keeps the cost figure from gluing to the counter.
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap <= 0) return truncateToWidth(left + " " + right, width);
		return left + " ".repeat(gap) + right;
	}

	function applyFooter(ctx: ExtensionContext): void {
		registerFooterApplier(STATE_KEY, (factory) => ctx.ui.setFooter(factory));
		if (!enabled) {
			unregisterFooterLine(STATE_KEY);
			unregisterFooterTick(STATE_KEY);
			return;
		}
		registerFooterLine({
			id: STATE_KEY,
			priority: 0,
			render: (w, t, fd) => renderStatuslineLine(w, t, fd, ctx),
		});
		registerFooterTick(STATE_KEY, () => {
			void refreshWindow(ctx);
		});
	}

	function persistState(): void {
		pi.appendEntry(STATE_KEY, { enabled } satisfies StatuslineState);
	}

	// The active product (its shim owns the flag/command and session state, not
	// this extension — a duplicate flag/command registration is a fatal load
	// conflict) wins; a fresh session with none active falls back to the launch
	// argv, mirroring each shim's own process.env / --flag reads. A spawned
	// subagent child (depth > 0) is headless and gets its own brief, not the
	// orchestrator persona (see engine/orchestrator.ts), so its footer never
	// auto-enables even though it inherits the parent's PI_CONDUCTOR_PRODUCT.
	function conductorEnabled(): boolean {
		if (envSpawnDepth() > 0) return false;
		if (getActiveProductName() !== undefined) return true;
		return process.argv.includes("--conductor") || process.argv.includes("--refuter");
	}

	pi.registerCommand("statusline", {
		description: "Toggle the powerline statusline footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			applyFooter(ctx);
			persistState();
			ctx.ui.notify(enabled ? "Statusline enabled." : "Default footer restored.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("statusline") === true) enabled = true;

		const restored = ctx.sessionManager.getEntries().filter(isStatuslineEntry).pop();
		if (restored?.data !== undefined) enabled = restored.data.enabled;

		// An active product implies the footer, even over a restored "off"; the
		// tracker seeds here so the auto-enable below only fires on a fresh off->on.
		lastConductorState = conductorEnabled();
		if (lastConductorState) enabled = true;

		// Fresh session: drop the live-window cache and reset tok/s timing and
		// cache tracking.
		liveWindows.clear();
		inFlight.clear();
		t0 = null;
		lastPartial = null;
		lastTps = undefined;
		needsRegistryRefresh = false;
		cacheState = null;
		cacheMisses = 0;

		applyFooter(ctx);
		// Not gated on TUI mode: the self-heal must run in print mode too.
		void refreshWindow(ctx);
	});

	// Auto-enable only on an off->on active-product transition, so an explicit
	// /statusline off is respected until the product is toggled off and on.
	// The auto-enable is deliberately not persisted.
	pi.on("turn_start", (_event, ctx) => {
		const conductor = conductorEnabled();
		if (conductor && !lastConductorState) {
			enabled = true;
			applyFooter(ctx);
			ctx.ui.notify("Statusline enabled by conductor mode.", "info");
		}
		lastConductorState = conductor;
	});

	pi.on("model_select", async (_event, ctx) => {
		// A non-private model has no cache telemetry: drop the previous server's stale hit rate.
		const model = ctx.model;
		if (
			model === undefined ||
			typeof model.baseUrl !== "string" ||
			model.baseUrl === "" ||
			!isPrivateServer(model.baseUrl)
		) {
			cacheState = null;
			cacheMisses = 0;
		}
		void refreshWindow(ctx);
	});

	// A registry refresh must never run while a provider request is in flight
	// (it drops the in-flight auth resolution and makes pi throw "Provider is
	// not configured"). turn_end is idle, so it is the safe point to apply the
	// deferred refresh that selfHeal requested.
	pi.on("turn_end", async (_event, ctx) => {
		if (!needsRegistryRefresh) return;
		needsRegistryRefresh = false;
		try {
			await ctx.modelRegistry.refresh();
		} catch {
			// stale ctx (session ending): models.json is already corrected
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unregisterFooterLine(STATE_KEY);
		unregisterFooterTick(STATE_KEY);
		unregisterFooterApplier(STATE_KEY);
		ctx.ui.setFooter(undefined);
	});

	pi.on("message_start", (event) => {
		if (!isAssistantMessage(event.message)) return;
		t0 = Date.now();
		lastPartial = null;
	});

	pi.on("message_update", (event) => {
		if (!isAssistantMessage(event.message)) return;
		lastPartial = event.message;
	});

	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		t0 = null;
		lastPartial = null;
		lastTps = 0;

		// Cache tracking: local servers only, requests with usage only.
		const model = ctx.model;
		if (model === undefined || typeof model.baseUrl !== "string" || model.baseUrl === "") return;
		if (!isPrivateServer(model.baseUrl)) return;
		const { input, cacheRead, cacheWrite } = event.message.usage;
		const denominator = input + cacheRead + cacheWrite;
		if (denominator <= 0) return;
		cacheState = { hitRate: cacheRead / denominator };
		// Zero cacheRead is a full uncached prefill.
		if (cacheRead === 0) cacheMisses += 1;
	});
}
