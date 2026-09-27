/**
 * Shared footer-line registry
 *
 * Lets multiple extensions compose into one multi-line footer. Each
 * extension registers a footer line provider (rendered in priority order —
 * lower priority higher on screen) that contributes one row or several
 * (e.g. one per task), an optional per-tick callback, and a footer applier;
 * the registry installs a single composite footer component that flattens
 * every provider's rows, truncates each to the width, and owns the footer's
 * 3s tick (FOOTER_REFRESH_MS). Zero registered lines restores the built-in
 * footer.
 *
 * pi's loader compiles each extension with its own jiti instance
 * (moduleCache: false, no shared parentCache), so the extensions get
 * separate instances of this module — a plain module-level Map would be
 * invisible to the other. The registry therefore lives on globalThis behind
 * a Symbol.for key: every jiti instance in one process shares the process's
 * symbol registry and globalThis, so they all share the same state. Nothing
 * is persisted.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";

/** The footer's repaint cadence, shared by every line. */
export const FOOTER_REFRESH_MS = 3_000;

/** One footer row, or several rows top to bottom; null hides the provider (e.g. an empty task store). */
export type FooterLineRender = (width: number, theme: Theme, footerData: ReadonlyFooterDataProvider) => string | string[] | null;

export interface FooterLineProvider {
	id: string;
	/** Lower priority renders higher on screen (statusline 0, tasklist 1). */
	priority: number;
	render: FooterLineRender;
}

/** The TUI surface the composite footer needs (pi's TUI is structurally wider). */
interface FooterTui {
	requestRender(force?: boolean): void;
}

export type FooterFactory = (
	tui: FooterTui,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Component & { dispose?(): void };

/** Installs the footer, or restores the built-in one with undefined. */
export type FooterApplier = (factory: FooterFactory | undefined) => void;

/** A provider's per-tick callback (store refresh, window refresh, ...). */
export type FooterTick = () => void;

interface FooterLinesRegistry {
	providers: Map<string, FooterLineProvider>;
	ticks: Map<string, FooterTick>;
	appliers: Map<string, FooterApplier>;
}

/** Symbol.for resolves to the same symbol in every module graph of the process. */
const REGISTRY_KEY = Symbol.for("pi.footerLines");

function getRegistry(): FooterLinesRegistry {
	const channel = globalThis as typeof globalThis & Record<symbol, FooterLinesRegistry | undefined>;
	const existing = channel[REGISTRY_KEY];
	if (existing !== undefined) return existing;
	const registry: FooterLinesRegistry = { providers: new Map(), ticks: new Map(), appliers: new Map() };
	channel[REGISTRY_KEY] = registry;
	return registry;
}

/** Register or replace a provider's line and re-sync the composite footer. */
export function registerFooterLine(provider: FooterLineProvider): void {
	getRegistry().providers.set(provider.id, provider);
	syncFooterLines();
}

/** Drop a provider's line and re-sync the composite footer. */
export function unregisterFooterLine(id: string): void {
	getRegistry().providers.delete(id);
	syncFooterLines();
}

/** Register a provider's per-tick callback (no re-sync; the composite reads the map on each tick). */
export function registerFooterTick(id: string, fn: FooterTick): void {
	getRegistry().ticks.set(id, fn);
}

export function unregisterFooterTick(id: string): void {
	getRegistry().ticks.delete(id);
}

/** Register the extension's footer installer (no re-sync; syncFooterLines picks it up). */
export function registerFooterApplier(id: string, fn: FooterApplier): void {
	getRegistry().appliers.set(id, fn);
}

export function unregisterFooterApplier(id: string): void {
	getRegistry().appliers.delete(id);
}

/** The providers in on-screen order (lower priority first). */
export function footerLineSnapshot(): FooterLineProvider[] {
	return [...getRegistry().providers.values()].sort((a, b) => a.priority - b.priority);
}

/**
 * Re-install the composite footer: zero providers restores the built-in
 * footer through the first registered applier; otherwise the lowest-priority
 * provider's applier installs the composite.
 */
export function syncFooterLines(): void {
	const { providers, appliers } = getRegistry();
	const snapshot = footerLineSnapshot();
	const applier = snapshot.length === 0 ? appliers.values().next().value : appliers.get(snapshot[0].id);
	if (applier === undefined) return;
	applier(snapshot.length === 0 ? undefined : createCompositeFactory());
}

function createCompositeFactory(): FooterFactory {
	return (tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		// Repaint + run every provider's tick callback (fail-soft).
		const timer = setInterval(() => {
			for (const fn of getRegistry().ticks.values()) {
				try {
					fn();
				} catch {
					// One failing provider must not break the other lines.
				}
			}
			tui.requestRender();
		}, FOOTER_REFRESH_MS);
		timer.unref();

		return {
			dispose: () => {
				clearInterval(timer);
				unsubscribe();
			},
			invalidate() {},
			render(width: number): string[] {
				const lines = footerLineSnapshot()
					.flatMap((p) => p.render(width, theme, footerData) ?? [])
					.map((line) => truncateToWidth(line, width));
				// A blank line keeps the footer present when every line hides.
				return lines.length === 0 ? [""] : lines;
			},
		};
	};
}
