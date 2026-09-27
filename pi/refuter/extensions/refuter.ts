/**
 * Product shim — the pattern every product package (pi/refuter, pi/conductor)
 * repeats with its own PRODUCT/vaultDir/taskPlanRel below.
 *
 * Registers this package's ProductDescriptor on the shared
 * `Symbol.for("baton.products")` registry, and owns this product's
 * `--<name>` flag, `/<name>` command, and the active-product session state.
 * The core engine (pi/core) never imports this file — it only reads
 * globalThis[Symbol.for("baton.products")] and
 * globalThis[Symbol.for("baton.activeProduct")] (see
 * pi/core/extensions/engine/product-registry.ts). Pi packages cannot depend
 * on one another except by bundling, so this file stays self-contained:
 * nothing imported beyond node:* and pi's own peer-dependency types — never
 * core code.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const PRODUCT = "refuter";
const LABEL = PRODUCT.charAt(0).toUpperCase() + PRODUCT.slice(1);

/**
 * Mirrors core's ProductDescriptor shape (product-registry.ts) as a
 * cross-package contract, not a shared type import — a shim can never import
 * the core package that reads this.
 */
interface ProductDescriptor {
	name: string;
	packageRoot: string;
	agentsDir: string;
	orchestratorPromptPath: string;
	vaultDir: string;
	taskPlanRel: string;
}

/** `extensions/` -> this package's own root. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DESCRIPTOR: ProductDescriptor = {
	name: PRODUCT,
	packageRoot: PACKAGE_ROOT,
	agentsDir: path.join(PACKAGE_ROOT, "agents"),
	orchestratorPromptPath: path.join(PACKAGE_ROOT, "orchestrator.md"),
	vaultDir: "refuter-main",
	taskPlanRel: path.join(".claude", "refuter", "job", "plan.md"),
};

const PRODUCTS_KEY = Symbol.for("baton.products");
const ACTIVE_PRODUCT_KEY = Symbol.for("baton.activeProduct");

type GlobalChannel = typeof globalThis & Record<symbol, unknown>;

/** The registry is a cross-package channel: create it only if no shim has loaded one already. */
function getOrCreateProductsMap(): Map<string, ProductDescriptor> {
	const g = globalThis as GlobalChannel;
	const existing = g[PRODUCTS_KEY];
	if (existing instanceof Map) return existing as Map<string, ProductDescriptor>;
	const map = new Map<string, ProductDescriptor>();
	g[PRODUCTS_KEY] = map;
	return map;
}

/**
 * Double-load guard, mirrored inline from core's extensions/load-guard.ts
 * (key names and the DuplicateLoads shape are the shared contract): when this
 * product is installed twice (umbrella pi/ plus a per-product package), only
 * the first copy to load registers anything; the rest are recorded for one
 * advisory notice per process. The winner releases its claim on
 * session_shutdown, which pi emits before every reload re-runs the factories.
 */
interface DuplicateLoads {
	skipped: Set<string>;
	notified: boolean;
}

const DUPLICATES_KEY = Symbol.for("baton.duplicateLoads");
const CLAIM_KEY = Symbol.for(`baton.extension.${PRODUCT}`);

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

function claimProduct(pi: ExtensionAPI): boolean {
	const g = globalThis as GlobalChannel;
	if (g[CLAIM_KEY] !== undefined) {
		getDuplicateLoads().skipped.add(PRODUCT);
		return false;
	}
	g[CLAIM_KEY] = true;

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
		delete g[CLAIM_KEY];
	});

	return true;
}

// Set as early as possible (module load, before the extension factory below
// even runs) so the core statusline's session_start sees an active product
// on the very first turn. Covers both a root launch (--<name>) and a
// spawned child (PI_CONDUCTOR_PRODUCT, set by the engine's subagent tool on
// every child — see spawn-depth.ts). The persisted-session restore for a
// resumed root session still happens below, in session_start.
if (process.argv.includes(`--${PRODUCT}`) || process.env.PI_CONDUCTOR_PRODUCT === PRODUCT) {
	(globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] = PRODUCT;
}

