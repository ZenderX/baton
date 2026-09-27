/**
 * Drift detectors — pure logic deciding, from a worker's stream of completed
 * tool calls, when to nudge it and with what message. The module only ever
 * returns a message or nothing: it never stops a worker, holds no timers and
 * reads no clock. Separate from the exact-repeat guard in index.ts.
 *
 * Motivation: an implement worker made 79 calls without touching its Surface
 * (mostly `tools/tmp_*` scripts), then 18 near-identical empty
 * `grep TargetSymbol` searches over different paths.
 */

import * as os from "node:os";
import * as path from "node:path";

/** No-progress: calls since the last progress write before the first nudge, and between repeats within one stretch. */
export const NO_PROGRESS_LIMIT = 40;
/** Near-repeat search: calls examined for one repeated search pattern. */
export const SEARCH_WINDOW = 10;
/** Near-repeat search: occurrences of one pattern in the window that qualify, and further occurrences before it qualifies again. */
export const SEARCH_REPEAT_LIMIT = 5;
/** Identical result: calls examined for one repeated result text. */
export const RESULT_WINDOW = 8;
/** Identical result: occurrences of one result in the window that qualify, and further occurrences before it qualifies again. */
export const RESULT_REPEAT_LIMIT = 4;
/** Minimum calls between any two nudges. */
export const NUDGE_COOLDOWN_CALLS = 8;
/** Every nudge starts with this, so transcripts show where it came from. */
export const DRIFT_PREFIX = "[drift]";

const EXITS =
	"Either state your next concrete step and take it, or stop now and write your result as BLOCKED with what is missing under Gaps.";

const SCRATCH_SEGMENTS = new Set(["tmp", "temp", "scratch", "scratchpad"]);
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);
/** grep/rg options whose value is the next word, so it is not mistaken for the pattern. */
const GREP_VALUE_FLAGS = new Set([
	"-A", "-B", "-C", "-m", "-g", "-t", "-T", "-f", "-d",
	"--glob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context", "--max-depth", "--file",
]);
/** Select-String parameters whose value is the next word. */
const SLS_VALUE_PARAMS = new Set(["path", "literalpath", "lp", "include", "exclude", "encoding", "context", "culture", "inputobject"]);

export interface DriftConfig {
	/** Enables the no-progress detector (opt-in per agent). */
	noProgress: boolean;
	cwd: string;
	/** Surface path prefixes, relative to cwd or absolute; empty means any non-scratch path under cwd is progress. */
	surface: string[];
}

/** One completed tool call. */
export interface ToolObservation {
	toolName: string;
	input: Record<string, unknown>;
	/** The result's text blocks, joined. */
	resultText: string;
	isError: boolean;
}

interface RepeatCounter {
	total: number;
	/** `total` when this key last produced a nudge; null if it never has. */
	firedAt: number | null;
}

export interface DriftState {
	config: DriftConfig;
	calls: number;
	lastNudgeCall: number | null;
	sinceProgress: number;
	/** `calls` at the last progress write; null if none yet. */
	lastProgressCall: number | null;
	nextProgressNudge: number;
	/** Successful edits/writes in the current stretch that were not progress. */
	strayWrites: number;
	searchKeys: Array<string | null>;
	resultKeys: Array<string | null>;
	searchCounts: Map<string, RepeatCounter>;
	resultCounts: Map<string, RepeatCounter>;
}

export function newDriftState(config: DriftConfig): DriftState {
	return {
		config,
		calls: 0,
		lastNudgeCall: null,
		sinceProgress: 0,
		lastProgressCall: null,
		nextProgressNudge: NO_PROGRESS_LIMIT,
		strayWrites: 0,
		searchKeys: [],
		resultKeys: [],
		searchCounts: new Map(),
		resultCounts: new Map(),
	};
}

function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Scratch: outside cwd, under the OS temp dir (unless cwd is too), or a segment like `tmp`, `tmp_x`, `scratch-y` below cwd. */
export function isScratchPath(rawPath: string, cwd: string): boolean {
	const resolved = path.resolve(cwd, rawPath);
	const tmp = os.tmpdir();
	if (!isInside(cwd, resolved) || (!isInside(tmp, cwd) && isInside(tmp, resolved))) return true;
	return path
		.relative(cwd, resolved)
		.split(/[\\/]/)
		.some((segment) => {
			const lower = segment.toLowerCase();
			return SCRATCH_SEGMENTS.has(lower) || /^(?:tmp_|tmp-|scratch)/.test(lower);
		});
}

function isProgressWrite(rawPath: string, config: DriftConfig): boolean {
	if (isScratchPath(rawPath, config.cwd)) return false;
	if (config.surface.length === 0) return true;
	const resolved = path.resolve(config.cwd, rawPath);
	return config.surface.some((prefix) => isInside(path.resolve(config.cwd, prefix), resolved));
}

