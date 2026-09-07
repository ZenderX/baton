/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "user" | "project" | "package";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * `extensions/conductor` -> package root (the directory holding package.json),
 * i.e. `pi/`. Keep in sync if this file moves.
 */
export const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "..", "..");

export const PACKAGE_AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	excludeTools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	/** Agents this one may dispatch via `subagent`; undefined means it gets no `subagent` tool at all. */
	spawn?: string[];
	skillDirs: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	excludeTools?: unknown;
	model?: unknown;
	thinking?: unknown;
	spawn?: unknown;
	skills?: unknown;
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseThinking(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

/**
 * Skill roots declared under the `pi.skills` key of the package's package.json,
 * resolved against the package root. Every skill this package ships lives one
 * level below one of these (`<root>/<name>/SKILL.md`).
 *
 * Reading the manifest keeps this in step with what pi itself loads: the
 * manifest points at `../../claude/plugins/<plugin>/skills`, and no layout is
 * hardcoded here. Missing or malformed manifests yield no roots rather than
 * throwing.
 */
export function getSkillRoots(packageRoot: string = PACKAGE_ROOT): string[] {
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
	} catch {
		return [];
	}
	const pi = (manifest as { pi?: { skills?: unknown } } | null)?.pi;
	const entries = Array.isArray(pi?.skills) ? pi.skills : [];
	return entries
		.filter((e): e is string => typeof e === "string" && !e.startsWith("!"))
		.map((e) => path.resolve(packageRoot, e))
		.filter(isDirectory);
}

/**
 * Resolve `skills:` names to skill directories inside this package.
 *
 * Each name is looked up as `<skill root>/<name>` across the roots from
 * `getSkillRoots`, first match wins. Unknown names are skipped rather than
 * throwing, matching `parseToolList`'s tolerance: one bad name must not take
 * down the agent that declares it.
 */
function resolveSkillDirs(names: string[], packageRoot: string): string[] {
	const roots = getSkillRoots(packageRoot);
	const dirs: string[] = [];
	for (const name of names) {
		const found = roots.map((root) => path.join(root, name)).find(isDirectory);
		if (found) dirs.push(found);
	}
	return dirs;
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource, packageRoot: string): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			excludeTools: parseToolList(frontmatter.excludeTools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: parseThinking(frontmatter.thinking),
			spawn: parseToolList(frontmatter.spawn),
			skillDirs: resolveSkillDirs(parseToolList(frontmatter.skills) ?? [], packageRoot),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Package agents ship with this extension, so they load under every scope and
 * sit lowest in precedence: a same-named user or project agent overrides them.
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	packageAgentsDir: string = PACKAGE_AGENTS_DIR,
	packageRoot: string = PACKAGE_ROOT,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const packageAgents = loadAgentsFromDir(packageAgentsDir, "package", packageRoot);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", packageRoot);
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", packageRoot);

	const agentMap = new Map<string, AgentConfig>();

	for (const agent of packageAgents) agentMap.set(agent.name, agent);
	if (scope !== "project") for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user") for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
