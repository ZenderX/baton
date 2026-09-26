/**
 * Conductor Orchestrator Mode
 *
 * Turns the current session into the conductor: the ported `main.md` system
 * prompt plus a runtime block (package root, live agent roster, memory preamble,
 * environment file presence) is appended to the system prompt every turn.
 *
 * Toggle with the `--conductor` flag or the `/conductor` command
 * (`/conductor off` disables, `/conductor <task>` enables and dispatches).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { memoryPreamble, readFileOr } from "./memory.ts";
import { resolveTaskStorePath } from "./tasks.ts";

const ORCHESTRATOR_PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator.md");

const ENVIRONMENT_RELATIVE = path.join(".claude", "conductor", "environment.md");

const STATE_KEY = "conductor-mode";

interface ConductorModeState {
	enabled: boolean;
}

function isConductorModeEntry(entry: SessionEntry): entry is CustomEntry<ConductorModeState> {
	return entry.type === "custom" && entry.customType === STATE_KEY;
}

export interface OrchestratorDeps {
	packageRoot: string;
	/** Directories whose immediate children are skill folders (`<root>/<name>/SKILL.md`). */
	skillRoots: () => string[];
	discover: (cwd: string) => AgentConfig[];
}

/**
 * Runtime facts the static prompt cannot carry: they depend on the install
 * location, the live agent roster, and the project's vault contents.
 */
function buildRuntimeBlock(cwd: string, { packageRoot, skillRoots, discover }: OrchestratorDeps): string {
	const agents = discover(cwd);
	const agentList =
		agents.length > 0
			? agents.map((a) => `  - ${a.name} (${a.source}): ${a.description}`).join("\n")
			: "  - none discovered";

	const roots = skillRoots();
	const skillRootList = roots.length > 0 ? roots.map((r) => `  - ${r}`).join("\n") : "  - none";

	const environmentPath = path.join(cwd, ENVIRONMENT_RELATIVE);
	const environmentState = fs.existsSync(environmentPath) ? `present at ${environmentPath}` : `absent at ${environmentPath}`;

	return `## Conductor runtime

- Package root: ${packageRoot}
- Skill roots (each holds \`<name>/SKILL.md\` folders):
${skillRootList}
- Agents:
${agentList}
- Task store: ${resolveTaskStorePath(cwd)}
- Memory lint: pwsh ${path.join(packageRoot, "scripts", "memory-lint.ps1")}
- environment.md: ${environmentState}

${memoryPreamble(cwd, "main", roots)}`;
}

export function registerOrchestrator(pi: ExtensionAPI, deps: OrchestratorDeps): void {
	let enabled = false;

	pi.registerFlag("conductor", {
		description: "Start in conductor (orchestrator) mode",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("conductor", enabled ? ctx.ui.theme.fg("accent", "conductor") : undefined);
	}

	function persistState(): void {
		pi.appendEntry(STATE_KEY, { enabled } satisfies ConductorModeState);
	}

	pi.registerCommand("conductor", {
		description: "Toggle conductor orchestrator mode (/conductor off to disable, /conductor <task> to dispatch)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed.toLowerCase() === "off") {
				enabled = false;
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("Conductor mode disabled.");
				return;
			}

			const wasEnabled = enabled;
			enabled = true;
			updateStatus(ctx);
			persistState();
			if (!wasEnabled) ctx.ui.notify("Conductor mode enabled. Delegate through the subagent tool.");

			if (trimmed.length > 0) pi.sendUserMessage(trimmed);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;

		const orchestratorPrompt = readFileOr(ORCHESTRATOR_PROMPT_PATH, "");
		if (orchestratorPrompt === "") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}\n\n${buildRuntimeBlock(ctx.cwd, deps)}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("conductor") === true) enabled = true;

		const restored = ctx.sessionManager.getEntries().filter(isConductorModeEntry).pop();
		if (restored?.data !== undefined) enabled = restored.data.enabled;

		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("conductor", undefined);
	});
}
