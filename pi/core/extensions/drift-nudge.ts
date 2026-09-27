/**
 * Drift nudge — runs inside every spawned subagent child. Each completed tool
 * call goes to the engine's drift detectors (engine/drift.ts); a nudge they
 * return is steered into this child's own session, landing after the current
 * turn's tool calls and before the next model request. It never stops the
 * child. Config arrives from the parent engine via PI_CONDUCTOR_DRIFT
 * (engine/drift-config.ts); without it (the top-level session) nothing is sent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envDriftConfig } from "./engine/drift-config.ts";
import { newDriftState, observeToolCall } from "./engine/drift.ts";
import { envSpawnDepth } from "./engine/spawn-depth.ts";
import { claimExtension } from "./load-guard.ts";

export default function (pi: ExtensionAPI) {
	if (!claimExtension(pi, "core.drift-nudge")) return;
	const config = envDriftConfig();
	if (config === undefined || envSpawnDepth() === 0) return;

	const state = newDriftState(config);
	pi.on("tool_result", (event) => {
		const resultText = event.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		const message = observeToolCall(state, {
			toolName: event.toolName,
			input: event.input,
			resultText,
			isError: event.isError,
		});
		// tool_result only fires while a run is active, so the steer queues instead of starting a new run.
		if (message !== undefined) pi.sendUserMessage(message, { deliverAs: "steer" });
	});
}
