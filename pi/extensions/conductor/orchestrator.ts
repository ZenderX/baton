/**
 * Conductor Orchestrator Mode
 *
 * Turns the current session into the conductor: the ported `main.md` system
 * prompt plus a runtime block (package root, live agent roster, memory index,
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

const ORCHESTRATOR_PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator.md");

const MEMORY_INDEX_RELATIVE = path.join(".claude", "agent-memory", "conductor-main", "MEMORY.md");
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
	discover: () => AgentConfig[];
}

function readFileOr(filePath: string, fallback: string): string {
	try {
		return fs.readFileSync(filePath, "utf8").trim() || fallback;
	} catch {
		return fallback;
	}
}

/**
 * Runtime facts the static prompt cannot carry: they depend on the install
 * location, the live agent roster, and the project's vault contents.
 */
function buildRuntimeBlock(cwd: string, { packageRoot, discover }: OrchestratorDeps): string {
	const agents = discover();
	const agentList =
		agents.length > 0
			? agents.map((a) => `  - ${a.name} (${a.source}): ${a.description}`).join("\n")
			: "  - none discovered";

	const memoryIndexPath = path.join(cwd, MEMORY_INDEX_RELATIVE);
	const memoryIndex = readFileOr(memoryIndexPath, "absent");

	const environmentPath = path.join(cwd, ENVIRONMENT_RELATIVE);
	const environmentState = fs.existsSync(environmentPath) ? `present at ${environmentPath}` : `absent at ${environmentPath}`;

	return `## Conductor runtime

- Package root: ${packageRoot}
- Agents:
${agentList}
- Memory directory: ${path.join(cwd, ".claude", "agent-memory", "conductor-main")}
- Memory index (${memoryIndexPath}):
${memoryIndex}
- environment.md: ${environmentState}
`;
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
