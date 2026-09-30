/**
 * Task-list footer rows
 *
 * Renders the root orchestrator's task list below the statusline's powerline
 * line (extensions/statusline.ts), one task per row, composed through the
 * shared footer-line registry (extensions/footer-lines.ts) as a multi-row
 * provider.
 *
 * Data source: the task store of extensions/engine/tasks.ts, resolved via
 * resolveTaskStorePath and refreshed async on session_start and the 3s
 * footer tick.
 *
 * Window: five task rows at a time, sorted in_progress then pending then
 * completed (done struck through and at the bottom); a static window with
 * a final dim `N more` row when the store holds more than five tasks. The
 * provider renders null when the store is empty/missing or the width is
 * < 8 cells.
 *
 * Toggle with the `--tasklist` flag or the `/tasklist` command; an active
 * product (see extensions/engine/product-registry.ts) enables it
 * automatically, except in a spawned subagent child.
 */

import * as fs from "node:fs/promises";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerFooterApplier, registerFooterLine, registerFooterTick, unregisterFooterApplier, unregisterFooterLine, unregisterFooterTick } from "./footer-lines.ts";
import { getActiveProductName } from "./engine/product-registry.ts";
import { envSpawnDepth } from "./engine/spawn-depth.ts";
import { resolveTaskStorePath } from "./engine/tasks.ts";
import { claimExtension } from "./load-guard.ts";

const STATE_KEY = "tasklist";
const TASK_WINDOW = 5;
// Hide the rows when the footer width drops below this.
const TASK_MIN_ROW_CELLS = 8;

/** Task store (extensions/engine/tasks.ts), narrowed to the footer's needs. */
type TaskStatus = "pending" | "in_progress" | "completed";

interface TaskItem {
	id: number;
	subject: string;
	status: TaskStatus;
}

interface TaskStoreFile {
	tasks: TaskItem[];
}

interface TasklistState {
	enabled: boolean;
}

function isTasklistEntry(entry: SessionEntry): entry is CustomEntry<TasklistState> {
	return entry.type === "custom" && entry.customType === STATE_KEY;
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

function isTaskItem(value: unknown): value is TaskItem {
	if (typeof value !== "object" || value === null) return false;
	const { id, subject, status } = value as { id?: unknown; subject?: unknown; status?: unknown };
	return typeof id === "number" && typeof subject === "string" && isTaskStatus(status);
}

function isTaskStore(value: unknown): value is TaskStoreFile {
	if (typeof value !== "object" || value === null) return false;
	const tasks = (value as { tasks?: unknown }).tasks;
	return Array.isArray(tasks) && tasks.every(isTaskItem);
}

/** Display order of the task rows: active first, done at the bottom. */
const TASK_STATUS_ORDER: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };

function renderTaskItem(theme: Theme, task: TaskItem, budget: number): string {
	if (task.status === "completed") {
		const id = `#${task.id}`;
		const title = truncateToWidth(task.subject, budget - visibleWidth(id) - 1);
		return `${theme.fg("dim", id)} ${theme.strikethrough(theme.fg("dim", title))}`;
	}
	const marker = task.status === "in_progress" ? theme.fg("accent", "▶") : theme.fg("dim", "·");
	const text = theme.fg("text", truncateToWidth(`#${task.id} ${task.subject}`, budget - visibleWidth(marker) - 1));
	return `${marker} ${text}`;
}

/**
 * The task rows, one full-width row per task: a static five-wide window over
 * the store sorted by TASK_STATUS_ORDER (id ascending within a status), plus
 * a dim `N more` row when the store holds more than five tasks. null when
 * the store is empty or the width is too small.
 */
