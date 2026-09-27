/**
 * Boundary guard — pure logic blocking filesystem-wide scans in worker
 * sessions (spawn depth >= 1), wired as a `tool_call` hook in index.ts.
 *
 * Deliberately narrow: only a scan aimed at a drive or filesystem root (or
 * the bare home directory) is blocked. Reads and scoped scans outside the
 * project stay allowed, since workers legitimately read skills, pi's docs and
 * archives elsewhere on disk; the job-file protocol already narrows scope.
 *
 * Motivation: a worker ran `find / -name "*.rs" ... | grep -i net | head` for
 * 47 minutes at 83% host CPU.
 */

import * as path from "node:path";

/** Commands whose root-targeted form walks the whole filesystem. */
const SCAN_COMMANDS = new Set(["find", "grep", "egrep", "rg", "du", "dir"]);

/** Prefixes that run a later word as the command (`sudo find /`, `timeout 60 find /`, `xargs grep -r x /`). */
const WRAPPERS = new Set(["sudo", "time", "nice", "command", "exec", "nohup", "timeout", "env", "xargs"]);

/** Shells whose `-c` argument is itself a command line (`bash -c 'find /'`). */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** PowerShell directory listings; only their recursive form is a scan, as bare `ls /` is allowed in bash. */
const PS_LISTINGS = new Set(["get-childitem", "gci", "ls", "dir"]);

// `-Recurse:$false` explicitly turns recursion off.
const PS_RECURSE_SWITCH = /^-(?:r|re|rec|recu|recur|recurs|recurse|depth)(?::(?!\$false$).*)?$/i;

function unquote(token: string): string {
	return token.replace(/^["']+|["']+$/g, "");
}

/**
 * True for a root spelling: `/`, `//`, `/*`, `\`; a drive root `C:`, `C:\`,
 * `C:/`, `C:\\`, `C:\*`; a Git Bash or WSL drive root `/c`, `/c/`, `/mnt/c`;
 * or the bare home directory `~`, `~/`, `$HOME`, `${HOME}`.
 */
export function isRootTarget(raw: string): boolean {
	const token = unquote(raw.trim());
	if (/^[\\/]+\*?$/.test(token)) return true;
	if (/^[a-z]:[\\/]*\*?$/i.test(token)) return true;
	if (/^(?:\/mnt)?\/[a-z]\/?\*?$/i.test(token)) return true;
	return /^(?:~|\$HOME|\$\{HOME\})[\\/]?\*?$/.test(token);
}

/**
 * Splits a command line into segments of unquoted words. Segments end at `;`,
 * `&`, `|`, newlines, `(`, `)`, `$(` and (bash only) backticks, so pipelines,
 * subshells and command substitutions are each seen. Backslashes stay literal
 * outside quotes, since workers write Windows paths like `C:\` unescaped;
 * except in bash, where backslash-newline joins lines and a word-initial `\;`,
 * `\(`, `\)` (as `find -exec … \;` and `find \( … \)` need) is a literal word.
 */
function splitSegments(command: string, powershell: boolean): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | null = null;
	const endWord = (): void => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = (): void => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote !== null) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && !powershell && (next === '"' || next === "\\")) word += command[++i];
			else word += ch;
			continue;
		}
		if (ch === "\\" && !powershell && (next === "\n" || (next === "\r" && command[i + 2] === "\n"))) {
			i += next === "\r" ? 2 : 1;
		} else if (ch === "\\" && !powershell && !inWord && next !== undefined && /[;&|()<>]/.test(next)) {
			word += command[++i];
			inWord = true;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			inWord = true;
		} else if (ch === "$" && command[i + 1] === "(") {
			endSegment();
			i++;
		} else if (/[;&|()\n]/.test(ch) || (ch === "`" && !powershell)) {
			endSegment();
		} else if (/\s/.test(ch)) {
			endWord();
		} else {
			word += ch;
			inWord = true;
		}
	}
	endSegment();
	return segments;
}

