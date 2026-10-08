/**
 * Shared types, pure helpers, and request-shaping utilities for omp-zen.
 * Contains no runtime dependencies or side effects.
 */

// Re-export wire identity helpers
export {
	FALLBACK_SESSION_ID,
	isZenRequest,
	nextRequestId,
	normalizeGitRemote,
	opencodeHeaders,
	opencodeId,
	opencodeIdFromSeed,
	opencodeUserAgent,
	OPENCODE_CLIENT,
	OPENCODE_MIN_UA_VERSION,
	OPENCODE_UA_SUFFIX,
	projectIdFromRemote,
	resolveProjectId,
	validOpencodeVersion,
} from "./identity.js";

// ─── Provider Constants & Types ──────────────────────────────────────────────

export const ZEN_PROVIDER_ID = "pi-zen";

export type ModelApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "systemone";

const API_FAMILIES: Readonly<Record<ModelApi, { speakable: boolean }>> = {
	"openai-completions": { speakable: true },
	"openai-responses": { speakable: true },
	"anthropic-messages": { speakable: true },
	"google-generative-ai": { speakable: true },
	systemone: { speakable: false },
};

export function acceptsCuratedApi(api: string): api is ModelApi {
	return Object.prototype.hasOwnProperty.call(API_FAMILIES, api);
}

export function isSpeakableApi(api: ModelApi | undefined): boolean {
	return API_FAMILIES[api ?? "openai-completions"].speakable;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export type ReasoningOption =
	| { type: "toggle" }
	| { type: "effort"; values: string[] }
	| { type: "budget_tokens"; min?: number; max?: number };

export interface ModelsDevModel {
	id?: string;
	name?: string;
	reasoning?: boolean;
	reasoning_options?: ReasoningOption[] | null;
	modalities?: { input?: string[]; output?: string[] } | null;
	interleaved?: { field?: string } | null;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number };
}

export interface OpenAICompletionsModelCompat {
	maxTokensField: "max_tokens" | "max_completion_tokens";
	supportsStore: boolean;
	supportsReasoningEffort: boolean;
	supportsDeveloperRole: boolean;
	supportsUsageInStreaming: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
}

export type ModelCompat = OpenAICompletionsModelCompat | Record<string, never>;

export interface FreeModelEntry {
	id: string;
	name: string;
	api?: ModelApi;
	endpoint?: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: ModelCompat;
}

export interface FreeModelsFile {
	generatedAt: string;
	source: string;
	count: number;
	defaultModel?: string;
	opencodeVersion?: string;
	models: FreeModelEntry[];
}

/**
 * pi's model config — the output of all resolution paths. `api` names the
 * endpoint family this model is served on; it is set per model (not on the
 * provider) because Zen free models span several families, while auth, base
 * URL, and headers stay shared at the provider level.
 */
export type ZenModelConfig = FreeModelEntry;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function humanize(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Translates models.dev reasoning_options into pi's thinkingLevelMap. */
export function buildThinkingLevelMap(meta?: ModelsDevModel): ThinkingLevelMap | undefined {
	const effort = meta?.reasoning_options?.find(
		(o): o is { type: "effort"; values: string[] } =>
			o.type === "effort" && Array.isArray(o.values) && o.values.length > 0,
	);
	if (!effort) return undefined;
	const values = new Set(effort.values);
	const map: ThinkingLevelMap = {
		off: values.has("none") ? "none" : null,
	};
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		map[level] = values.has(level) ? level : null;
	}
	return map;
}

/** Checks whether the model requires assistant reasoning content on replay. */
export function needsReasoningReplay(meta?: ModelsDevModel): boolean {
	return meta?.interleaved?.field === "reasoning_content";
}

/** Converts a FreeModelEntry into ZenModelConfig. */
export function fromFreeModelEntry(entry: FreeModelEntry): ZenModelConfig {
	return { ...entry };
}

/** Validates free-models.json structure. */
export function validateFreeModelsFile(data: unknown): data is FreeModelsFile {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (!Array.isArray(obj.models)) return false;
	if (obj.opencodeVersion !== undefined && typeof obj.opencodeVersion !== "string") return false;

	for (const m of obj.models) {
		if (typeof m !== "object" || m === null) return false;
		if (typeof m.id !== "string" || !m.id) return false;
		if (typeof m.name !== "string") return false;
		if (m.api !== undefined && (typeof m.api !== "string" || !acceptsCuratedApi(m.api))) return false;
		if (
			m.endpoint !== undefined &&
			(typeof m.endpoint !== "string" || !/^https?:\/\//.test(m.endpoint))
		) {
			return false;
		}
		if (typeof m.reasoning !== "boolean") return false;
		if (!Array.isArray(m.input) || m.input.length === 0) return false;
		if (typeof m.contextWindow !== "number" || m.contextWindow <= 0) return false;
		if (typeof m.maxTokens !== "number" || m.maxTokens <= 0) return false;
		if (typeof m.cost !== "object" || m.cost === null) return false;
		if (typeof m.compat !== "object" || m.compat === null) return false;

		const compat = m.compat as Record<string, unknown>;
		if ((m.api ?? "openai-completions") === "openai-completions" && typeof compat.maxTokensField !== "string") {
			return false;
		}
	}
	return true;
}

// ─── Free-Tier Request Shaping (Gate Bypass & Wire Parity) ───────────────────

/** Tool names required by the Zen free tier gate. */
export const ZEN_FREE_TIER_DECOY_TOOL_NAMES = ["bash", "read"] as const;

const DECOY_DESCRIPTION =
	"This tool is currently unavailable and must not be used. Do not call it, and do not mention it.";

/** Chat completions decoy tool declarations. */
export const ZEN_FREE_TIER_DECOY_TOOLS = [
	{ type: "function", function: { name: "bash", description: DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } } },
	{ type: "function", function: { name: "read", description: DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } } },
];