function renderTaskRows(theme: Theme, tasks: TaskItem[] | null, width: number): string[] | null {
	if (tasks === null || tasks.length === 0) return null;
	if (width < TASK_MIN_ROW_CELLS) return null;

	const sorted = [...tasks].sort((a, b) => TASK_STATUS_ORDER[a.status] - TASK_STATUS_ORDER[b.status] || a.id - b.id);
	const shown = sorted.slice(0, TASK_WINDOW);
	const more = sorted.length - shown.length;
	const rows = shown.map((task) => renderTaskItem(theme, task, width));
	return more > 0 ? [...rows, theme.fg("dim", `${more} more`)] : rows;
}

export default function (pi: ExtensionAPI) {
	if (!claimExtension(pi, "core.task-list")) return;

	let enabled = false;
	// Last observed active-product state; the auto-enable fires only on an off->on edge.
	let lastConductorState = false;

	// Task-store snapshot (async refresh on session_start + the 3s tick; null
	// hides the rows).
	let snapshot: TaskItem[] | null = null;

	pi.registerFlag("tasklist", {
		description: "Show the orchestrator task list under the statusline, one task per row",
		type: "boolean",
		default: false,
	});

	/**
	 * Refresh the task-store snapshot. Fail-soft: a missing/unreadable store
	 * hides the rows; a parse error keeps the last good snapshot.
	 */
	async function refreshTasks(ctx: ExtensionContext): Promise<void> {
		let raw: string;
		try {
			raw = await fs.readFile(resolveTaskStorePath(ctx.sessionManager.getSessionId()), "utf8");
		} catch {
			snapshot = null;
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isTaskStore(parsed)) return;
		snapshot = parsed.tasks;
	}

	function applyState(ctx: ExtensionContext): void {
		registerFooterApplier(STATE_KEY, (factory) => ctx.ui.setFooter(factory));
		if (!enabled) {
			unregisterFooterLine(STATE_KEY);
			unregisterFooterTick(STATE_KEY);
			return;
		}
		registerFooterLine({
			id: STATE_KEY,
			priority: 1,
			render: (w, t, _fd) => renderTaskRows(t, snapshot, w),
		});
		registerFooterTick(STATE_KEY, () => {
			void refreshTasks(ctx);
		});
	}

	function persistState(): void {
		pi.appendEntry(STATE_KEY, { enabled } satisfies TasklistState);
	}

	// Mirrors statusline.ts: the active product (owned by its shim) wins; a fresh
	// session with none active falls back to the launch argv. A spawned child
	// (depth > 0) never auto-enables, though it inherits PI_CONDUCTOR_PRODUCT.
	function conductorEnabled(): boolean {
		if (envSpawnDepth() > 0) return false;
		if (getActiveProductName() !== undefined) return true;
		return process.argv.includes("--conductor") || process.argv.includes("--refuter");
	}

	pi.registerCommand("tasklist", {
		description: "Toggle the task-list footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			applyState(ctx);
			persistState();
			ctx.ui.notify(enabled ? "Task list enabled." : "Task list disabled.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("tasklist") === true) enabled = true;

		const restored = ctx.sessionManager.getEntries().filter(isTasklistEntry).pop();
		if (restored?.data !== undefined) enabled = restored.data.enabled;

		// An active product implies the task list, even over a restored "off"; the
		// tracker seeds here so the auto-enable below only fires on a fresh off->on.
		lastConductorState = conductorEnabled();
		if (lastConductorState) enabled = true;

		snapshot = null;

		applyState(ctx);
		void refreshTasks(ctx);
	});

	// Auto-enable only on an off->on active-product transition, so an explicit
	// /tasklist off is respected until the product is toggled off and on.
	// The auto-enable is deliberately not persisted.
	pi.on("turn_start", (_event, ctx) => {
		const conductor = conductorEnabled();
		if (conductor && !lastConductorState) {
			enabled = true;
			applyState(ctx);
			ctx.ui.notify(`Task list enabled by ${getActiveProductName() ?? "orchestrator"} mode.`, "info");
		}
		lastConductorState = conductor;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unregisterFooterLine(STATE_KEY);
		unregisterFooterTick(STATE_KEY);
		unregisterFooterApplier(STATE_KEY);
		ctx.ui.setFooter(undefined);
	});
}
