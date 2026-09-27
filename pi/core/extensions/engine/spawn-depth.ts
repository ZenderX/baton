/**
 * Depth of this process in the conductor/refuter dispatch tree, read from
 * PI_CONDUCTOR_SPAWN_DEPTH (set on every child the `subagent` tool spawns,
 * see extensions/engine/index.ts). A single source shared by index.ts (the
 * spawn-depth limit), orchestrator.ts (suppress the orchestrator prompt in
 * spawned children — they get their own brief via --append-system-prompt,
 * not the top-level persona; register the task tools only at the root) and
 * statusline.ts / task-list.ts (suppress the footer's active-product
 * auto-enable in headless children), so the readings can never drift apart.
 */
export function envSpawnDepth(): number {
	const parsed = Number.parseInt(process.env.PI_CONDUCTOR_SPAWN_DEPTH ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
