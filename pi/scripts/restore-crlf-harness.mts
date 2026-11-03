/**
 * Restore-CRLF harness — drives core/extensions/restore-crlf.ts and
 * claude/plugins/baton/scripts/restore-crlf.sh against scratch git repos whose
 * .gitattributes reads `*.md text eol=crlf`, `*.sh text eol=lf`,
 * `*.txt text=auto`, with the machine's git config and global attributes
 * isolated, and verifies:
 *
 *   1. Shell scope: LF modified and untracked `.md` files (one path with a
 *      space) become CRLF; a mixed `.md` becomes pure CRLF with no `\r\r\n`
 *      and keeps its missing final newline; an unmodified tracked `.md` is
 *      left until a run names it; `.sh` and `.txt` files stay byte-identical.
 *   2. Index refresh: an LF-committed, unchanged `.md` drops out of
 *      `git status` and `git diff-files` (its stat is re-recorded); an
 *      LF-committed `.md` with a real edit stays ` M`, never staged; the
 *      cached diff stays empty.
 *   3. A second run converts nothing (a lost parent/child race is a no-op).
 *   4. Outside a repo: no throw, no output, files untouched.
 *   5. Extension: its tool_result handler converts after write, edit, bash
 *      and powershell results only, never alters the result, and survives
 *      overlapping results.
 *   6. Extension scope: a write result converts only the file its
 *      `input.path` names; a bash result converts modified and untracked files.
 *   7. Both ports: with no eol=crlf in any attribute source nothing changes
 *      and no `ls-files` scan runs; eol=crlf from `.git/info/attributes`,
 *      `core.attributesFile` or `$XDG_CONFIG_HOME/git/attributes` alone
 *      still converts.
 *   8. Bash hook: an Edit input converts the file its `file_path` names
 *      (with jq; without jq it falls back to the shell scope) and re-records
 *      its index stat; a Bash input converts modified and untracked files;
 *      a second run converts nothing. A missing `bash` fails the harness, and
 *      so does a missing `jq` under GitHub Actions (GITHUB_ACTIONS=true), whose
 *      ubuntu images ship jq as a vital package; locally a missing jq runs the
 *      fallback assertions instead.
 *
 * Run with: node --experimental-strip-types pi/scripts/restore-crlf-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import restoreCrlfExtension, { WRITING_TOOLS, restoreCrlf } from "../core/extensions/restore-crlf.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "claude", "plugins", "baton", "scripts", "restore-crlf.sh");
const ATTRIBUTES = "*.md text eol=crlf\n*.sh text eol=lf\n*.txt text=auto\n";

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

/** Identity of each file on disk; a rewrite (temp file + rename) changes it. */
function stamps(dir: string, files: string[]): string[] {
	return files.map((file) => {
		const { ino, mtimeMs } = fs.statSync(path.join(dir, file));
		return `${file} ${ino} ${mtimeMs}`;
	});
}

function makeRepo(root: string, name = "repo", attributes = ATTRIBUTES): string {
	const repo = path.join(root, name);
	fs.mkdirSync(repo);
	git(repo, "init", "-q");
	git(repo, "config", "core.autocrlf", "false");
	git(repo, "config", "core.safecrlf", "false");
	git(repo, "config", "user.name", "harness");
	git(repo, "config", "user.email", "harness@example.invalid");
	write(repo, ".gitattributes", attributes);
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

async function fireToolResult(handlers: Map<string, Handler[]>, toolName: string, cwd: string, input: Record<string, unknown> = {}): Promise<unknown[]> {
	const ctx = { cwd } as ExtensionContext;
	const event = { type: "tool_result", toolCallId: "t", toolName, input, content: [{ type: "text", text: "ok" }], isError: false };
	return Promise.all((handlers.get("tool_result") ?? []).map((handler) => handler(event, ctx)));
}

/** Runs the Claude Code hook as hooks.json does: bash, JSON on stdin, CLAUDE_PROJECT_DIR set. */
function runHook(repo: string, input: Record<string, unknown>): void {
	const run = spawnSync("bash", [HOOK], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, encoding: "utf8" });
	if (run.error) throw run.error;
	assert.equal(run.status, 0, `hook exits 0; stderr: ${run.stderr}`);
	assert.equal(run.stdout + run.stderr, "", "the hook prints nothing");
}

