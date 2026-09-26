/**
 * Task-list footer line
 *
 * Renders the conductor's task list on its own line below the statusline's
 * powerline line (extensions/statusline.ts), composed through the shared
 * footer-line registry (extensions/footer-lines.ts).
 *
 * Data source: the task store of extensions/conductor/tasks.ts, resolved via
 * resolveTaskStorePath and refreshed async on session_start and the 3s
 * footer tick.
 *
 * Window: five titles at a time, sorted in_progress then pending then
 * completed (done struck through and at the bottom); a static window with
 * an `N more` count when the store holds more than five tasks. The line
 * renders null when the store is empty/missing or the per-item budget is
 * < 8 cells.
 *
 * Toggle with the `--tasklist` flag or the `/tasklist` command; conductor
 * mode (extensions/conductor/orchestrator.ts) enables it automatically.
 */

import * as fs from "node:fs/promises";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerFooterApplier, registerFooterLine, registerFooterTick, unregisterFooterApplier, unregisterFooterLine, unregisterFooterTick } from "./footer-lines.ts";
import { resolveTaskStorePath } from "./conductor/tasks.ts";

const STATE_KEY = "tasklist";
const TASK_WINDOW = 5;
// Hide the line when the per-item budget drops below this.
const TASK_MIN_ITEM_CELLS = 8;

/** Conductor task store (extensions/conductor/tasks.ts), narrowed to the footer's needs. */
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

/** Conductor mode's session entry (see extensions/conductor/orchestrator.ts). */
interface ConductorModeState {
	enabled: boolean;
}

function isConductorModeEntry(entry: SessionEntry): entry is CustomEntry<ConductorModeState> {
	return entry.type === "custom" && entry.customType === "conductor-mode";
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

/** Display order of the task line: active first, done at the bottom. */
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
 * The full-width task line: a static five-wide window over the store sorted
 * by TASK_STATUS_ORDER (id ascending within a status), with an `N more`
 * count when the store holds more than five tasks. null when the store is
 * empty or the per-item budget is too small.
 */
function renderTaskLine(theme: Theme, tasks: TaskItem[] | null, width: number): string | null {
	if (tasks === null || tasks.length === 0) return null;

	const sorted = [...tasks].sort((a, b) => TASK_STATUS_ORDER[a.status] - TASK_STATUS_ORDER[b.status] || a.id - b.id);
	const shown = sorted.slice(0, TASK_WINDOW);
	const more = sorted.length - shown.length;
	const indicator = more > 0 ? `${more} more` : "";
	const itemSep = theme.fg("dim", " · ");
	const taken = (shown.length - 1) * visibleWidth(itemSep) + (indicator === "" ? 0 : visibleWidth(itemSep) + visibleWidth(indicator));
	const perItem = Math.floor((width - taken) / shown.length);
	if (perItem < TASK_MIN_ITEM_CELLS) return null;

	const group = shown.map((task) => renderTaskItem(theme, task, perItem)).join(itemSep);
	return indicator === "" ? group : group + itemSep + theme.fg("dim", indicator);
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	// Last observed conductor state; the auto-enable fires only on an off->on edge.
	let lastConductorState = false;

	// Task-store snapshot (async refresh on session_start + the 3s tick; null
	// hides the line).
	let snapshot: TaskItem[] | null = null;

	pi.registerFlag("tasklist", {
		description: "Show the conductor task list on its own line under the statusline",
		type: "boolean",
		default: false,
	});

	/**
	 * Refresh the task-store snapshot. Fail-soft: a missing/unreadable store
	 * hides the line; a parse error keeps the last good snapshot.
	 */
	async function refreshTasks(ctx: ExtensionContext): Promise<void> {
		let raw: string;
		try {
			raw = await fs.readFile(resolveTaskStorePath(ctx.cwd), "utf8");
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
			render: (w, t, _fd) => renderTaskLine(t, snapshot, w),
		});
		registerFooterTick(STATE_KEY, () => {
			void refreshTasks(ctx);
		});
	}

	function persistState(): void {
		pi.appendEntry(STATE_KEY, { enabled } satisfies TasklistState);
	}

	// The last conductor-mode session entry wins (in-session /conductor toggles);
	// a fresh session with no entry falls back to the --conductor CLI flag.
	function conductorEnabled(ctx: ExtensionContext): boolean {
		const restored = ctx.sessionManager.getEntries().filter(isConductorModeEntry).pop();
		if (restored?.data !== undefined) return restored.data.enabled;
		// getFlag is scoped to this extension's own flags, so the conductor flag (registered by the
		// orchestrator) reads undefined here; a duplicate registration is a fatal load conflict.
		// Read the launch flag from argv instead, mirroring the conductor extension's process.env reads.
		return process.argv.includes("--conductor");
	}

	pi.registerCommand("tasklist", {
		description: "Toggle the task-list footer line",
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

		// Conductor mode implies the task line, even over a restored "off"; the
		// tracker seeds here so the auto-enable below only fires on a fresh off->on.
		lastConductorState = conductorEnabled(ctx);
		if (lastConductorState) enabled = true;

		snapshot = null;

		applyState(ctx);
		void refreshTasks(ctx);
	});

	// Auto-enable only on an off->on conductor transition, so an explicit
	// /tasklist off is respected until the conductor is toggled off and on.
	// The auto-enable is deliberately not persisted.
	pi.on("turn_start", (_event, ctx) => {
		const conductor = conductorEnabled(ctx);
		if (conductor && !lastConductorState) {
			enabled = true;
			applyState(ctx);
			ctx.ui.notify("Task list enabled by conductor mode.", "info");
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
