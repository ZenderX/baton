/**
 * Product-shim harness — drives refuter/extensions/refuter.ts (this
 * package's product shim) with a fake ExtensionAPI/ExtensionContext and a
 * fake session-entry store to verify, without a live pi process:
 *
 *   1. Module-load activation: importing the shim with `--refuter` already
 *      in process.argv claims Symbol.for("baton.activeProduct") before the
 *      extension factory ever runs.
 *   2. Module-load activation: importing the shim with
 *      PI_CONDUCTOR_PRODUCT=refuter already in the environment (mirroring a
 *      spawned subagent child) claims the same slot.
 *   3. `/refuter off` clears the slot only when this shim still owns it — a
 *      foreign active product (set before this shim ever loads) survives an
 *      off command from a shim that never actually held the slot.
 *   4. session_start: a foreign active product already claiming the slot
 *      plus a stale shared session entry naming this product leaves the
 *      foreign product active — a resumed session's history must not
 *      outrank whichever product's flag or module-load check already won.
 *   5. `/refuter off` while a foreign product owns the slot persists no
 *      entry at all (a bare disable from a shim that was never active must
 *      not overwrite the shared history with `{product: null}` and erase
 *      the foreign product's own persisted state).
 *   6. `turn_start` re-renders the status from the slot every turn, so a
 *      sibling shim reclaiming the slot without firing any event of this
 *      shim's own (e.g. a `/conductor` command in a coexisting session)
 *      still clears a stale "refuter" status by the next turn.
 *   7. `/refuter <task>` persists `{product: "refuter"}` and forwards the
 *      task text via sendUserMessage.
 *   8. `/refuter off` when this shim owns the slot clears it and persists
 *      `{product: null}`.
 *   9. session_start with a restored entry naming a different product and
 *      an unclaimed slot leaves refuter off (the mirror of check 4: history
 *      for a different product is honoured, not misapplied to this one).
 *
 * Each scenario imports a fresh module instance via a cache-busting query
 * string appended to the specifier: the shim's activation runs once at
 * module load, and Node caches ES module instances by resolved specifier, so
 * re-importing the same path would reuse the first run's side effects.
 *
 * Run with: node --experimental-strip-types scripts/product-shim-harness.mts
 * (This file is intentionally NOT listed in package.json pi.extensions.)
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ACTIVE_PRODUCT_KEY = Symbol.for("baton.activeProduct");
const PRODUCTS_KEY = Symbol.for("baton.products");

type GlobalChannel = typeof globalThis & Record<symbol, unknown>;

function getActiveProduct(): string | undefined {
	const value = (globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY];
	return typeof value === "string" ? value : undefined;
}

/** Each scenario starts from a clean registry: no shim has loaded yet. */
function resetRegistry(): void {
	delete (globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY];
	delete (globalThis as GlobalChannel)[PRODUCTS_KEY];
}

const SHIM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "refuter", "extensions", "refuter.ts");
let importSeq = 0;

type ShimModule = { default: (pi: ExtensionAPI) => void };