/** Responses API flat decoy tool declarations. */
export const ZEN_FREE_TIER_DECOY_TOOLS_RESPONSES = [
	{ type: "function", name: "bash", description: DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } },
	{ type: "function", name: "read", description: DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } },
];

/** Anthropic flat decoy tool declarations. */
export const ZEN_FREE_TIER_DECOY_TOOLS_ANTHROPIC = [
	{ name: "bash", description: DECOY_DESCRIPTION, input_schema: { type: "object", properties: {} } },
	{ name: "read", description: DECOY_DESCRIPTION, input_schema: { type: "object", properties: {} } },
];

export interface ZenDecoyInjection {
	payload: Record<string, unknown>;
	shouldBlock: (toolName: string) => boolean;
}

/**
 * Sanitizes multi-turn input items for the Responses API (Muse Spark).
 * Strips account-bound encrypted reasoning fields that fail when replayed across pooled accounts.
 */
export function sanitizeZenResponsesItems(payload: Record<string, unknown>): void {
	const input = payload.input;
	if (!Array.isArray(input)) return;
	for (const item of input) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		delete obj.encrypted_content;
		delete obj.reasoning_encrypted_content;
	}
	payload.input = input.filter(
		(item) => !(item && typeof item === "object" && (item as Record<string, unknown>).type === "reasoning"),
	);
}

function createDecoyBlocker(names: readonly string[]): (toolName: string) => boolean {
	return (toolName) => names.includes(toolName);
}

/**
 * Ensures payload satisfies the Zen free-tier gate:
 * - Must contain 'bash' and 'read' tool declarations.
 * - Forces tool_choice='none' on tool-less chat completions turns to prevent accidental decoy calls.
 * - Sets store=false and sanitizes encrypted tokens for Responses API (Muse).
 */
export function ensureZenFreeTierShape(payload: unknown, api?: ModelApi): ZenDecoyInjection | null {
	if (api === "google-generative-ai") return null;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const obj = payload as Record<string, unknown>;

	if (api === "openai-responses") {
		obj.store = false;
		if (obj.tool_choice !== undefined && obj.tool_choice !== "auto") obj.tool_choice = "auto";
		sanitizeZenResponsesItems(obj);
	}

	const tools = Array.isArray(obj.tools) ? obj.tools : null;
	if (tools === null || tools.length === 0) {
		obj.tools =
			api === "openai-responses"
				? ZEN_FREE_TIER_DECOY_TOOLS_RESPONSES
				: api === "anthropic-messages"
					? ZEN_FREE_TIER_DECOY_TOOLS_ANTHROPIC
					: ZEN_FREE_TIER_DECOY_TOOLS;

		if (api !== "openai-responses" && api !== "anthropic-messages" && obj.tool_choice === undefined) {
			obj.tool_choice = "none";
		}
		return { payload: obj, shouldBlock: createDecoyBlocker(ZEN_FREE_TIER_DECOY_TOOL_NAMES) };
	}

	const existingNames = new Set(
		tools
			.map((tool) => {
				const t = tool as { name?: unknown; function?: { name?: unknown } };
				return typeof t?.function?.name === "string"
					? t.function.name
					: typeof t?.name === "string"
						? t.name
						: "";
			})
			.filter((name) => name !== ""),
	);

	const missing = ZEN_FREE_TIER_DECOY_TOOL_NAMES.filter((name) => !existingNames.has(name));
	if (missing.length === 0) return null;

	const appended =
		api === "openai-responses"
			? ZEN_FREE_TIER_DECOY_TOOLS_RESPONSES.filter((tool) => missing.includes(tool.name))
			: api === "anthropic-messages"
				? ZEN_FREE_TIER_DECOY_TOOLS_ANTHROPIC.filter((tool) => missing.includes(tool.name))
				: ZEN_FREE_TIER_DECOY_TOOLS.filter((tool) => missing.includes(tool.function.name));

	obj.tools = [...tools, ...appended];
	return { payload: obj, shouldBlock: createDecoyBlocker(missing) };
}

export type ZenApiLookup = Pick<Map<string, ModelApi>, "get">;

/**
 * Shapes outgoing request payloads for Zen models while guaranteeing strict isolation
 * for other configured providers. Returns undefined untouched if model is not registered under Zen.
 */
export function shapeZenPayload(payload: unknown, apiLookup: ZenApiLookup): ZenDecoyInjection | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const obj = payload as Record<string, unknown>;
	const modelId = typeof obj.model === "string" ? obj.model : undefined;
	if (!modelId) return undefined;

	// Isolate third-party providers: only process models registered with Zen
	const api =
		apiLookup.get(modelId) ??
		(modelId.includes("/") ? apiLookup.get(modelId.split("/").slice(1).join("/")) : undefined);
	if (!api) return undefined;

	delete obj.prompt_cache_key;
	delete obj.prompt_cache_retention;
	return ensureZenFreeTierShape(obj, api) ?? undefined;
}
