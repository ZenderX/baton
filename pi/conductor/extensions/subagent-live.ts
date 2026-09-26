/**
 * Live registry of running subagents, shared between the conductor
 * extension (extensions/conductor/index.ts) and the statusline footer
 * (extensions/statusline.ts).
 *
 * pi's loader compiles each extension with its own jiti instance
 * (moduleCache: false, no shared parentCache), so the two extensions get
 * separate instances of this module — a plain module-level Map would be
 * invisible to the other. The registry therefore lives on globalThis behind
 * a Symbol.for key: every jiti instance in one process shares the process's
 * symbol registry and globalThis, so they all share the same Map. Children
 * run in their own process with their own globalThis, which is correct — a
 * child's footer is headless. Nothing is persisted.
 *
 * Children run with --no-session, so their stdout JSON stream is the only
 * live source: t/s is estimated from accumulated delta chars (chars / 4,
 * mirroring the statusline's root-session estimate) over elapsed time since
 * the in-flight message's message_start. It reads 0 while the child is
 * between messages (e.g., running tools).
 */

const CHARS_PER_TOKEN = 4;

interface LiveEntry {
	agent: string;
	chars: number;
	/** Timestamp of the in-flight message's message_start; null when idle. */
	startedAt: number | null;
}

export interface SubagentLiveSample {
	agent: string;
	tps: number;
}

/** The registry and its key counter, shared across every jiti instance in one process. */
interface LiveRegistry {
	live: Map<string, LiveEntry>;
	nextKey: number;
}

/** Symbol.for resolves to the same symbol in every module graph of the process. */
const REGISTRY_KEY = Symbol.for("pi.subagentLive");

function getRegistry(): LiveRegistry {
	const channel = globalThis as typeof globalThis & Record<symbol, LiveRegistry | undefined>;
	const existing = channel[REGISTRY_KEY];
	if (existing !== undefined) return existing;
	const registry: LiveRegistry = { live: new Map(), nextKey: 0 };
	channel[REGISTRY_KEY] = registry;
	return registry;
}

/** A fresh unique key for one spawned child. */
export function subagentLiveKey(): string {
	const registry = getRegistry();
	registry.nextKey += 1;
	return `subagent-${registry.nextKey}`;
}

/** Register a spawned child; it has no in-flight message yet. */
export function subagentLiveStart(key: string, agent: string): void {
	getRegistry().live.set(key, { agent, chars: 0, startedAt: null });
}

/** An assistant message_start: begin accumulating delta chars. */
export function subagentLiveMessageStart(key: string): void {
	const entry = getRegistry().live.get(key);
	if (entry === undefined) return;
	entry.chars = 0;
	entry.startedAt = Date.now();
}

/** Accumulate streamed delta chars for the in-flight message. */
export function subagentLiveDelta(key: string, chars: number): void {
	const entry = getRegistry().live.get(key);
	if (entry === undefined || entry.startedAt === null) return;
	entry.chars += chars;
}

/** An assistant message_end: the in-flight message is done; t/s reads 0. */
export function subagentLiveMessageEnd(key: string): void {
	const entry = getRegistry().live.get(key);
	if (entry === undefined) return;
	entry.chars = 0;
	entry.startedAt = null;
}

/** Drop the entry once the child process is gone. */
export function subagentLiveRemove(key: string): void {
	getRegistry().live.delete(key);
}

export function subagentLiveTps(key: string): number {
	const entry = getRegistry().live.get(key);
	if (entry === undefined || entry.startedAt === null) return 0;
	const elapsedMs = Date.now() - entry.startedAt;
	if (elapsedMs <= 0) return 0;
	return Math.ceil(entry.chars / CHARS_PER_TOKEN) / (elapsedMs / 1000);
}

/** One sample per running child, in registration order. */
export function subagentLiveSnapshot(): SubagentLiveSample[] {
	const { live } = getRegistry();
	const samples: SubagentLiveSample[] = [];
	for (const [key, { agent }] of live) samples.push({ agent, tps: subagentLiveTps(key) });
	return samples;
}

/** Unified tok/s figure, plain integer: 0 -> 0 tok/s, 41 -> 41 tok/s, 1234 -> 1234 tok/s. */
export function formatTps(tokensPerSecond: number): string {
	return `${Math.round(tokensPerSecond)} tok/s`;
}
