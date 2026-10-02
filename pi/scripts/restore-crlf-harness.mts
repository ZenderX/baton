/**
 * Restore-CRLF harness — drives core/extensions/restore-crlf.ts against a
 * scratch git repo whose .gitattributes reads `*.md text eol=crlf`,
 * `*.sh text eol=lf`, `*.txt text=auto`, and verifies:
 *
 *   1. LF tracked and untracked `.md` files (one path with a space) become
 *      CRLF; a mixed `.md` becomes pure CRLF with no `\r\r\n` and keeps its
 *      missing final newline; `.sh` and `.txt` files stay byte-identical.
 *   2. Index refresh: an LF-committed, unchanged `.md` drops out of
 *      `git status` and `git diff-files` (its stat is re-recorded); an
 *      LF-committed `.md` with a real edit stays ` M`, never staged; the
 *      cached diff stays empty.
 *   3. A second run converts nothing (a lost parent/child race is a no-op).
 *   4. Outside a repo: no throw, no output, files untouched.
 *   5. Extension: its tool_result handler converts after write, edit, bash
 *      and powershell results only, never alters the result, and survives
 *      overlapping results.
 *
 * Run with: node --experimental-strip-types pi/scripts/restore-crlf-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import restoreCrlfExtension, { WRITING_TOOLS, restoreCrlf } from "../core/extensions/restore-crlf.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(dir: string, file: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), text);
}

function bytes(dir: string, file: string): string {
	return fs.readFileSync(path.join(dir, file), "latin1");
}

function lines(output: string): string[] {
	return output.split("\n").filter((line) => line !== "");
}

function makeRepo(root: string): string {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q");
	git(repo, "config", "core.autocrlf", "false");
	git(repo, "config", "core.safecrlf", "false");
	git(repo, "config", "user.name", "harness");
	git(repo, "config", "user.email", "harness@example.invalid");
	write(repo, ".gitattributes", "*.md text eol=crlf\n*.sh text eol=lf\n*.txt text=auto\n");
	write(repo, "clean.md", "a\nb\n");
	write(repo, "edited.md", "a\nb\n");
	write(repo, "script.sh", "x\ny\n");
	write(repo, "notes.txt", "x\ny\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "lf files");
	return repo;
}

/** Load the extension against a stub pi that records handlers and fails on any other API call. */
function loadExtension(): Map<string, Handler[]> {
	const handlers = new Map<string, Handler[]>();
	const pi = new Proxy(
		{},
		{
			get: (_t, prop) => {
				if (prop === "on") {
					return (name: string, handler: Handler): void => {
						handlers.set(name, [...(handlers.get(name) ?? []), handler]);
					};
				}
				throw new Error(`unexpected pi.${String(prop)}`);
			},
		},
	) as ExtensionAPI;
	restoreCrlfExtension(pi);
	return handlers;
}

async function fireToolResult(handlers: Map<string, Handler[]>, toolName: string, cwd: string): Promise<unknown[]> {
	const ctx = { cwd } as ExtensionContext;
	const event = { type: "tool_result", toolCallId: "t", toolName, input: {}, content: [{ type: "text", text: "ok" }], isError: false };
	return Promise.all((handlers.get("tool_result") ?? []).map((handler) => handler(event, ctx)));
}

