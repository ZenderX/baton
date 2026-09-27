/**
 * Double-load harness — loads every extension entry of the umbrella manifest
 * (pi/package.json pi.extensions) twice in one process against a fake
 * ExtensionAPI whose flag, tool, command and shortcut names are process-wide
 * and throw on a duplicate (pi exits at startup on a duplicate flag or tool),
 * and verifies the double-load guard (core/extensions/load-guard.ts and its
 * inline mirror in each product shim):
 *
 *   Shape a, same file twice: the umbrella entries, then the same paths again
 *   as the per-folder packages reach them. Each load is a fresh module
 *   instance (pi's jiti runs with moduleCache: false).
 *   Shape b, a second copy: the umbrella entries, then a copy of core,
 *   conductor and refuter in a temp dir (a published per-product install).
 *
 * For each shape and each entry:
 *   1. exactly one copy registers anything, and it is the first one loaded;
 *      the other copy makes no API call at all (no flag, tool, command,
 *      shortcut or handler);
 *   2. session_start across all copies shows exactly one advisory notice,
 *      naming every skipped logical extension;
 *   3. only the winning shim's descriptor is on the product registry;
 *   4. after session_shutdown, a reload of the same copies registers exactly
 *      one copy per entry again and shows no second notice.
 *
 * Run with: node --experimental-strip-types pi/scripts/double-load-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTICE_PREFIX = "Skipped duplicate copies of ";
const PRODUCTS_KEY = Symbol.for("baton.products");

type GlobalChannel = typeof globalThis & Record<symbol, unknown>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Factory = (pi: ExtensionAPI) => unknown;

interface PiManifest {
	pi: { extensions: string[] };
}

/** Umbrella entries as paths relative to pi/, e.g. `core/extensions/statusline.ts`. */
function umbrellaEntries(): string[] {
	const manifest = JSON.parse(fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf8")) as PiManifest;
	return manifest.pi.extensions.map((entry) => path.normalize(entry));
}

/** A fresh process: drop every baton.* and footer-line slot a previous shape left on globalThis. */
function resetProcess(): void {
	const g = globalThis as GlobalChannel;
	for (const key of Object.getOwnPropertySymbols(g)) {
		const name = key.description ?? "";
		if (name.startsWith("baton.") || name === "pi.footerLines") delete g[key];
	}
}

/** Names pi tracks across every extension of one process: a second registration is the fatal conflict. */
interface Registry {
	flags: Set<string>;
	tools: Set<string>;
	commands: Set<string>;
	shortcuts: Set<string>;
}

function claimName(set: Set<string>, kind: string, name: string, entry: string): void {
	if (set.has(name)) throw new Error(`duplicate ${kind} "${name}" registered by ${entry}`);
	set.add(name);
}

interface LoadedCopy {
	entry: string;
	file: string;
	calls: number;
	handlers: Map<string, Handler[]>;
}

function makeApi(registry: Registry, copy: LoadedCopy): ExtensionAPI {
	const count = (): void => {
		copy.calls += 1;
	};
	const pi = {
		on: (event: string, handler: Handler): void => {
			count();
			const list = copy.handlers.get(event) ?? [];
			list.push(handler);
			copy.handlers.set(event, list);
		},
		registerFlag: (name: string): void => {
			count();
			claimName(registry.flags, "flag", name, copy.file);
		},
		registerTool: (tool: { name: string }): void => {
			count();
			claimName(registry.tools, "tool", tool.name, copy.file);
		},
		registerCommand: (name: string): void => {
			count();
			claimName(registry.commands, "command", name, copy.file);
		},
		registerShortcut: (shortcut: string): void => {
			count();
			claimName(registry.shortcuts, "shortcut", shortcut, copy.file);
		},
		getFlag: (): boolean => false,
	};
	return pi as unknown as ExtensionAPI;
}

let importSeq = 0;

/** One load cycle: import each file as a fresh module instance, in order, and run its factory. */
async function loadCycle(copies: Array<{ entry: string; file: string }>): Promise<LoadedCopy[]> {
	const registry: Registry = { flags: new Set(), tools: new Set(), commands: new Set(), shortcuts: new Set() };
	const loaded: LoadedCopy[] = [];
	for (const { entry, file } of copies) {
		importSeq += 1;
		const module = (await import(`${pathToFileURL(file).href}?double-load=${importSeq}`)) as { default: Factory };
		const copy: LoadedCopy = { entry, file, calls: 0, handlers: new Map() };
		await module.default(makeApi(registry, copy));
		loaded.push(copy);
	}
	return loaded;
}

function makeCtx(notices: string[]): ExtensionContext {
	const ctx = {
		hasUI: true,
		cwd: PI_ROOT,
		model: undefined,
		ui: {
			notify: (message: string): void => {
				notices.push(message);
			},
			setStatus: (): void => undefined,
			setFooter: (): void => undefined,
			theme: { fg: (_color: string, text: string): string => text },
		},
		sessionManager: { getEntries: (): unknown[] => [], getBranch: (): unknown[] => [] },
	};
	return ctx as unknown as ExtensionContext;
}

async function fire(loaded: LoadedCopy[], event: string, ctx: ExtensionContext): Promise<void> {
	for (const copy of loaded) {
		for (const handler of copy.handlers.get(event) ?? []) await handler({ type: event }, ctx);
	}
}

function assertOneWinnerPerEntry(shape: string, loaded: LoadedCopy[], entries: string[]): void {
	for (const entry of entries) {
		const copies = loaded.filter((copy) => copy.entry === entry);
		assert.equal(copies.length, 2, `${shape}: ${entry} should be loaded twice`);
		const registering = copies.filter(({ calls }) => calls > 0);
		assert.equal(registering.length, 1, `${shape}: exactly one copy of ${entry} should register, got ${registering.length}`);
		assert.equal(registering[0], copies[0], `${shape}: the first-loaded copy of ${entry} should win`);
		assert.equal(copies[1].calls, 0, `${shape}: the skipped copy of ${entry} must make no API call`);
	}
}

function assertWinningDescriptors(shape: string): void {
	const products = (globalThis as GlobalChannel)[PRODUCTS_KEY];
	assert.ok(products instanceof Map, `${shape}: the product registry should exist`);
	for (const name of ["conductor", "refuter"]) {
		const descriptor: unknown = products.get(name);
		assert.ok(typeof descriptor === "object" && descriptor !== null && "packageRoot" in descriptor, `${shape}: ${name} descriptor missing`);
		assert.equal(descriptor.packageRoot, path.join(PI_ROOT, name), `${shape}: ${name} descriptor should be the winning (umbrella) copy's`);
	}
}

async function runShape(shape: string, entries: string[], secondRoot: string): Promise<void> {
	resetProcess();
	const copies = [
		...entries.map((entry) => ({ entry, file: path.join(PI_ROOT, entry) })),
		...entries.map((entry) => ({ entry, file: path.join(secondRoot, entry) })),
	];

	const notices: string[] = [];
	const ctx = makeCtx(notices);

	const loaded = await loadCycle(copies);
	assertOneWinnerPerEntry(shape, loaded, entries);
	assertWinningDescriptors(shape);

	await fire(loaded, "session_start", ctx);
	const advisories = notices.filter((message) => message.startsWith(NOTICE_PREFIX));
	assert.equal(advisories.length, 1, `${shape}: exactly one advisory notice expected, got ${advisories.length}`);
	for (const id of ["core.engine", "core.statusline", "core.task-list", "core.lmstudio-reasoning", "conductor", "refuter"]) {
		assert.ok(advisories[0].includes(id), `${shape}: the notice should name ${id}: ${advisories[0]}`);
	}

	// /reload: pi emits session_shutdown to the old extensions, then re-runs every factory.
	await fire(loaded, "session_shutdown", ctx);
	const reloaded = await loadCycle(copies);
	assertOneWinnerPerEntry(`${shape} after reload`, reloaded, entries);
	await fire(reloaded, "session_start", ctx);
	const allAdvisories = notices.filter((message) => message.startsWith(NOTICE_PREFIX));
	assert.equal(allAdvisories.length, 1, `${shape}: a reload must not show a second notice`);
	await fire(reloaded, "session_shutdown", ctx);

	console.log(`  [${shape}] ${entries.length} entries: one registration each, 1 notice, reload re-registers once, no second notice`);
}

/** A published-install stand-in: core, conductor and refuter copied outside pi/, resolving pi's node_modules through a junction. */
function makeCopy(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-double-load-"));
	for (const pkg of ["core", "conductor", "refuter"]) {
		fs.cpSync(path.join(PI_ROOT, pkg), path.join(dir, pkg), {
			recursive: true,
			filter: (source) => path.basename(source) !== "node_modules",
		});
	}
	fs.symlinkSync(path.join(PI_ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
	return dir;
}

async function main(): Promise<void> {
	delete process.env.PI_CONDUCTOR_PRODUCT;
	const entries = umbrellaEntries();

	await runShape("same file twice", entries, PI_ROOT);

	const copyDir = makeCopy();
	try {
		await runShape("second copy", entries, copyDir);
	} finally {
		fs.unlinkSync(path.join(copyDir, "node_modules"));
		fs.rmSync(copyDir, { recursive: true, force: true });
	}

	console.log("\nAll double-load harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
