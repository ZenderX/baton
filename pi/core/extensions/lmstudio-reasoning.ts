/**
 * LM Studio reasoning-effort shim
 *
 * LM Studio models whose reasoning capability is on/off only still receive pi's
 * graded `reasoning_effort` ("low"/"medium"/"high"), which the server logs as
 * `Reasoning setting 'medium' is not supported ... Falling back to 'on'`.
 *
 * Deleting the field is the only safe fix: LM Studio rejects `reasoning_effort:
 * "on"` with HTTP 400 (it accepts only none/minimal/low/medium/high/xhigh), so
 * rewriting the value is not an option. With the field absent the model's own
 * default ("on") applies. "none" is left alone -- it maps to off and is valid.
 *
 * Capabilities come from LM Studio's `GET /api/v1/models`, fetched lazily on the
 * first request per server and cached for the session.
 */

import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimExtension } from "./load-guard.ts";

const FETCH_TIMEOUT_MS = 5000;

/** Providers registered by `pi-lmstudio`; only these need the shim. */
const PROVIDER_PREFIX = "lmstudio";

/** Valid pi-side value that LM Studio maps to "off"; never stripped. */
const REASONING_OFF = "none";

/** Marks a server we could not reach, so the hook stays inert for it. */
const UNKNOWN = "unknown";

type AllowedOptions = readonly string[] | typeof UNKNOWN;

interface LMStudioModelEntry {
	/** LM Studio keys models by `key` (e.g. "example-27b@q4_k_m"), not `id`. */
	key: string;
	capabilities?: {
		reasoning?: {
			allowed_options?: string[];
		};
	};
}

interface LMStudioModelsResponse {
	models?: LMStudioModelEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelsResponse(value: unknown): value is LMStudioModelsResponse {
	if (!isRecord(value)) return false;
	const { models } = value;
	return models === undefined || Array.isArray(models);
}

function readAllowedOptions(entry: LMStudioModelEntry): string[] | undefined {
	const options = entry.capabilities?.reasoning?.allowed_options;
	return Array.isArray(options) ? options : undefined;
}

/** `http://host:1234/v1/` -> `http://host:1234` — the /api/v1 root sits beside /v1. */
function serverRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

async function fetchCapabilities(root: string, headers: Record<string, string>): Promise<Map<string, string[]> | undefined> {
	try {
		const response = await fetch(`${root}/api/v1/models`, {
			headers,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`HTTP status ${response.status}`);

		const data: unknown = await response.json();
		if (!isModelsResponse(data)) throw new Error("unexpected /api/v1/models payload");

		const capabilities = new Map<string, string[]>();
		for (const entry of data.models ?? []) {
			const options = readAllowedOptions(entry);
			if (options && typeof entry.key === "string") capabilities.set(entry.key, options);
		}
		return capabilities;
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(`lmstudio-reasoning: could not read capabilities from ${root} (${reason}); leaving payloads untouched.`);
		return undefined;
	}
}

/** A `null` header value means "suppress this header", so it is dropped rather than sent. */
function definedHeaders(headers: ProviderHeaders | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result[name] = value;
	}
	return result;
}

/**
 * `model.headers` holds only static config headers; the token from an
 * `authHeader`/`apiKey` provider (as `pi-lmstudio` registers) is synthesized into
 * the resolved auth at dispatch time and never written back to the model.
 */
async function authHeaders(registry: ExtensionContext["modelRegistry"], model: Model<Api>): Promise<Record<string, string>> {
	const resolved = await registry.getApiKeyAndHeaders(model);
	if (!resolved.ok) {
		console.warn(`lmstudio-reasoning: could not resolve auth for ${model.provider} (${resolved.error}); trying unauthenticated.`);
		return {};
	}

	const headers = definedHeaders(resolved.headers);
	if (!headers["Authorization"] && !headers["authorization"] && resolved.apiKey) {
		headers["Authorization"] = `Bearer ${resolved.apiKey}`;
	}
	return headers;
}

export default function (pi: ExtensionAPI) {
	if (!claimExtension(pi, "core.lmstudio-reasoning")) return;

	// Keyed by server root; a server maps to UNKNOWN once its fetch has failed.
	const servers = new Map<string, Map<string, string[]> | typeof UNKNOWN>();
	const inFlight = new Map<string, Promise<void>>();
	// Bumped when the cache is cleared, so a fetch started before the reset is discarded.
	let generation = 0;

	async function loadServer(root: string, headers: Record<string, string>): Promise<void> {
		const pending = inFlight.get(root);
		if (pending) return pending;

		const started = generation;
		const load = fetchCapabilities(root, headers).then((capabilities) => {
			if (started !== generation) return;
			servers.set(root, capabilities ?? UNKNOWN);
		});
		inFlight.set(root, load);
		try {
			await load;
		} finally {
			inFlight.delete(root);
		}
	}

	function allowedOptionsFor(root: string, modelId: string): AllowedOptions | undefined {
		const cached = servers.get(root);
		if (cached === undefined) return undefined;
		if (cached === UNKNOWN) return UNKNOWN;
		return cached.get(modelId);
	}

	pi.on("session_start", async () => {
		servers.clear();
		generation += 1;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model: Model<Api> | undefined = ctx.model;
		if (!model || model.api !== "openai-completions") return undefined;
		if (model.provider !== PROVIDER_PREFIX && !model.provider.startsWith(`${PROVIDER_PREFIX}/`)) return undefined;

		const payload = event.payload;
		if (!isRecord(payload)) return undefined;

		const effort = payload["reasoning_effort"];
		if (typeof effort !== "string" || effort === REASONING_OFF) return undefined;

		const root = serverRoot(model.baseUrl);
		if (!servers.has(root)) await loadServer(root, await authHeaders(ctx.modelRegistry, model));

		const allowed = allowedOptionsFor(root, model.id);
		if (allowed === undefined || allowed === UNKNOWN) return undefined;
		if (allowed.includes(effort)) return undefined;

		const { reasoning_effort: _stripped, ...rest } = payload;
		return rest;
	});
}