async function main(): Promise<void> {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "restore-crlf-harness-"));
	try {
		const repo = makeRepo(scratch);
		write(repo, "edited.md", "a\nb\nc\n");
		write(repo, "docs/new file.md", "one\ntwo\n");
		write(repo, "mixed.md", "a\r\nb\nc");
		write(repo, "new.sh", "p\nq\n");
		write(repo, "new.txt", "p\nq\n");
		assert.deepEqual(lines(git(repo, "diff-files", "--name-only")), ["edited.md"], "setup: clean.md matches its index stat before the rewrite");

		// 1. Conversion.
		const converted = await restoreCrlf(path.join(repo, "docs"));
		assert.deepEqual([...converted].sort(), ["clean.md", "docs/new file.md", "edited.md", "mixed.md"]);
		assert.equal(bytes(repo, "clean.md"), "a\r\nb\r\n");
		assert.equal(bytes(repo, "edited.md"), "a\r\nb\r\nc\r\n");
		assert.equal(bytes(repo, "docs/new file.md"), "one\r\ntwo\r\n");
		assert.equal(bytes(repo, "mixed.md"), "a\r\nb\r\nc", "pure CRLF, no \\r\\r\\n, final newline still missing");
		for (const file of ["script.sh", "new.sh", "notes.txt", "new.txt"]) assert.equal(bytes(repo, file), file.startsWith("new") ? "p\nq\n" : "x\ny\n", `${file} untouched`);
		assert.equal(bytes(repo, ".gitattributes"), "*.md text eol=crlf\n*.sh text eol=lf\n*.txt text=auto\n");
		assert.deepEqual(
			fs.readdirSync(repo, { recursive: true }).filter((entry) => String(entry).includes(".restore-crlf.")),
			[],
			"no temp file left behind",
		);
		console.log(`  [1] converted ${converted.length} .md files (tracked, untracked, spaced path, mixed); .sh/.txt untouched`);

		// 2. Index refresh.
		const status = lines(git(repo, "status", "--porcelain", "--untracked-files=no"));
		assert.deepEqual(status, [" M edited.md"], "clean.md is gone from status; edited.md is modified, not staged");
		assert.deepEqual(lines(git(repo, "diff-files", "--name-only")), ["edited.md"], "clean.md's index stat was re-recorded without a status refresh");
		assert.equal(git(repo, "diff", "--cached", "--stat"), "", "nothing staged");
		console.log("  [2] unchanged LF-committed .md re-recorded; edited .md stays ' M'; cached diff empty");

		// 3. Idempotent.
		assert.deepEqual(await restoreCrlf(repo), [], "a second run converts nothing");
		console.log("  [3] second run is a no-op");

		// 4. Outside a repo.
		const outside = path.join(scratch, "not-a-repo");
		write(outside, "plain.md", "a\nb\n");
		assert.throws(() => git(outside, "rev-parse", "--show-toplevel"), "the scratch dir must not sit inside a repo");
		const printed: string[] = [];
		const stdoutWrite = process.stdout.write;
		const stderrWrite = process.stderr.write;
		const capture = (chunk: unknown): boolean => {
			printed.push(String(chunk));
			return true;
		};
		process.stdout.write = capture as typeof process.stdout.write;
		process.stderr.write = capture as typeof process.stderr.write;
		let outsideResult: string[];
		try {
			outsideResult = await restoreCrlf(outside);
		} finally {
			process.stdout.write = stdoutWrite;
			process.stderr.write = stderrWrite;
		}
		assert.deepEqual(outsideResult, []);
		assert.deepEqual(printed, [], "nothing printed outside a repo");
		assert.equal(bytes(outside, "plain.md"), "a\nb\n");
		console.log("  [4] non-repo dir: no throw, no output, file untouched");

		// 5. Extension handler.
		assert.deepEqual([...WRITING_TOOLS].sort(), ["bash", "edit", "powershell", "write"]);
		const handlers = loadExtension();
		assert.equal(handlers.get("tool_result")?.length, 1, "one tool_result handler");
		for (const toolName of ["read", "grep", "find", "ls", "subagent"]) {
			write(repo, "later.md", "x\n");
			assert.deepEqual(await fireToolResult(handlers, toolName, repo), [undefined]);
			assert.equal(bytes(repo, "later.md"), "x\n", `${toolName} does not trigger a rewrite`);
		}
		for (const toolName of WRITING_TOOLS) {
			write(repo, "later.md", "x\n");
			assert.deepEqual(await fireToolResult(handlers, toolName, repo), [undefined], `${toolName}: the result is not modified`);
			assert.equal(bytes(repo, "later.md"), "x\r\n", `${toolName} triggers a rewrite`);
		}
		write(repo, "later.md", "x\n");
		write(repo, "other.md", "y\n");
		await Promise.all([fireToolResult(handlers, "write", repo), fireToolResult(handlers, "edit", repo), fireToolResult(handlers, "bash", repo)]);
		assert.equal(bytes(repo, "later.md"), "x\r\n");
		assert.equal(bytes(repo, "other.md"), "y\r\n");
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, {});
		console.log("  [5] extension: write/edit/bash/powershell results convert, other tools do not, overlapping results are safe");
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}

	console.log("\nAll restore-crlf harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