async function main(): Promise<void> {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "restore-crlf-harness-"));
	// The machine's git config or global attributes could set eol=crlf and defeat the early-exit checks.
	const xdg = path.join(scratch, "xdg");
	write(scratch, "gitconfig", "");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_CONFIG_GLOBAL = path.join(scratch, "gitconfig");
	process.env.XDG_CONFIG_HOME = xdg;
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
		assert.deepEqual([...converted].sort(), ["docs/new file.md", "edited.md", "mixed.md"]);
		assert.equal(bytes(repo, "clean.md"), "a\nb\n", "an unmodified tracked file is outside the shell scope");
		assert.deepEqual(await restoreCrlf(path.join(repo, "docs"), "../clean.md"), ["clean.md"], "a named file converts though git sees it unmodified");
		converted.push("clean.md");
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
		console.log(`  [1] converted ${converted.length} .md files (modified, untracked, spaced path, mixed, then a named unmodified one); .sh/.txt untouched`);

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

		// 6. Extension scope.
		write(repo, "scoped.md", "s\n");
		write(repo, "stale.md", "t\n");
		await fireToolResult(handlers, "write", repo, { path: "@scoped.md" });
		assert.equal(bytes(repo, "scoped.md"), "s\r\n", "the written file converts");
		assert.equal(bytes(repo, "stale.md"), "t\n", "a write converts only the file its input names");
		write(repo, "clean.md", "a\nb\nz\n");
		await fireToolResult(handlers, "bash", repo, { command: "true" });
		assert.equal(bytes(repo, "stale.md"), "t\r\n", "bash converts an untracked stale file");
		assert.equal(bytes(repo, "clean.md"), "a\r\nb\r\nz\r\n", "bash converts a modified stale file");
		console.log("  [6] extension scope: write converts only input.path; bash converts modified + untracked");

		// 7. Early exit and every attribute source, in both ports.
		const ports: ReadonlyArray<[string, (dir: string) => Promise<unknown>]> = [
			["ts", (dir) => restoreCrlf(dir)],
			["bash", async (dir) => runHook(dir, { tool_name: "Bash" })],
		];
		const crlfMd = "*.md text eol=crlf\n";
		const globalFile = path.join(scratch, "global-attributes");
		write(scratch, "global-attributes", crlfMd);
		for (const [port, run] of ports) {
			const plain = makeRepo(scratch, `plain-${port}`, "*.sh text eol=lf\n");
			write(plain, "a.md", "a\n");
			const trace = path.join(scratch, `trace-${port}.log`);
			process.env.GIT_TRACE = trace;
			try {
				await run(plain);
			} finally {
				delete process.env.GIT_TRACE;
			}
			const traced = fs.readFileSync(trace, "utf8");
			assert.match(traced, /built-in: git grep /u, `${port}: the tracked .gitattributes probe ran`);
			assert.doesNotMatch(traced, /ls-files/u, `${port}: no eol=crlf source, so no ls-files scan`);
			assert.equal(bytes(plain, "a.md"), "a\n", `${port}: no eol=crlf source, file untouched`);

			const infoFile = path.join(plain, ".git", "info", "attributes");
			const xdgFile = path.join(xdg, "git", "attributes");
			const sources: ReadonlyArray<[string, () => void, () => void]> = [
				[".git/info/attributes", () => write(plain, ".git/info/attributes", crlfMd), () => fs.rmSync(infoFile)],
				["core.attributesFile", () => git(plain, "config", "core.attributesFile", globalFile), () => git(plain, "config", "--unset", "core.attributesFile")],
				["$XDG_CONFIG_HOME/git/attributes", () => write(xdg, "git/attributes", crlfMd), () => fs.rmSync(xdgFile)],
			];
			for (const [source, set, unset] of sources) {
				write(plain, "a.md", "a\n");
				set();
				try {
					await run(plain);
				} finally {
					unset();
				}
				assert.equal(bytes(plain, "a.md"), "a\r\n", `${port}: eol=crlf from ${source} alone converts`);
			}
		}
		console.log("  [7] ts + bash: no eol=crlf source runs no ls-files scan; info/attributes, core.attributesFile, XDG attributes each convert");

		// 8. Bash hook scope and index refresh.
		const hookRepo = makeRepo(scratch, "hook");
		write(hookRepo, "edited.md", "a\nb\nc\n");
		write(hookRepo, "new.md", "n\n");
		// Without jq the hook cannot read file_path and must fall back to the modified + untracked scan.
		const jq = spawnSync("jq", ["--version"]).error === undefined;
		if (!jq && process.env.GITHUB_ACTIONS === "true") {
			throw new Error("check 8: jq is not on PATH under GitHub Actions; ubuntu-latest images list jq under apt.vital_packages, so CI must exercise the jq branch of the bash hook");
		}
		const edit = { tool_name: "Edit", tool_input: { file_path: path.join(hookRepo, "clean.md") } };
		runHook(hookRepo, edit);
		assert.equal(bytes(hookRepo, "clean.md"), jq ? "a\r\nb\r\n" : "a\nb\n", "with jq, Edit converts the file it names; without jq, that unmodified tracked file is outside the fallback scan");
		assert.deepEqual(lines(git(hookRepo, "diff-files", "--name-only")), ["edited.md"], "clean.md's index stat was re-recorded");
		assert.equal(bytes(hookRepo, "new.md"), jq ? "n\n" : "n\r\n", "with jq, Edit leaves an untracked stale file alone");
		assert.equal(bytes(hookRepo, "edited.md"), jq ? "a\nb\nc\n" : "a\r\nb\r\nc\r\n", "with jq, Edit leaves a modified stale file alone");
		runHook(hookRepo, { tool_name: "Bash" });
		assert.equal(bytes(hookRepo, "new.md"), "n\r\n", "Bash converts an untracked stale file");
		assert.equal(bytes(hookRepo, "edited.md"), "a\r\nb\r\nc\r\n", "Bash converts a modified stale file");
		assert.deepEqual(lines(git(hookRepo, "status", "--porcelain", "--untracked-files=no")), [" M edited.md"], "edited.md is modified, not staged");
		assert.equal(git(hookRepo, "diff", "--cached", "--stat"), "", "nothing staged");
		const before = stamps(hookRepo, ["clean.md", "edited.md", "new.md"]);
		runHook(hookRepo, edit);
		runHook(hookRepo, { tool_name: "Bash" });
		assert.deepEqual(stamps(hookRepo, ["clean.md", "edited.md", "new.md"]), before, "a second run rewrites nothing");
		console.log(`  [8] bash hook (jq ${jq ? "present" : "absent"}): ${jq ? "Edit converts its file_path and re-records its stat" : "Edit falls back to modified + untracked"}; Bash converts modified + untracked; second run is a no-op`);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}

	console.log("\nAll restore-crlf harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
