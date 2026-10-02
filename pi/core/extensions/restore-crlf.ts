/**
 * Restore CRLF — after every file-writing tool result, rewrites working-tree
 * files to CRLF wherever git attributes say eol=crlf but the file holds LF or
 * mixed endings. pi's write/edit tools and shell edits (sed -i strips CR on
 * Git for Windows; heredocs and redirects write LF) leave such files
 * "modified" with an empty diff. Scans the whole repo instead of the tool
 * input, so files written by a shell command are caught too. Port of
 * claude/plugins/baton/scripts/restore-crlf.sh; runs in the top-level session
 * and in every spawned child, where a lost race just finds the file CRLF.
 *
 * Only files git reports as text (w/lf or w/mixed) are touched; binaries,
 * symlinks and files already CRLF are left alone. A missing final newline is
 * kept. Each rewrite goes through a temp file in the same directory, so a
 * failure never truncates the original. Every git or fs failure is swallowed:
 * nothing is printed and the tool result is never changed.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { claimExtension } from "./load-guard.ts";

/** Built-in tools that can write files (ToolResultEvent in pi-coding-agent's extensions/types.d.ts). */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash", "powershell"]);

const CRLF_ATTRS: ReadonlySet<string> = new Set(["text eol=crlf", "text=auto eol=crlf"]);
const STALE_EOLS: ReadonlySet<string> = new Set(["lf", "mixed"]);
const MAX_BUFFER = 256 * 1024 * 1024;
const LF = 0x0a;
const CR = 0x0d;
const CRLF_BYTES = Buffer.from("\r\n");

function git(cwd: string, args: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
		// git may exit before reading stdin; the EPIPE must not become an uncaught error.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(input ?? "");
	});
}

/** Every line ends in exactly one CRLF (one CR before an LF is dropped first); a missing final newline stays missing. */
export function toCrlf(data: Buffer): Buffer {
	const parts: Buffer[] = [];
	let start = 0;
	for (let lf = data.indexOf(LF); lf !== -1; lf = data.indexOf(LF, start)) {
		const end = lf > start && data[lf - 1] === CR ? lf - 1 : lf;
		parts.push(data.subarray(start, end), CRLF_BYTES);
		start = lf + 1;
	}
	parts.push(data.subarray(start));
	return Buffer.concat(parts);
}

/** Paths from `git ls-files --eol -z` whose attr wants CRLF and whose working tree holds LF or mixed endings. */
export function staleCrlfPaths(lsFilesOutput: string): string[] {
	const paths: string[] = [];
	// Record: "i/<eol> w/<eol> attr/<attrs> <TAB><path>", fields space-padded.
	for (const record of lsFilesOutput.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const info = record.slice(0, tab);
		const worktree = /(?:^|\s)w\/(\S*)/u.exec(info)?.[1] ?? "";
		if (!STALE_EOLS.has(worktree)) continue;
		const attrAt = info.indexOf("attr/");
		if (attrAt === -1 || !CRLF_ATTRS.has(info.slice(attrAt + "attr/".length).trimEnd())) continue;
		paths.push(record.slice(tab + 1));
	}
	return paths;
}

/** Rewrites one file to CRLF through a same-directory temp file; true when the file changed. */
async function convertFile(file: string): Promise<boolean> {
	// Shares pi's per-file queue with the built-in edit/write tools, so a parallel edit is never overwritten.
	return withFileMutationQueue(file, async () => {
		const stat = await fs.promises.lstat(file);
		if (!stat.isFile()) return false;
		const original = await fs.promises.readFile(file);
		const converted = toCrlf(original);
		if (converted.equals(original)) return false;

		const tmp = path.join(path.dirname(file), `.restore-crlf.${randomBytes(6).toString("hex")}`);
		try {
			await fs.promises.writeFile(tmp, converted, { flag: "wx" });
			await fs.promises.chmod(tmp, stat.mode & 0o7777);
			await fs.promises.rename(tmp, file);
			return true;
		} catch (error: unknown) {
			await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
			throw error;
		}
	});
}

/** True when the path's stage-0 index blob equals its cleaned working-tree content, i.e. only the stat is stale. */
async function onlyStatIsStale(top: string, file: string): Promise<boolean> {
	try {
		const staged = (await git(top, ["rev-parse", "-q", "--verify", `:0:${file}`])).trim();
		const cleaned = (await git(top, ["hash-object", `--path=${file}`, "--", file])).trim();
		return staged !== "" && staged === cleaned;
	} catch (_error: unknown) {
		return false;
	}
}

/**
 * Converts every stale CRLF file in the repo containing `cwd`, then re-records
 * the index stat of converted files whose content matches the index (never
 * `git add`; real edits keep their index untouched). Returns the converted
 * paths, relative to the repo top. Never throws; outside a repo it does nothing.
 */
export async function restoreCrlf(cwd: string): Promise<string[]> {
	let top: string;
	let listing: string;
	try {
		top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
		listing = await git(top, ["ls-files", "--eol", "-z", "-c", "-o", "--exclude-standard"]);
	} catch (_error: unknown) {
		return [];
	}

	const converted: string[] = [];
	for (const file of staleCrlfPaths(listing)) {
		try {
			if (await convertFile(path.join(top, file))) converted.push(file);
		} catch (_error: unknown) {
			// Unreadable, locked or vanished: leave the file as it is.
		}
	}

	const refresh: string[] = [];
	for (const file of converted) {
		if (await onlyStatIsStale(top, file)) refresh.push(file);
	}
	if (refresh.length > 0) {
		// Fails harmlessly (e.g. index.lock held); the file then just stays "modified".
		await git(top, ["update-index", "-z", "--stdin"], refresh.map((file) => `${file}\0`).join("")).catch(() => undefined);
	}
	return converted;
}

export default function (pi: ExtensionAPI) {
	if (!claimExtension(pi, "core.restore-crlf")) return;

	// Overlapping tool results (parallel tool mode) run one scan at a time.
	let queue: Promise<unknown> = Promise.resolve();
	pi.on("tool_result", async (event, ctx) => {
		if (!WRITING_TOOLS.has(event.toolName)) return;
		queue = queue.then(() => restoreCrlf(ctx.cwd)).catch(() => undefined);
		// Awaited so the next tool call (e.g. a shell edit) never races the rewrite of the file it touches.
		await queue;
	});
}
