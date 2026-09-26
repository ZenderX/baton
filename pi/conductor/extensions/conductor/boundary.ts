/**
 * Boundary guard — pure logic confining worker sessions (spawn depth ≥ 1)
 * to the project root and the `~/.pi` config dir.
 *
 * The conductor (depth 0) gets the boundary as a prompt instruction only;
 * it legitimately reads pi docs from the npm global dir. Workers get the
 * prompt instruction plus this mechanical guard, wired in index.ts's
 * `tool_call` handler.
 *
 * Motivation: a worker ran `find / -name "*.rs" 2>/dev/null |
 * grep -i net | head` for 47 minutes at 83% host CPU. Filesystem-wide scans
 * and out-of-boundary file access are how that happens.
 */

import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The two roots a worker may touch: the session cwd and the `~/.pi` agent dir. */
export function boundaryRoots(cwd: string): string[] {
	return [path.resolve(cwd), getAgentDir()];
}

/**
 * Lowercase + win32-normalize so path comparison is case-insensitive on
 * Windows (the resolved path may mix separators).
 */
function normalize(p: string): string {
	let n = path.win32.normalize(p).toLowerCase();
	while (n.length > 1 && (n.endsWith("\\") || n.endsWith("/"))) n = n.slice(0, -1);
	return n;
}

/** True when the resolved path equals a root or lies beneath one (a sibling like `/proj2` does not match `/proj`). */
export function isWithinBoundary(resolvedPath: string, roots: string[]): boolean {
	const p = normalize(resolvedPath);
	return roots.some((root) => {
		const r = normalize(root);
		return p === r || p.startsWith(`${r}\\`) || p.startsWith(`${r}/`);
	});
}

/** Commands whose root-targeted form walks the whole filesystem. */
const SCAN_COMMANDS = new Set(["find", "grep", "rg", "du"]);

/** A bare `/`, a `/*`-style root target, or a drive root (`C:\`, `C:/`, `C:\*`). */
function isRootTarget(token: string): boolean {
	if (token === "/") return true;
	if (token.startsWith("/*")) return true;
	return /^[a-z]:[\\/](\*)?$/i.test(token);
}

/**
 * True when any pipeline segment starts with a scan command (`find`, `grep`,
 * `rg`, `du`) aimed at a filesystem root. Segments split on `;`, `&&`, `||`,
 * newlines — NOT on `|`, so `find / ... | grep x` is still seen as `find /`.
 * Scoped forms (`find . -name x`, `grep foo file`, `du .`) pass.
 */
export function filesystemWideScan(command: string): boolean {
	for (const raw of command.split(/;|&&|\|\||\n/)) {
		// A leading env-var assignment is not a command.
		const segment = raw.replace(/^\s*(?:\w+=\S*\s*)*/, "").trim();
		if (!segment) continue;
		const tokens = segment.split(/\s+/);
		if (!SCAN_COMMANDS.has(tokens[0])) continue;
		if (tokens.slice(1).some(isRootTarget)) return true;
	}
	return false;
}

/**
 * The block reason a worker sees when the guard fires: names the boundary
 * (project root + `~/.pi`), teaches why, and gives the scoped alternative.
 */
export function boundaryBlockReason(toolName: string, target: string): string {
	if (toolName === "bash") {
		return `Blocked: "${target}" is a filesystem-wide scan. Your boundary is the project root and the ~/.pi config dir — a full-filesystem walk is never how you find something inside it (one such find / ran 47 minutes at 83% host CPU). Scope the scan to the project root instead, e.g. \`find . -name "*.rs"\` or \`rg -n "pattern" .\`.`;
	}
	return `Blocked: "${target}" is outside your boundary, which is the project root and the ~/.pi config dir. Files elsewhere are out of scope — reaching for one usually means the task is missing context, not that the file is needed. Use a project-relative path instead (e.g. read src/main.rs) or a scan scoped to the project root (e.g. \`find . -name "*.rs"\`).`;
}
