/**
 * Statusline Footer
 *
 * Replaces pi's built-in footer with the powerline layout from
 * `claude/plugins/statusline/scripts/statusline.sh`:
 *
 *   ▌dir on branch │ [model] ██▌░░░ 40% 397k/1M │ ↑in ↓out $cost
 *
 * Two separator weights: │ divides the groups (where you are / what you are
 * talking to and how full it is / what the session has cost), · separates items
 * within a group. Bars are six cells read in half-cells (▌) = 8.3% resolution.
 * Severity: green under 60%, amber past 60%, red past 85%.
 *
 * The shell script's plan-usage group (Anthropic OAuth usage endpoint) has no
 * pi equivalent and is intentionally dropped.
 *
 * Toggle with the `--statusline` flag or the `/statusline` command.
 */

import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const STATE_KEY = "statusline";

const BAR_CELLS = 6;
const AMBER_AT = 60;
const RED_AT = 85;

interface StatuslineState {
	enabled: boolean;
}

function isStatuslineEntry(entry: SessionEntry): entry is CustomEntry<StatuslineState> {
	return entry.type === "custom" && entry.customType === STATE_KEY;
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

function renderModel(theme: Theme, ctx: ExtensionContext): string {
	const model = ctx.model;
	if (model === undefined) return "";

	const label = theme.fg("muted", `[${model.id}]`);
	const usage = ctx.getContextUsage();
	if (usage === undefined || usage.tokens === null || usage.contextWindow <= 0) return label;

	// `percent` is null exactly when tokens is; derive it only as a fallback.
	const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
	const trailing = `${formatNumber(usage.tokens)}/${formatNumber(usage.contextWindow)}`;
	return `${label} ${renderGauge(theme, percent, trailing)}`;
}

function renderCost(theme: Theme, ctx: ExtensionContext): string {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message: AssistantMessage = entry.message;
			input += message.usage.input;
			output += message.usage.output;
			cost += message.usage.cost.total;
		}
	}

	if (input === 0 && output === 0) return "";
	return theme.fg("dim", `↑${formatNumber(input)} ↓${formatNumber(output)} $${cost.toFixed(3)}`);
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	pi.registerFlag("statusline", {
		description: "Replace the built-in footer with the powerline statusline",
		type: "boolean",
		default: false,
	});

	function applyFooter(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const separator = theme.fg("border", " │ ");
					const groups = [
						renderLocation(theme, ctx.cwd, footerData.getGitBranch()),
						renderModel(theme, ctx),
						renderCost(theme, ctx),
					].filter((group) => group !== "");

					return [truncateToWidth(groups.join(separator), width)];
				},
			};
		});
	}

	function persistState(): void {
		pi.appendEntry(STATE_KEY, { enabled } satisfies StatuslineState);
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

		applyFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});
}
