/**
 * Task Tools - Persisted TaskCreate/TaskGet/TaskUpdate/TaskList
 *
 * Registers the four tools the conductor prompts already describe, backed by
 * one JSON file per project, byte-identical in name to Claude Code's own
 * task-list tools so the conductor prompts need no rewrite.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TASK_STORE_ENV = "PI_CONDUCTOR_TASK_STORE";

type TaskStatus = "pending" | "in_progress" | "completed";

interface TaskRecord {
	id: number;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string;
	metadata?: Record<string, unknown>;
	blocks: number[];
	blockedBy: number[];
	createdAt: string;
	updatedAt: string;
}

interface TaskStore {
	nextId: number;
	tasks: TaskRecord[];
}

/**
 * Lives under the user's pi agent dir (an analogue of Claude Code's per-list
 * task directory), keyed by project path, so no consumer repo gets a stray
 * file, the list survives across sessions, and the conductor plus every child
 * `pi` process it spawns share it because the key is the project path, not
 * the session. TASK_STORE_ENV lets a child spawned with a different cwd still
 * reach its parent's store.
 */
export function resolveTaskStorePath(cwd: string): string {
	const envPath = process.env[TASK_STORE_ENV];
	if (envPath) return envPath;
	const abs = path.resolve(cwd);
	const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
	return path.join(getAgentDir(), "conductor", "tasks", `${path.basename(abs)}-${hash}.json`);
}

function readStore(storePath: string): TaskStore {
	try {
		const raw = fs.readFileSync(storePath, "utf8");
		return JSON.parse(raw) as TaskStore;
	} catch (err: unknown) {
		const isMissing = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
		if (isMissing) return { nextId: 1, tasks: [] };
		throw err;
	}
}

// Tmp+rename makes this write atomic; it gives no read-modify-write atomicity on its own.
function writeStore(storePath: string, store: TaskStore): void {
	fs.mkdirSync(path.dirname(storePath), { recursive: true });
	const tmpPath = `${storePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, JSON.stringify(store, null, "\t"));
	fs.renameSync(tmpPath, storePath);
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cross-process read-modify-write atomicity for the shared store; withFileMutationQueue
// only serializes within one process, and TASK_STORE_ENV deliberately shares one store
// across processes.
async function acquireStoreLock(storePath: string): Promise<string> {
	const lockPath = `${storePath}.lock`;
	fs.mkdirSync(path.dirname(storePath), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return lockPath;
		} catch (err: unknown) {
			const isExists = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
			if (!isExists) throw err;
			const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
			// A crashed holder never reaches its finally-block unlink; treat an old lock as abandoned.
			if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				fs.rmSync(lockPath, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for task store lock: ${lockPath}`);
			await delay(LOCK_RETRY_INTERVAL_MS);
		}
	}
}

function releaseStoreLock(lockPath: string): void {
	fs.rmSync(lockPath, { force: true });
}

async function withStoreLock<T>(storePath: string, fn: () => T | Promise<T>): Promise<T> {
	const lockPath = await acquireStoreLock(storePath);
	try {
		return await fn();
	} finally {
		releaseStoreLock(lockPath);
	}
}

function normalizeTaskId(taskId: string): number {
	const cleaned = taskId.startsWith("#") ? taskId.slice(1) : taskId;
	return Number(cleaned);
}

function findTask(store: TaskStore, id: number): TaskRecord | undefined {
	return store.tasks.find((task) => task.id === id);
}

function requireTask(store: TaskStore, taskId: string): TaskRecord {
	const task = findTask(store, normalizeTaskId(taskId));
	if (!task) throw new Error(`Task #${taskId.replace(/^#/, "")} not found`);
	return task;
}

// Auto-status: mechanical completion on a complete worker return. A missing task (deleted
// after dispatch) is a silent no-op — the store must never break the dispatch.
export async function completeTaskStatus(storePath: string, taskId: number): Promise<void> {
	await withStoreLock(storePath, () => {
		const store = readStore(storePath);
		const task = findTask(store, taskId);
		if (!task) return;
		task.status = "completed";
		task.updatedAt = new Date().toISOString();
		writeStore(storePath, store);
	});
}

function mergeMetadata(
	existing: Record<string, unknown> | undefined,
	patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!patch) return existing;
	const next = { ...(existing ?? {}) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

// Returns the raw ids that did not resolve to an existing task, so the caller can
// reject the update instead of silently dropping a blocker relation.
function addRelation(
	store: TaskStore,
	task: TaskRecord,
	rawIds: string[] | undefined,
	ownField: "blocks" | "blockedBy",
	otherField: "blocks" | "blockedBy",
): string[] {
	if (!rawIds) return [];
	const unresolved: string[] = [];
	for (const rawId of rawIds) {
		const other = findTask(store, normalizeTaskId(rawId));
		if (!other) {
			unresolved.push(rawId);
			continue;
		}
		if (!task[ownField].includes(other.id)) task[ownField].push(other.id);
		if (!other[otherField].includes(task.id)) other[otherField].push(task.id);
	}
	return unresolved;
}

function openBlockerIds(store: TaskStore, task: TaskRecord): number[] {
	return task.blockedBy.filter((id) => {
		const blocker = findTask(store, id);
		return blocker && blocker.status !== "completed";
	});
}

function formatTaskGet(store: TaskStore, task: TaskRecord): string {
	const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
	if (task.owner) lines.push(`Owner: ${task.owner}`);
	const openBlockers = openBlockerIds(store, task);
	if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map((id) => `#${id}`).join(", ")}`);
	if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
	lines.push(`Description: ${task.description}`);
	return lines.join("\n");
}

function formatTaskList(store: TaskStore): string {
	if (store.tasks.length === 0) return "No tasks.";
	const sorted = [...store.tasks].sort((a, b) => a.id - b.id);
	return sorted
		.map((task) => {
			const openBlockers = openBlockerIds(store, task);
			const suffix = openBlockers.length > 0 ? ` (blocked by ${openBlockers.map((id) => `#${id}`).join(", ")})` : "";
			return `#${task.id} [${task.status}] ${task.subject}${suffix}`;
		})
		.join("\n");
}

