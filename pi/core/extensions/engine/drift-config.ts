/**
 * Per-child drift config: built by the engine at spawn (index.ts) and handed
 * to the child through PI_CONDUCTOR_DRIFT, where the drift-nudge extension
 * reads it back. A child spawned in `--mode json` reads no stdin, so the env
 * is the only channel into it, the same one PI_CONDUCTOR_SPAWN_DEPTH uses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DriftConfig } from "./drift.ts";

export const DRIFT_ENV = "PI_CONDUCTOR_DRIFT";

export interface ChildDriftConfig extends DriftConfig {
	agent: string;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isChildDriftConfig(value: unknown): value is ChildDriftConfig {
	if (typeof value !== "object" || value === null) return false;
	return (
		"agent" in value &&
		typeof value.agent === "string" &&
		"noProgress" in value &&
		typeof value.noProgress === "boolean" &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"surface" in value &&
		isStringArray(value.surface)
	);
}

/** Path-like backticked tokens on the `**Surface:**` line of `## <phaseId>` in a plan file; [] on any failure. */
export function planSurface(planPath: string, phaseId: string): string[] {
	let text: string;
	try {
		text = fs.readFileSync(planPath, "utf-8");
	} catch {
		return [];
	}
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === `## ${phaseId}`);
	if (start === -1) return [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("## ")) return [];
		if (!line.startsWith("**Surface:**")) continue;
		return Array.from(line.matchAll(/`([^`]+)`/g), (match) => match[1])
			.filter((token) => /[\\/]/.test(token))
			// A glob or brace list narrows nothing the prefix match can use, so keep the literal directory before it.
			.map((token) => token.split(/[*?{[]/)[0])
			.filter((token) => token !== "");
	}
	return [];
}

const JOB_ID = /^\d{8}-\d{4}-[0-9a-f]{4}$/;

/** The plan.md of the job folder the dispatched file sits in, or undefined unless that folder is `<jobsDir>/<job-id>` (never `archive/`). */
function dispatchedPlanPath(dispatchedDir: string, cwd: string, jobsDir: string): string | undefined {
	const jobDir = path.resolve(cwd, dispatchedDir);
	if (path.dirname(jobDir) !== path.resolve(cwd, jobsDir)) return undefined;
	if (!JOB_ID.test(path.basename(jobDir))) return undefined;
	return path.join(jobDir, "plan.md");
}

/** The config a spawned child gets: no-progress only for opted-in agents, Surface prefixes when the task names a plan or issues section of a job folder under `jobsDir`. */
export function childDriftConfig(
	agent: string,
	driftProgress: boolean,
	task: string,
	cwd: string,
	jobsDir: string | undefined,
): ChildDriftConfig {
	// No `.` in the id: dispatch lines end with one ("Implement .claude/conductor/jobs/<job-id>/plan.md#p1-x.").
	// A fix pass ("Fix .../issues.md#p1-x.") shares its phase's Surface in the sibling plan.md.
	const phase = /([^\s"'`]*)\b(?:plan|issues)\.md#([\w-]+)/.exec(task);
	const planPath = phase === null || jobsDir === undefined ? undefined : dispatchedPlanPath(phase[1], cwd, jobsDir);
	const surface = phase === null || planPath === undefined ? [] : planSurface(planPath, phase[2]);
	return { agent, noProgress: driftProgress, cwd, surface };
}

/** This process's drift config, or undefined outside a spawned child or when the value is malformed. */
export function envDriftConfig(): ChildDriftConfig | undefined {
	const raw = process.env[DRIFT_ENV];
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	return isChildDriftConfig(parsed) ? parsed : undefined;
}