function commandName(word: string): string {
	return path.posix.basename(word.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
}

/** Index of the first word at or after `start` that starts a command this guard understands. */
function nextCommandIndex(words: string[], start: number): number {
	for (let i = start; i < words.length; i++) {
		const name = commandName(words[i]);
		if (SCAN_COMMANDS.has(name) || WRAPPERS.has(name) || SHELLS.has(name) || name === "cmd") return i;
	}
	return words.length;
}

/**
 * The operands of grep/egrep/rg that can name a directory. Without `-e`/`-f`
 * the first operand is the pattern, so `grep -rn "/" src` is not a root scan.
 * In a bundle like `-re`, the first `e`/`f` takes the rest of the word, or
 * else the next word, so `grep -re "/" src` has `/` as its pattern.
 */
function grepTargets(args: string[]): string[] {
	const operands: string[] = [];
	let explicitPattern = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--regexp" || arg === "--file") {
			explicitPattern = true;
			i++;
		} else if (/^--(?:regexp|file)=/.test(arg) || arg === "--files") {
			// rg --files takes no pattern: every operand is a directory.
			explicitPattern = true;
		} else if (arg.startsWith("--")) {
			continue;
		} else if (arg.startsWith("-") && arg.length > 1) {
			const valueAt = arg.search(/[ef]/);
			if (valueAt === -1) continue;
			explicitPattern = true;
			if (valueAt === arg.length - 1) i++;
		} else {
			operands.push(arg);
		}
	}
	return explicitPattern ? operands : operands.slice(1);
}

/** The arguments of a scan command that can name a directory to walk. */
function scanTargets(command: string, args: string[]): string[] {
	// cmd switches (`/s`, `/b`) would otherwise read as Git Bash drive roots.
	if (command === "dir") return args.filter((t) => !/^\/[a-z]$/i.test(t));
	if (command === "grep" || command === "egrep" || command === "rg") return grepTargets(args);
	return args;
}

/** True when one segment, after unwrapping env assignments, wrappers, `cmd /c` and `sh -c`, scans a root. */
function segmentScansRoot(words: string[]): boolean {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		const name = commandName(word);
		if (/^\w+=/.test(word)) {
			i++;
		} else if (WRAPPERS.has(name)) {
			i = nextCommandIndex(words, i + 1);
		} else if (name === "cmd") {
			const flag = words.findIndex((w, j) => j > i && /^\/{1,2}c$/i.test(w));
			return flag !== -1 && filesystemWideScan(words.slice(flag + 1).join(" "));
		} else if (SHELLS.has(name)) {
			let j = i + 1;
			while (j < words.length && words[j].startsWith("-") && !/^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[j])) j++;
			const inner = words[j + 1];
			return j < words.length && words[j].startsWith("-") && inner !== undefined && filesystemWideScan(inner);
		} else {
			return SCAN_COMMANDS.has(name) && scanTargets(name, words.slice(i + 1)).some(isRootTarget);
		}
	}
	return false;
}

/**
 * True when any command segment runs a scan command (`find`, `grep`, `rg`,
 * `du`, `dir`) against a root target, including behind wrappers (`sudo`,
 * `timeout`, `nohup`, `env`, `xargs`, `cmd /c`, `bash -c`), in subshells and
 * in command substitutions.
 */
export function filesystemWideScan(command: string): boolean {
	return splitSegments(command, false).some(segmentScansRoot);
}

/** Case-insensitive PowerShell parameter-prefix match (`-Pat` binds `-Pattern`). */
function paramIs(name: string, full: string, minLength: number): boolean {
	return name.length >= minLength && full.startsWith(name);
}

/** The Select-String arguments that name files: `-Path`/`-LiteralPath` values and positionals after the pattern. */
function selectStringTargets(args: string[]): string[] {
	const targets: string[] = [];
	let patternSeen = false;
	for (let i = 0; i < args.length; i++) {
		const option = /^-([a-z]+)(?::(.*))?$/i.exec(args[i]);
		if (option === null) {
			if (patternSeen) targets.push(args[i]);
			patternSeen = true;
			continue;
		}
		const name = option[1].toLowerCase();
		const value = option[2] ?? args[i + 1];
		const consumes = option[2] === undefined ? 1 : 0;
		if (paramIs(name, "path", 2) || paramIs(name, "literalpath", 3) || name === "lp" || name === "pspath") {
			if (value !== undefined) targets.push(value);
			i += consumes;
		} else if (paramIs(name, "pattern", 3)) {
			patternSeen = true;
			i += consumes;
		} else if (["include", "exclude", "encoding", "context", "culture", "inputobject"].some((full) => paramIs(name, full, 2))) {
			i += consumes;
		}
	}
	return targets;
}