const TaskCreateParams = Type.Object({
	subject: Type.String({ description: "Short title for the task" }),
	description: Type.String({ description: "Full task description" }),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous form of the subject, shown while the task is in progress" }),
	),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary structured metadata" })),
});

const TaskGetParams = Type.Object({
	taskId: Type.String({ description: "Task id, with or without a leading #" }),
});

const TaskUpdateStatus = StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
	description: 'New status; "deleted" removes the task',
});

const TaskUpdateParams = Type.Object({
	taskId: Type.String({ description: "Task id, with or without a leading #" }),
	status: Type.Optional(TaskUpdateStatus),
	subject: Type.Optional(Type.String({ description: "New subject" })),
	description: Type.Optional(Type.String({ description: "New description (replaces the entire description; to append, read the current one with TaskGet and send the full text)" })),
	activeForm: Type.Optional(Type.String({ description: "New active-form text" })),
	owner: Type.Optional(Type.String({ description: "New owner" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Metadata to merge; a null value deletes the key" }),
	),
	addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task ids that this task blocks" })),
	addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that block this task" })),
});

const TaskListParams = Type.Object({});

export function registerTaskTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "TaskCreate",
		label: "TaskCreate",
		description: "Create a task on the project task list. New tasks start as pending.",
		promptSnippet: "TaskCreate: add a task (subject, description, activeForm) to the project task list",
		parameters: TaskCreateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storePath = resolveTaskStorePath(ctx.cwd);
			return withFileMutationQueue(storePath, () =>
				withStoreLock(storePath, async () => {
					const store = readStore(storePath);
					const now = new Date().toISOString();
					const task: TaskRecord = {
						id: store.nextId++,
						subject: params.subject,
						description: params.description,
						activeForm: params.activeForm,
						status: "pending",
						metadata: params.metadata,
						blocks: [],
						blockedBy: [],
						createdAt: now,
						updatedAt: now,
					};
					store.tasks.push(task);
					writeStore(storePath, store);
					return {
						content: [{ type: "text", text: `Created task #${task.id}: ${task.subject}` }],
						details: { id: task.id },
					};
				}),
			);
		},
	});

	pi.registerTool({
		name: "TaskGet",
		label: "TaskGet",
		description: "Retrieve a task by id from the project task list.",
		promptSnippet: "TaskGet: retrieve a task's full details by id",
		parameters: TaskGetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storePath = resolveTaskStorePath(ctx.cwd);
			const store = readStore(storePath);
			const task = requireTask(store, params.taskId);
			return {
				content: [{ type: "text", text: formatTaskGet(store, task) }],
				details: { id: task.id },
			};
		},
	});

	pi.registerTool({
		name: "TaskUpdate",
		label: "TaskUpdate",
		description:
			"Update a task's status, fields, metadata, or block relationships on the project task list. " +
			'Set status to "deleted" to remove the task.',
		promptSnippet: "TaskUpdate: change a task's status, fields, metadata, or blocking relationships",
		parameters: TaskUpdateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storePath = resolveTaskStorePath(ctx.cwd);
			return withFileMutationQueue(storePath, () =>
				withStoreLock(storePath, async () => {
					const store = readStore(storePath);
					const task = requireTask(store, params.taskId);

					if (params.status === "deleted") {
						const subject = task.subject;
						store.tasks = store.tasks.filter((t) => t.id !== task.id);
						for (const other of store.tasks) {
							other.blocks = other.blocks.filter((id) => id !== task.id);
							other.blockedBy = other.blockedBy.filter((id) => id !== task.id);
						}
						writeStore(storePath, store);
						return {
							content: [{ type: "text", text: `Deleted task #${task.id}: ${subject}` }],
							details: { id: task.id, deleted: true },
						};
					}

					if (params.status) task.status = params.status;
					if (params.subject !== undefined) task.subject = params.subject;
					if (params.description !== undefined) task.description = params.description;
					if (params.activeForm !== undefined) task.activeForm = params.activeForm;
					if (params.owner !== undefined) task.owner = params.owner;
					task.metadata = mergeMetadata(task.metadata, params.metadata);
					// Reject the whole update before persisting anything if a blocker id doesn't
					// resolve, rather than silently dropping the relation (the review gate depends
					// on blockedBy wiring being reliable).
					const unresolved = [
						...addRelation(store, task, params.addBlocks, "blocks", "blockedBy"),
						...addRelation(store, task, params.addBlockedBy, "blockedBy", "blocks"),
					];
					if (unresolved.length > 0) {
						throw new Error(`Unknown task id(s) referenced: ${unresolved.join(", ")}`);
					}
					task.updatedAt = new Date().toISOString();

					writeStore(storePath, store);
					return {
						content: [{ type: "text", text: `Updated task #${task.id}: ${task.subject}` }],
						details: { id: task.id },
					};
				}),
			);
		},
	});

	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description: "List every task on the project task list.",
		promptSnippet: "TaskList: list all tasks on the project task list",
		parameters: TaskListParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const storePath = resolveTaskStorePath(ctx.cwd);
			const store = readStore(storePath);
			return {
				content: [{ type: "text", text: formatTaskList(store) }],
				details: { count: store.tasks.length },
			};
		},
	});
}
