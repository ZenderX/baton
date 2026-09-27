/**
 * Double-load guard
 *
 * The same extension can be active more than once in one pi process: the
 * umbrella `pi/` package next to a published per-product install, or next to
 * a per-folder install whose copy sits at another path. pi dedupes packages
 * by identity only (npm name, git URL, resolved path), and two copies that
 * both register the same flag or tool make pi exit at startup. So every
 * extension entry claims its logical id first; the first copy to load wins
 * and every later copy registers nothing at all.
 *
 * The claim lives on globalThis behind `Symbol.for("baton.extension.<id>")`:
 * every copy shares it whatever its file path or jiti instance. The winner
 * releases it on session_shutdown, which pi emits before every /reload or
 * session replacement re-runs the extension factories. Skipped copies are
 * recorded on `Symbol.for("baton.duplicateLoads")`, and the first winner to
 * see a session_start with a UI shows one notice for the whole process.
 *
 * The product shims (pi/conductor, pi/refuter) cannot import core and mirror
 * this inline, so the key names and the DuplicateLoads shape are a
 * cross-package contract.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DuplicateLoads {
	skipped: Set<string>;
	notified: boolean;
}

const DUPLICATES_KEY = Symbol.for("baton.duplicateLoads");

type GlobalChannel = typeof globalThis & Record<symbol, unknown>;

function isDuplicateLoads(value: unknown): value is DuplicateLoads {
	return typeof value === "object" && value !== null && "skipped" in value && value.skipped instanceof Set;
}

function getDuplicateLoads(): DuplicateLoads {
	const g = globalThis as GlobalChannel;
	const existing = g[DUPLICATES_KEY];
	if (isDuplicateLoads(existing)) return existing;
	const created: DuplicateLoads = { skipped: new Set(), notified: false };
	g[DUPLICATES_KEY] = created;
	return created;
}

/** True when this copy owns `id` and must register; false when another copy already does. */
export function claimExtension(pi: ExtensionAPI, id: string): boolean {
	const g = globalThis as GlobalChannel;
	const key = Symbol.for(`baton.extension.${id}`);
	if (g[key] !== undefined) {
		getDuplicateLoads().skipped.add(id);
		return false;
	}
	g[key] = true;

	pi.on("session_start", (_event, ctx) => {
		const duplicates = getDuplicateLoads();
		if (duplicates.notified || duplicates.skipped.size === 0 || !ctx.hasUI) return;
		duplicates.notified = true;
		ctx.ui.notify(
			`Skipped duplicate copies of ${[...duplicates.skipped].join(", ")}: the same baton extension is installed more than once (for example the umbrella pi/ package plus a per-product package). Remove one install.`,
			"info",
		);
	});

	pi.on("session_shutdown", () => {
		delete g[key];
	});

	return true;
}