/** The Get-ChildItem arguments that name a directory: `-Path:X` values and positionals, skipping `-Filter`/`-Include`/`-Exclude`/`-Depth` values. */
function listingTargets(args: string[]): string[] {
	const targets: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const option = /^-([a-z]+)(?::(.*))?$/i.exec(args[i]);
		if (option === null) {
			targets.push(args[i]);
			continue;
		}
		const name = option[1].toLowerCase();
		if (paramIs(name, "filter", 4) || paramIs(name, "include", 2) || paramIs(name, "exclude", 2) || paramIs(name, "depth", 2)) {
			if (option[2] === undefined) i++;
		} else if (option[2] !== undefined) {
			targets.push(option[2]);
		}
	}
	return targets;
}

/** Drops a leading `$x =`, `$x=`, `$f in` or `foreach` so the cmdlet is the first word (`&` already splits segments). */
function stripPsPrefix(words: string[]): string[] {
	const rest = [...words];
	while (rest.length > 0) {
		const assigned = /^\$[\w:{}]+[+\-*/]?=(.+)$/.exec(rest[0]);
		if (assigned !== null) rest[0] = assigned[1];
		else if (/^(?:\$[\w:{}]+|[+\-*/]?=|in|foreach|\.)$/i.test(rest[0])) rest.shift();
		else break;
	}
	return rest;
}

/**
 * True when a PowerShell command line scans a root: a recursive
 * `Get-ChildItem`/`gci`/`ls`/`dir` (`-Recurse` or `-Depth`, any prefix) of a
 * root, `Select-String` over a root, or any bash-style scan (`cmd /c dir /s
 * C:\`, `rg x C:\`), also behind `$x =` or `foreach ($f in …)`. A
 * non-recursive `Get-ChildItem C:\` is allowed.
 */
export function powershellRootScan(command: string): boolean {
	return splitSegments(command.replace(/`\r?\n/g, " "), true).some((segment) => {
		const words = stripPsPrefix(segment);
		if (words.length === 0) return false;
		const name = commandName(words[0]);
		const args = words.slice(1);
		if (PS_LISTINGS.has(name)) {
			if (!args.some((a) => PS_RECURSE_SWITCH.test(a))) return false;
			return listingTargets(args).some(isRootTarget);
		}
		if (name === "select-string" || name === "sls") return selectStringTargets(args).some(isRootTarget);
		return segmentScansRoot(words);
	});
}

/** True when a find/grep/ls tool path is a root spelling or resolves to a filesystem root from `cwd`. */
export function isRootToolPath(rawPath: string | undefined, cwd: string): boolean {
	if (rawPath === undefined || rawPath.trim() === "") return false;
	if (isRootTarget(rawPath)) return true;
	const resolved = path.resolve(cwd, rawPath);
	return path.parse(resolved).root === resolved;
}

export function boundaryBlockReason(target: string): string {
	return `Blocked: "${target}" scans the whole filesystem (a drive, filesystem or home root). Scope the scan to the project root or the specific directory you need, e.g. \`find . -name "*.rs"\` or \`rg -n "pattern" src\`.`;
}

/** One line appended to every worker's system prompt, stating the rule the hook enforces. */
export const BOUNDARY_PROMPT_LINE =
	"Boundary: never scan the whole filesystem — no `find /`, `grep -r /`, `rg /`, `du /`, `dir /s C:\\`, and no drive root (`C:\\`, `/c`) or bare `~` as a find/grep/ls path. Scope every scan to the project root or the directory you need (e.g. `find . -name \"*.rs\"`). Such scans are blocked; reading a named file outside the project is allowed.";
