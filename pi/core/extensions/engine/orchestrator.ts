/**
 * Conductor Orchestrator Runtime
 *
 * Composes the active product's ported system prompt (its `orchestrator.md`)
 * plus a runtime block (package roots, live agent roster, memory index,
 * environment file presence) onto the system prompt every turn.
 *
 * Toggling (the `--conductor`/`--refuter` flags, the `/conductor`/`/refuter`
 * commands, and the active-product session state) is owned by each product
 * shim — this module only reacts to whichever product the shim has made
 * active on `Symbol.for("baton.activeProduct")` (see product-registry.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, discoverAgents, getSkillRoots } from "./agents.ts";
import { type ProductDescriptor, getActiveProductName, getProduct } from "./product-registry.ts";
import { envSpawnDepth } from "./spawn-depth.ts";
import { resolveTaskStorePath } from "./tasks.ts";

const ENVIRONMENT_RELATIVE = path.join(".claude", "conductor", "environment.md");

function readFileOr(filePath: string, fallback: string): string {
	try {
		return fs.readFileSync(filePath, "utf8").trim() || fallback;
	} catch {
		return fallback;
	}
}

/**
 * Runtime facts the static prompt cannot carry: they depend on the install
 * location, the active product, its live agent roster, and the project's
 * vault contents.
 */
function buildRuntimeBlock(cwd: string, product: ProductDescriptor): string {
	const agents = discoverAgents(cwd, "user", product.agentsDir, PACKAGE_ROOT).agents;
	const agentList =
		agents.length > 0
			? agents.map((a) => `  - ${a.name} (${a.source}): ${a.description}`).join("\n")
			: "  - none discovered";

	// Skills always ship from core (only pi/core declares `pi.skills`).
	const roots = getSkillRoots(PACKAGE_ROOT);
	const skillRootList = roots.length > 0 ? roots.map((r) => `  - ${r}`).join("\n") : "  - none";

	const vaultDir = path.join(cwd, ".claude", "agent-memory", product.vaultDir);
	const memoryIndexPath = path.join(vaultDir, "MEMORY.md");
	const memoryIndex = readFileOr(memoryIndexPath, "absent");

	const environmentPath = path.join(cwd, ENVIRONMENT_RELATIVE);
	const environmentState = fs.existsSync(environmentPath) ? `present at ${environmentPath}` : `absent at ${environmentPath}`;

	const taskPlanPath = path.join(cwd, product.taskPlanRel);

	return `## Conductor runtime

- Package root: ${PACKAGE_ROOT}
- Core package root: ${PACKAGE_ROOT}
- Product package root: ${product.packageRoot}
- Product: ${product.name}
- Skill roots (each holds \`<name>/SKILL.md\` folders):
${skillRootList}
- Agents:
${agentList}
- Memory directory: ${vaultDir}
- Memory index (${memoryIndexPath}):
${memoryIndex}
- environment.md: ${environmentState}
- Task plan: ${taskPlanPath}
- Task store: ${resolveTaskStorePath(cwd)}
`;
}

export function registerOrchestrator(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		// A spawned subagent child gets its own brief via --append-system-prompt
		// (see index.ts skillsPreamble/agent.systemPrompt); composing the
		// top-level orchestrator persona on top of that would confuse its role
		// and bloat every dispatch, so only the root session (depth 0) composes.
		if (envSpawnDepth() > 0) return;

		const activeName = getActiveProductName();
		if (activeName === undefined) return;

		const product = getProduct(activeName);
		if (product === undefined) return;

		const orchestratorPrompt = readFileOr(product.orchestratorPromptPath, "");
		if (orchestratorPrompt === "") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}\n\n${buildRuntimeBlock(ctx.cwd, product)}`,
		};
	});
}