/** A fresh module instance per call: the shim's module-load activation must run again. */
async function freshShim(): Promise<ShimModule> {
	importSeq += 1;
	const url = `${pathToFileURL(SHIM_PATH).href}?harness=${importSeq}`;
	return (await import(url)) as ShimModule;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown;

interface AppendedEntry {
	customType: string;
	data: unknown;
}

interface Env {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	fire: (name: string, event: unknown) => Promise<void>;
	commands: Map<string, CommandHandler>;
	appended: AppendedEntry[];
	notified: string[];
	statuses: Map<string, string | undefined>;
	sentMessages: string[];
}

interface MakeEnvOptions {
	/** Flags the fake pi reports via getFlag; defaults to none set. */
	flags?: Record<string, boolean>;
	/** Session entries the fake session manager returns. */
	entries?: unknown[];
}

function makeEnv(options: MakeEnvOptions = {}): Env {
	const { flags = {}, entries = [] } = options;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const appended: AppendedEntry[] = [];
	const notified: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const sentMessages: string[] = [];

	const theme = { fg: (_color: string, text: string): string => text };
	const ui = {
		setStatus: (key: string, text: string | undefined): void => {
			statuses.set(key, text);
		},
		notify: (message: string): void => {
			notified.push(message);
		},
		theme,
	};

	const ctx = {
		ui,
		sessionManager: { getEntries: (): unknown[] => entries },
	} as unknown as ExtensionContext;

	const pi = {
		registerFlag: (): void => undefined,
		registerCommand: (name: string, spec: { description: string; handler: CommandHandler }): void => {
			commands.set(name, spec.handler);
		},
		getFlag: (name: string): boolean => flags[name] === true,
		appendEntry: (customType: string, data: unknown): void => {
			appended.push({ customType, data });
		},
		sendUserMessage: (content: unknown): void => {
			sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
		},
		on: (name: string, handler: Handler): void => {
			const list = handlers.get(name);
			if (list === undefined) {
				handlers.set(name, [handler]);
				return;
			}
			list.push(handler);
		},
	} as unknown as ExtensionAPI;

	async function fire(name: string, event: unknown): Promise<void> {
		const list = handlers.get(name);
		if (list === undefined) throw new Error(`no handler registered for ${name}`);
		for (const handler of list) await handler(event, ctx);
	}

	return { pi, ctx, fire, commands, appended, notified, statuses, sentMessages };
}

async function main(): Promise<void> {
	// --- 1. Module-load activation from --refuter in argv ---
	{
		resetRegistry();
		const originalArgv = process.argv;
		try {
			process.argv = [...originalArgv, "--refuter"];
			await freshShim();
			assert.equal(
				getActiveProduct(),
				"refuter",
				"importing with --refuter in argv should claim the active-product slot at module load",
			);
			console.log("  [1] --refuter argv claims the slot at module load");
		} finally {
			process.argv = originalArgv;
		}
	}

	// --- 2. Module-load activation from PI_CONDUCTOR_PRODUCT=refuter (a spawned child) ---
	{
		resetRegistry();
		const original = process.env.PI_CONDUCTOR_PRODUCT;
		try {
			process.env.PI_CONDUCTOR_PRODUCT = "refuter";
			await freshShim();
			assert.equal(
				getActiveProduct(),
				"refuter",
				"importing with PI_CONDUCTOR_PRODUCT=refuter should claim the active-product slot at module load",
			);
			console.log("  [2] PI_CONDUCTOR_PRODUCT=refuter claims the slot at module load");
		} finally {
			if (original === undefined) delete process.env.PI_CONDUCTOR_PRODUCT;
			else process.env.PI_CONDUCTOR_PRODUCT = original;
		}
	}

	// --- 3. /refuter off never clobbers a foreign active product ---
	{
		resetRegistry();
		(globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] = "conductor";
		const shim = await freshShim();
		const env = makeEnv();
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });

		const off = env.commands.get("refuter");
		assert.ok(off !== undefined, "the /refuter command handler must be registered");
		await off("off", env.ctx);

		assert.equal(getActiveProduct(), "conductor", "/refuter off must not clear a foreign product's slot");
		console.log("  [3] /refuter off leaves a foreign active product untouched");
	}

	// --- 4. session_start: a foreign active product plus a stale shared entry leaves the foreign product active ---
	{
		resetRegistry();
		(globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] = "conductor";
		const shim = await freshShim();
		// A stale entry from a previous session where refuter was last active,
		// resumed into a coexisting session where conductor already won the slot.
		const env = makeEnv({ entries: [{ type: "custom", customType: "baton.activeProduct", data: { product: "refuter" } }] });
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });

		assert.equal(
			getActiveProduct(),
			"conductor",
			"a foreign in-memory active product must win over this shim's own stale session entry",
		);
		console.log("  [4] a foreign active product survives a stale shared session entry");
	}

	// --- 5. /refuter off under a foreign owner persists no entry at all ---
	{
		resetRegistry();
		(globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] = "conductor";
		const shim = await freshShim();
		// Pre-existing history already names the foreign product; an off from a
		// shim that was never active must leave this alone, not overwrite it.
		const env = makeEnv({ entries: [{ type: "custom", customType: "baton.activeProduct", data: { product: "conductor" } }] });
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });

		const off = env.commands.get("refuter");
		assert.ok(off !== undefined, "the /refuter command handler must be registered");
		await off("off", env.ctx);

		assert.equal(getActiveProduct(), "conductor", "off under a foreign owner must leave the foreign product's slot alone");
		assert.equal(env.appended.length, 0, "off under a foreign owner must not persist a {product: null} entry over the foreign product's history");
		console.log("  [5] off under a foreign owner persists nothing");
	}

	// --- 6. turn_start re-renders the status after a sibling reclaims the slot ---
	{
		resetRegistry();
		const shim = await freshShim();
		const env = makeEnv({ flags: { refuter: true } });
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });

		assert.notEqual(env.statuses.get("refuter"), undefined, "an own session_start with the flag should light the status");

		// A sibling shim claims the slot without this shim hearing any event of its own.
		(globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] = "conductor";
		await env.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });

		assert.equal(env.statuses.get("refuter"), undefined, "turn_start should clear a stale status once a sibling reclaims the slot");
		console.log("  [6] turn_start re-renders the status from the slot");
	}

	// --- 7. /refuter <task> persists {product: "refuter"} and forwards the task ---
	{
		resetRegistry();
		const shim = await freshShim();
		const env = makeEnv();
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });

		const cmd = env.commands.get("refuter");
		assert.ok(cmd !== undefined, "the /refuter command handler must be registered");
		await cmd("do the thing", env.ctx);

		assert.equal(getActiveProduct(), "refuter", "/refuter <task> should claim the slot");
		assert.equal(env.appended.length, 1, "/refuter <task> should persist exactly one entry");
		assert.deepEqual(env.appended[0], { customType: "baton.activeProduct", data: { product: "refuter" } });
		assert.deepEqual(env.sentMessages, ["do the thing"], "/refuter <task> should forward the task via sendUserMessage");
		console.log("  [7] /refuter <task> persists and dispatches");
	}

	// --- 8. /refuter off when owned clears the slot and persists {product: null} ---
	{
		resetRegistry();
		const shim = await freshShim();
		const env = makeEnv({ flags: { refuter: true } });
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });
		assert.equal(getActiveProduct(), "refuter", "precondition: the flag should have claimed the slot");

		const off = env.commands.get("refuter");
		assert.ok(off !== undefined, "the /refuter command handler must be registered");
		await off("off", env.ctx);

		assert.equal(getActiveProduct(), undefined, "off when owned should clear the slot");
		assert.equal(env.appended.length, 1, "off when owned should persist exactly one entry");
		assert.deepEqual(env.appended[0], { customType: "baton.activeProduct", data: { product: null } });
		console.log("  [8] /refuter off when owned clears and persists null");
	}

	// --- 9. session_start with a restored entry naming a different product and an unclaimed slot leaves refuter off ---
	{
		resetRegistry();
		const shim = await freshShim();
		const env = makeEnv({ entries: [{ type: "custom", customType: "baton.activeProduct", data: { product: "conductor" } }] });
		shim.default(env.pi);
		await env.fire("session_start", { type: "session_start" });

		assert.notEqual(getActiveProduct(), "refuter", "restored history naming a different product must not activate refuter");
		assert.equal(env.statuses.get("refuter"), undefined, "refuter's own status must stay off");
		console.log("  [9] a restored entry naming a different product leaves refuter off");
	}

	console.log("\nAll product-shim harness checks passed.");
}

main().catch((err: unknown): void => {
	console.error(err instanceof Error ? err.stack : String(err));
	process.exit(1);
});
