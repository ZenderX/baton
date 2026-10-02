/**
 * Product registry — the cross-package channel between this engine and each
 * product shim (pi/conductor, pi/refuter). pi packages cannot import one
 * another except by bundling (docs/packages.md §Dependencies), so a shim never
 * imports this module: it independently writes a matching descriptor onto the
 * same globalThis slot when it loads. Mirrors the extensions/subagent-live.ts
 * REGISTRY_KEY pattern, except the writer here is a different package's own
 * compiled module rather than another jiti instance of this same file — so the
 * shape below is a cross-package contract, not a shared type import.
 *
 * This module only reads the registry: writing a descriptor and setting the
 * active product are the registering shim's job.
 */

export interface ProductDescriptor {
	name: string;
	packageRoot: string;
	agentsDir: string;
	orchestratorPromptPath: string;
	vaultDir: string;
	jobsRel: string;
}

/** Symbol.for resolves to the same symbol in every module graph of the process. */
const PRODUCTS_KEY = Symbol.for("baton.products");
const ACTIVE_PRODUCT_KEY = Symbol.for("baton.activeProduct");

type GlobalChannel = typeof globalThis & Record<symbol, unknown>;

/** Undefined until the first shim creates the Map (this module never writes it). */
function getProductsMap(): Map<string, ProductDescriptor> | undefined {
	const existing = (globalThis as GlobalChannel)[PRODUCTS_KEY];
	return existing instanceof Map ? (existing as Map<string, ProductDescriptor>) : undefined;
}

/** Every product shim currently loaded in this process, in registration order. */
export function listProducts(): ProductDescriptor[] {
	const map = getProductsMap();
	return map === undefined ? [] : Array.from(map.values());
}

export function getProduct(name: string): ProductDescriptor | undefined {
	return getProductsMap()?.get(name);
}

/** The product name set by whichever shim's flag/command is currently on; undefined when none is. */
export function getActiveProductName(): string | undefined {
	const value = (globalThis as GlobalChannel)[ACTIVE_PRODUCT_KEY];
	return typeof value === "string" ? value : undefined;
}
