/**
 * Persistent agent memory: per-agent vault preamble and the memory-lint
 * `tool_result` hook (pi's stand-in for Claude Code's `memory: project`
 * system-prompt block and its PostToolUse memory-lint hook).
 */

import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCb);

export function memoryDir(cwd: string, agentName: string): string {
	return path.join(cwd, ".claude", "agent-memory", `conductor-${agentName}`);
}

export function readFileOr(filePath: string, fallback: string): string {
	try {
		return fs.readFileSync(filePath, "utf8").trim() || fallback;
	} catch {
		return fallback;
	}
}

function findSkillFile(skillRoots: string[]): string | null {
	for (const root of skillRoots) {
		const candidate = path.join(root, "memory-write", "SKILL.md");
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * pi's `write` tool auto-creates parent directories, so the vault folder
 * needs no mkdir here — it appears on the agent's first write.
 */
export function memoryPreamble(cwd: string, agentName: string, skillRoots: string[]): string {
	const dir = memoryDir(cwd, agentName);

	const skillFile = findSkillFile(skillRoots);
	const memoryIndex = readFileOr(path.join(dir, "MEMORY.md"), "(empty — no notes yet)");

	return `# Persistent Agent Memory

You have a persistent, file-based memory vault at \`${dir}\`. This directory is created on your first write — write to it directly with the write tool. Notes follow the \`memory-write\` skill (\`${skillFile ?? "not installed"}\`): read it before writing or editing anything under the vault. Save only what is durable and non-obvious — never code patterns, git history, fix recipes, or ephemeral task state. \`MEMORY.md\` in that folder is the index, loaded below; add one line per note there, never note content.

## MEMORY.md

${memoryIndex}
`;
}

export function registerMemoryLint(pi: ExtensionAPI, packageRoot: string): void {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const input = event.input as { path?: unknown; file_path?: unknown };
		const raw = input.path ?? input.file_path;
		if (typeof raw !== "string") return;

		const abs = path.resolve(ctx.cwd, raw).replace(/\\/g, "/");
		if (!abs.includes("/.claude/agent-memory/")) return;

		const script = path.join(packageRoot, "scripts", "memory-lint.ps1");
		if (!fs.existsSync(script)) return;

		// A pi session may run inside a Claude Code terminal exporting this for another project.
		const env = { ...process.env };
		delete env.CLAUDE_PROJECT_DIR;

		let stdout: string;
		let stderr: string;
		try {
			// Exit 0: linter ran clean, nothing to report.
			await execFile("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
				cwd: ctx.cwd,
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
				env,
			});
			return;
		} catch (err) {
			const e = err as { code?: unknown; stdout?: string; stderr?: string };
			// ENOENT (no pwsh), a timeout, or any non-1 exit: silent no-op.
			if (e.code !== 1) return;
			stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
		}

		const lines = `${stdout}\n${stderr}`.split("\n");
		const errs = lines.filter((line) => /^\s*ERR /.test(line));
		const body = errs.length > 0 ? errs.join("\n") : lines.slice(-20).join("\n");
		const text = `memory-lint failed after writing ${raw} — fix before finishing:\n${body}`;

		return { content: [...event.content, { type: "text", text }] };
	});
}