function normalizeKey(raw: string): string {
	return raw
		.trim()
		.replace(/^["']+|["']+$/g, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function commandName(word: string): string {
	return path.posix.basename(word.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
}

interface ShellSearch {
	pattern: string;
	/** The command names files or paths to search, rather than reading stdin. */
	namesFiles: boolean;
}

/** `rest` holds the words after the pattern; any non-flag word there is a file operand. */
function operandSearch(pattern: string | undefined, rest: string[]): ShellSearch | undefined {
	return pattern === undefined ? undefined : { pattern, namesFiles: rest.some((word) => !word.startsWith("-")) };
}

function grepSearch(args: string[]): ShellSearch | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-e" || arg === "--regexp" || arg === "--") return operandSearch(args[i + 1], args.slice(i + 2));
		if (arg.startsWith("--regexp=")) return operandSearch(arg.slice("--regexp=".length), args.slice(i + 1));
		if (GREP_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) continue;
		return operandSearch(arg, args.slice(i + 1));
	}
	return undefined;
}

function findstrSearch(args: string[]): ShellSearch | undefined {
	for (let i = 0; i < args.length; i++) {
		const literal = /^\/c:(.+)$/i.exec(args[i]);
		if (literal === null && args[i].startsWith("/")) continue;
		return { pattern: literal?.[1] ?? args[i], namesFiles: args.slice(i + 1).some((arg) => !arg.startsWith("/")) };
	}
	return undefined;
}

function selectStringSearch(args: string[]): ShellSearch | undefined {
	let pattern: string | undefined;
	let namesFiles = false;
	for (let i = 0; i < args.length; i++) {
		const option = /^-([a-z]+)(?::(.+))?$/i.exec(args[i]);
		if (option === null) {
			// Positional order is -Pattern, then -Path.
			if (pattern === undefined) pattern = args[i];
			else namesFiles = true;
			continue;
		}
		const name = option[1].toLowerCase();
		if (name.length >= 3 && "pattern".startsWith(name)) {
			pattern ??= option[2] ?? args[i + 1];
			if (option[2] === undefined) i++;
			continue;
		}
		if (name === "path" || name === "literalpath" || name === "lp") namesFiles = true;
		if (SLS_VALUE_PARAMS.has(name) && option[2] === undefined) i++;
	}
	return pattern === undefined ? undefined : { pattern, namesFiles };
}

// `2>&1` is one word, so its `&` does not split the command; quoted text is never split.
const SHELL_TOKEN = /\d*>&\d*|\|\||&&|[|;&\n]|(?:"[^"]*"|'[^']*'|[^\s"'|;&])+/g;
const SHELL_SEPARATOR = /^(?:\|\||&&|[|;&\n])$/;

/** Words per shell segment, split on unquoted `| || && ; & newline`, redirections dropped; `piped` marks a segment fed by `|`. */
function shellSegments(command: string): Array<{ words: string[]; piped: boolean }> {
	const segments = [{ words: [] as string[], piped: false }];
	let skipTarget = false;
	for (const token of command.match(SHELL_TOKEN) ?? []) {
		if (SHELL_SEPARATOR.test(token)) {
			segments.push({ words: [], piped: token === "|" });
			skipTarget = false;
		} else if (skipTarget) {
			skipTarget = false;
		} else if (/^\d*[<>]/.test(token)) {
			skipTarget = /^\d*(?:>>?|<)$/.test(token);
		} else {
			segments[segments.length - 1].words.push(token);
		}
	}
	return segments;
}

/** The first search pattern in a shell command line: grep, rg, git grep, findstr or Select-String. */
export function shellSearchPattern(command: string): string | undefined {
	for (const { words, piped } of shellSegments(command)) {
		for (let i = 0; i < words.length; i++) {
			const name = commandName(words[i]);
			const rest = words.slice(i + 1);
			let found: ShellSearch | undefined;
			if (SEARCH_COMMANDS.has(name)) found = grepSearch(rest);
			else if (name === "git" && rest[0] === "grep") {
				found = grepSearch(rest.slice(1));
				// git grep searches the work tree and never reads stdin.
				if (found !== undefined) found.namesFiles = true;
			} else if (name === "findstr") found = findstrSearch(rest);
			else if (name === "select-string" || name === "sls") found = selectStringSearch(rest);
			else continue;
			// A search fed by `|` with no files of its own filters the previous command's output; it is not a codebase search.
			if (found !== undefined && !(piped && i === 0 && !found.namesFiles)) return found.pattern;
			break;
		}
	}
	return undefined;
}

function searchKey({ toolName, input }: ToolObservation): string | null {
	let pattern: unknown;
	if (toolName === "grep" || toolName === "find") pattern = input.pattern;
	else if ((toolName === "bash" || toolName === "powershell") && typeof input.command === "string") pattern = shellSearchPattern(input.command);
	if (typeof pattern !== "string") return null;
	const key = normalizeKey(pattern);
	return key === "" ? null : key;
}

// pi's "nothing found" sentinels (shell run with no output, pass or fail; empty grep/find) say nothing about which call made them, so unrelated calls would look identical.
const EMPTY_RESULT = /^(?:\(no output\)(?: Command exited with code \d+)?|No matches found|No files found matching pattern)$/;

function resultKey({ toolName, resultText }: ToolObservation): string | null {
	if (toolName === "edit" || toolName === "write") return null;
	const key = resultText.trim().replace(/\s+/g, " ");
	return key === "" || EMPTY_RESULT.test(key) ? null : key;
}

/** Pushes `key` into a sliding window; returns the key's occurrence count in the window when it newly qualifies for a nudge. */
function recordRepeat(
	window: Array<string | null>,
	counts: Map<string, RepeatCounter>,
	key: string | null,
	size: number,
	limit: number,
): number | null {
	window.push(key);
	// A key gone from the window needs `limit` fresh occurrences to qualify again, which also clears its fired gap, so its counter can go.
	const dropped = window.length > size ? window.shift() : null;
	if (dropped != null && !window.includes(dropped)) counts.delete(dropped);
	if (key === null) return null;
	const counter = counts.get(key) ?? { total: 0, firedAt: null };
	counter.total++;
	counts.set(key, counter);
	const inWindow = window.filter((k) => k === key).length;
	if (inWindow < limit) return null;
	if (counter.firedAt !== null && counter.total - counter.firedAt < limit) return null;
	return inWindow;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Records one completed tool call; returns a nudge message, or undefined.
 * At most one nudge per call and NUDGE_COOLDOWN_CALLS between nudges; when
 * several detectors qualify, near-repeat search wins, then identical result,
 * then no-progress. A suppressed no-progress nudge stays due until it fires.
 */
export function observeToolCall(state: DriftState, observation: ToolObservation): string | undefined {
	const { config } = state;
	state.calls++;

	const { toolName, input, isError } = observation;
	const writePath = (toolName === "edit" || toolName === "write") && !isError && typeof input.path === "string" ? input.path : undefined;
	if (writePath !== undefined && isProgressWrite(writePath, config)) {
		state.sinceProgress = 0;
		state.lastProgressCall = state.calls;
		state.nextProgressNudge = NO_PROGRESS_LIMIT;
		state.strayWrites = 0;
	} else {
		state.sinceProgress++;
		if (writePath !== undefined) state.strayWrites++;
	}

	const search = searchKey(observation);
	const searchHits = recordRepeat(state.searchKeys, state.searchCounts, search, SEARCH_WINDOW, SEARCH_REPEAT_LIMIT);
	const result = resultKey(observation);
	const resultHits = recordRepeat(state.resultKeys, state.resultCounts, result, RESULT_WINDOW, RESULT_REPEAT_LIMIT);

	if (state.lastNudgeCall !== null && state.calls - state.lastNudgeCall < NUDGE_COOLDOWN_CALLS) return undefined;

	// An edit/check or edit/grep loop repeats a check result or search pattern while making progress; that is not drift.
	const progressWithin = (window: number): boolean => state.lastProgressCall !== null && state.calls - state.lastProgressCall < window;

	let message: string | undefined;
	if (search !== null && searchHits !== null && !progressWithin(SEARCH_WINDOW)) {
		const counter = state.searchCounts.get(search);
		if (counter) counter.firedAt = counter.total;
		message = `${DRIFT_PREFIX} You searched for "${clip(search, 60)}" in ${searchHits} of your last ${SEARCH_WINDOW} tool calls. Another variant is unlikely to help. ${EXITS}`;
	} else if (result !== null && resultHits !== null && !progressWithin(RESULT_WINDOW)) {
		const counter = state.resultCounts.get(result);
		if (counter) counter.firedAt = counter.total;
		message = `${DRIFT_PREFIX} ${resultHits} of your last ${RESULT_WINDOW} tool calls returned the same result: "${clip(result, 60)}". ${EXITS}`;
	} else if (config.noProgress && state.sinceProgress >= state.nextProgressNudge) {
		state.nextProgressNudge += NO_PROGRESS_LIMIT;
		message = `${DRIFT_PREFIX} ${state.sinceProgress} tool calls since your last edit to the task's files; ${state.strayWrites} writes in that stretch went to scratch or outside the Surface. ${EXITS}`;
	}
	if (message !== undefined) state.lastNudgeCall = state.calls;
	return message;
}