/**
 * One entry type shared by every product shim (not `"<product>-mode"` per
 * shim, which let two coexisting shims disagree about which product a
 * resumed session should restore). `product` is the whole session's
 * last-active product, or null when explicitly turned off; every shim reads
 * the same history and compares it to its own PRODUCT.
 */
const STATE_KEY = "baton.activeProduct";

interface ActiveProductState {
	product: string | null;
}

function isActiveProductEntry(entry: SessionEntry): entry is CustomEntry<ActiveProductState> {
	return entry.type === "custom" && entry.customType === STATE_KEY;
}

export default function (pi: ExtensionAPI): void {
	if (!claimProduct(pi)) return;
	// Only the winning copy's descriptor (its own agents and prompts) reaches the engine.
	getOrCreateProductsMap().set(PRODUCT, DESCRIPTOR);

	let enabled = false;

	pi.registerFlag(PRODUCT, {
		description: `Start in ${PRODUCT} (orchestrator) mode`,
		type: "boolean",
		default: false,
	});

	/** Always reflects the shared slot, never this shim's private belief — a sibling shim can reclaim it mid-session. */
	function updateStatus(ctx: ExtensionContext): void {
		const isActive = (globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] === PRODUCT;
		ctx.ui.setStatus(PRODUCT, isActive ? ctx.ui.theme.fg("accent", PRODUCT) : undefined);
	}

	function persistState(): void {
		pi.appendEntry(STATE_KEY, { product: enabled ? PRODUCT : null } satisfies ActiveProductState);
	}

	/** Enabling always claims the slot; disabling only clears it if this shim still owns it — never clobber a different active product. */
	function setActive(next: boolean): void {
		enabled = next;
		const g = globalThis as GlobalChannel;
		if (next) g[ACTIVE_PRODUCT_KEY] = PRODUCT;
		else if (g[ACTIVE_PRODUCT_KEY] === PRODUCT) g[ACTIVE_PRODUCT_KEY] = undefined;
	}

	pi.registerCommand(PRODUCT, {
		description: `Toggle ${PRODUCT} orchestrator mode (/${PRODUCT} off to disable, /${PRODUCT} <task> to dispatch)`,
		handler: async (args, ctx) => {
			// Reconcile with the slot first: a sibling shim may have claimed or
			// released it since this shim's own last write (coexisting products).
			enabled = (globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY] === PRODUCT;
			const owned = enabled;
			const trimmed = args.trim();

			if (trimmed.toLowerCase() === "off") {
				setActive(false);
				// Only this shim's own "off" is history: a foreign product's slot was
				// never ours to persist as null, which would otherwise overwrite that
				// product's entry and lose it on the next resume.
				if (owned) persistState();
				updateStatus(ctx);
				ctx.ui.notify(owned ? `${LABEL} mode disabled.` : `${LABEL} mode is not active.`);
				return;
			}

			const wasEnabled = enabled;
			setActive(true);
			persistState();
			updateStatus(ctx);
			if (!wasEnabled) ctx.ui.notify(`${LABEL} mode enabled. Delegate through the subagent tool.`);

			if (trimmed.length > 0) pi.sendUserMessage(trimmed);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// An explicit flag for this launch always wins and needs no further check.
		if (pi.getFlag(PRODUCT) === true) {
			setActive(true);
		} else {
			// A restored entry only decides this shim's state when the slot is
			// still unclaimed: a product already in the slot outranks restored
			// history, since that product's own flag or module-load argv/env
			// check already resolved this launch.
			const restored = ctx.sessionManager.getEntries().filter(isActiveProductEntry).pop();
			if (restored?.data !== undefined) {
				const currentSlot = (globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY];
				const claimedByOther = typeof currentSlot === "string" && currentSlot !== PRODUCT;
				if (!claimedByOther) setActive(restored.data.product === PRODUCT);
			}
		}

		updateStatus(ctx);
	});

	// A sibling shim can reclaim or release the slot without firing any event
	// of this shim's own (e.g. a sibling product's command in a coexisting session);
	// re-render from the slot every turn so the status never goes stale.
	pi.on("turn_start", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(PRODUCT, undefined);
	});
}
