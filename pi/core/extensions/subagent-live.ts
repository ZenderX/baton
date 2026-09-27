/**
 * Live registry of running subagents, shared between the engine's subagent
 * tool (extensions/engine/index.ts) and the statusline footer
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
 * live source: t/s is the decode rate — delta chars streamed after the
 * message's first delta (chars / 4, mirroring the statusline's root-session
 * estimate) over elapsed time since that first delta, so prefill and server
 * queue time are excluded. At message_end the message's final rate is held
 * and shown while the child is between messages (e.g., running tools) and
 * until its next message streams past its first delta. A span shorter than
 * MIN_RATE_SPAN_MS, or a single-chunk message (no chars after its first
 * delta), keeps the previous held value instead of a spike or a 0.
 */

const CHARS_PER_TOKEN = 4;

/** Shortest first-token span (ms) a rate is computed over; shorter spans keep the held value. */
export const MIN_RATE_SPAN_MS = 200;

interface LiveEntry {
	agent: string;
	/** Delta chars streamed after the first delta of the in-flight message. */
	chars: number;
	/** Whether an assistant message is between message_start and message_end. */
	inFlight: boolean;
	/** Arrival time of the in-flight message's first delta; null before it. */
	firstTokenAt: number | null;
	/** Final rate of the last completed message; 0 before any. */
	lastTps: number;
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
	getRegistry().live.set(key, { agent, chars: 0, inFlight: false, firstTokenAt: null, lastTps: 0 });
}

/** An assistant message_start: the clock waits for the first delta. */
export function subagentLiveMessageStart(key: string): void {
	const entry = getRegistry().live.get(key);
	if (entry === undefined) return;
	entry.chars = 0;
	entry.inFlight = true;
	entry.firstTokenAt = null;
}

/** The first delta starts the clock; later deltas accumulate chars. */
export function subagentLiveDelta(key: string, chars: number): void {
	const entry = getRegistry().live.get(key);
	if (entry === undefined || !entry.inFlight || chars <= 0) return;
	// The first delta's chars were produced before the clock started, so they are not counted.
	if (entry.firstTokenAt === null) {
		entry.firstTokenAt = Date.now();
		return;
	}
	entry.chars += chars;
}

/** An assistant message_end: hold the message's final rate as the idle value. */
export function subagentLiveMessageEnd(key: string): void {
	const entry = getRegistry().live.get(key);
	if (entry === undefined) return;
	const rate = streamingRate(entry);
	if (rate !== null) entry.lastTps = rate;
	entry.chars = 0;
	entry.inFlight = false;
	entry.firstTokenAt = null;
}

/** Drop the entry once the child process is gone. */
export function subagentLiveRemove(key: string): void {
	getRegistry().live.delete(key);
}

/** Decode rate since the first delta; null before it, within MIN_RATE_SPAN_MS of it, or with no chars after it. */
function streamingRate({ chars, inFlight, firstTokenAt }: LiveEntry): number | null {
	if (!inFlight || firstTokenAt === null || chars <= 0) return null;
	const elapsedMs = Date.now() - firstTokenAt;
	if (elapsedMs < MIN_RATE_SPAN_MS) return null;
	return Math.ceil(chars / CHARS_PER_TOKEN) / (elapsedMs / 1000);
}

/** The live decode rate while streaming past the first delta, else the held rate. */
export function subagentLiveTps(key: string): number {
	const entry = getRegistry().live.get(key);
	if (entry === undefined) return 0;
	return streamingRate(entry) ?? entry.lastTps;
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
