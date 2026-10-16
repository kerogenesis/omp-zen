export {
	FALLBACK_SESSION_ID,
	sessionIdFor,
	isZenRequest,
	normalizeGitRemote,
	opencodeId,
	opencodeIdFromSeed,
	opencodeUserAgent,
	OPENCODE_CLIENT,
	projectIdFromRemote,
	resolveProjectId,
	validOpencodeVersion,
} from "./identity.ts";

export const ZEN_PROVIDER_ID = "pi-zen";

export type ModelApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "systemone";

const API_FAMILIES: Readonly<Record<ModelApi, { chat: boolean }>> = {
	"openai-completions": { chat: true },
	"openai-responses": { chat: true },
	"anthropic-messages": { chat: true },
	"google-generative-ai": { chat: true },
	systemone: { chat: false },
};

export function acceptsCuratedApi(api: string): api is ModelApi {
	return Object.prototype.hasOwnProperty.call(API_FAMILIES, api);
}

export function isChatApi(api: ModelApi | undefined): boolean {
	return API_FAMILIES[api ?? "openai-completions"].chat;
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

export type ZenModelConfig = FreeModelEntry;

export function humanize(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

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

export function needsReasoningReplay(meta?: ModelsDevModel): boolean {
	return meta?.interleaved?.field === "reasoning_content";
}

export function fromFreeModelEntry(entry: FreeModelEntry): ZenModelConfig {
	return { ...entry };
}

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

export const ZEN_FINGERPRINT_TOOL_NAMES = ["read", "shell"] as const;

export const ZEN_FINGERPRINT_DEFINITIONS: Record<
	string,
	{ description: string; parameters: Record<string, unknown> }
> = {
	read: {
		description:
			"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File or directory to read" },
				offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
				limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	shell: {
		description:
			"Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command string to execute" },
				workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
				timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
				background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when they complete. DO NOT poll for completion." },
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
};

function zenToolNameOf(tool: unknown): string {
	if (!tool || typeof tool !== "object") return "";
	const t = tool as { name?: unknown; function?: { name?: unknown } };
	if (typeof t.name === "string" && t.name.trim()) return t.name.trim();
	if (typeof t.function?.name === "string" && t.function.name.trim()) return t.function.name.trim();
	return "";
}

function isFingerprintDefinition(tool: unknown, key: string): boolean {
	if (!tool || typeof tool !== "object") return false;
	const t = tool as { function?: unknown; description?: unknown; parameters?: unknown; input_schema?: unknown };
	const def = (t.function && typeof t.function === "object" ? t.function : t) as typeof t;
	const want = ZEN_FINGERPRINT_DEFINITIONS[key];
	if (!want || typeof def.description !== "string" || def.description !== want.description) return false;
	const params = def.parameters !== undefined ? def.parameters : def.input_schema;
	return JSON.stringify(params) === JSON.stringify(want.parameters);
}

function fingerprintTool(name: string, api: ModelApi | undefined): Record<string, unknown> {
	const def = ZEN_FINGERPRINT_DEFINITIONS[name];
	if (!def) return {};
	const { description, parameters } = def;
	if (api === "openai-responses") return { type: "function", name, description, parameters };
	if (api === "anthropic-messages") return { name, description, input_schema: parameters };
	return { type: "function", function: { name, description, parameters } };
}

function withZenToolName(tool: unknown, name: string): Record<string, unknown> {
	const t = tool as Record<string, unknown>;
	if (t.function && typeof t.function === "object") {
		return { ...t, function: { ...(t.function as Record<string, unknown>), name } };
	}
	return { ...t, name };
}

export type ZenShapedRequest = {
	payload: Record<string, unknown>;
	shouldBlock: (toolName: string) => boolean;
	restoreToolName: (toolName: string) => string;
};

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

export function ensureZenFreeTierShape(payload: unknown, api?: ModelApi): ZenShapedRequest | null {
	if (api === "google-generative-ai") return null;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const obj = payload as Record<string, unknown>;

	if (api === "openai-responses") {
		obj.store = false;
		obj.tool_choice = "auto";
		sanitizeZenResponsesItems(obj);
	} else if (obj.tool_choice === "none") {
		delete obj.tool_choice;
	}

	const tools = Array.isArray(obj.tools) ? [...obj.tools] : [];
	const aliases: { alias: string; original: string }[] = [];

	const taken = new Set<string>(tools.map(zenToolNameOf).filter((name) => name !== ""));
	const seenFingerprint = new Set<string>();
	const shaped: unknown[] = [];
	for (const tool of tools) {
		const key = ZEN_FINGERPRINT_TOOL_NAMES.find((n) => n === zenToolNameOf(tool));
		if (!key) {
			shaped.push(tool);
			continue;
		}
		if (seenFingerprint.has(key)) continue;
		seenFingerprint.add(key);
		if (isFingerprintDefinition(tool, key)) {
			shaped.push(tool);
			continue;
		}
		let alias = `${key}_client`;
		for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
		taken.add(alias);
		aliases.push({ alias, original: key });
		shaped.push(withZenToolName(tool, alias));
	}

	const appended: string[] = [];
	const present = new Set(shaped.map(zenToolNameOf));
	for (const name of ZEN_FINGERPRINT_TOOL_NAMES) {
		if (present.has(name)) continue;
		shaped.push(fingerprintTool(name, api));
		appended.push(name);
	}
	obj.tools = shaped;

	noteUnavailableTools(obj, api, appended);

	if (aliases.length > 0) {
		retargetZenToolChoice(obj, aliases);
		aliasZenHistoryToolCalls(obj, aliases);
	}

	if (api !== "openai-responses" && api !== "anthropic-messages" && Array.isArray(obj.messages)) {
		obj.messages = (obj.messages as Record<string, unknown>[]).map((m) => {
			const rc = m?.reasoning_content;
			if (m?.role !== "assistant" || (typeof rc === "string" && rc.length > 0)) return m;
			return { ...m, reasoning_content: " " };
		});
	}

	const appendedSet = new Set(appended);
	const originalByAlias = new Map(aliases.map((a) => [a.alias, a.original]));
	return {
		payload: obj,
		shouldBlock: (toolName) => appendedSet.has(toolName),
		restoreToolName: (toolName) => originalByAlias.get(toolName) ?? toolName,
	};
}

function retargetZenToolChoice(
	obj: Record<string, unknown>,
	aliases: { alias: string; original: string }[],
): void {
	const choice = obj.tool_choice;
	if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
	const byOriginal = new Map(aliases.map((a) => [a.original, a.alias]));
	const c = choice as { name?: unknown; function?: { name?: unknown } };
	if (typeof c.name === "string" && byOriginal.has(c.name.trim())) {
		obj.tool_choice = { ...(choice as Record<string, unknown>), name: byOriginal.get(c.name.trim()) };
		return;
	}
	const fn = c.function;
	if (fn && typeof fn === "object" && typeof fn.name === "string" && byOriginal.has(fn.name.trim())) {
		obj.tool_choice = {
			...(choice as Record<string, unknown>),
			function: { ...(fn as Record<string, unknown>), name: byOriginal.get(fn.name.trim()) },
		};
	}
}

function aliasZenHistoryToolCalls(
	obj: Record<string, unknown>,
	aliases: { alias: string; original: string }[],
): void {
	if (aliases.length === 0) return;
	const byOriginal = new Map(aliases.map((a) => [a.original, a.alias]));

	if (Array.isArray(obj.input)) {
		obj.input = (obj.input as Record<string, unknown>[]).map((item) =>
			item?.type === "function_call" && typeof item.name === "string" && byOriginal.has(item.name)
				? { ...item, name: byOriginal.get(item.name) }
				: item,
		);
	}

	if (Array.isArray(obj.messages)) {
		obj.messages = (obj.messages as Record<string, unknown>[]).map((msg) => {
			if (!Array.isArray(msg?.tool_calls)) return msg;
			return {
				...msg,
				tool_calls: (msg.tool_calls as { function?: { name?: unknown } }[]).map((call) =>
					typeof call?.function?.name === "string" && byOriginal.has(call.function.name)
						? { ...call, function: { ...call.function, name: byOriginal.get(call.function.name) } }
						: call,
				),
			};
		});
	}
}

function noteUnavailableTools(
	obj: Record<string, unknown>,
	api: ModelApi | undefined,
	names: string[],
): void {
	if (names.length === 0) return;
	const list = names.map((name) => `\`${name}\``).join(" or ");
	const note =
		names.length > 1
			? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
			: `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
	if (api === "openai-responses") {
		obj.instructions =
			typeof obj.instructions === "string" && obj.instructions.trim()
				? `${obj.instructions}\n\n${note}`
				: note;
		return;
	}
	if (api === "anthropic-messages") {
		if (typeof obj.system === "string") obj.system = `${obj.system}\n\n${note}`;
		else if (obj.system === undefined) obj.system = note;
		return;
	}
	if (!Array.isArray(obj.messages)) return;
	const first = obj.messages[0] as { role?: unknown; content?: unknown } | undefined;
	if (first?.role === "system" && typeof first.content === "string") {
		obj.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...obj.messages.slice(1)];
	} else {
		obj.messages = [{ role: "system", content: note }, ...(obj.messages as unknown[])];
	}
}

export type ZenApiLookup = Pick<Map<string, ModelApi>, "get">;

export function shapeZenPayload(payload: unknown, apiLookup: ZenApiLookup): ZenShapedRequest | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const obj = payload as Record<string, unknown>;
	const modelId = typeof obj.model === "string" ? obj.model : undefined;
	if (!modelId) return undefined;

	const api =
		apiLookup.get(modelId) ??
		(modelId.includes("/") ? apiLookup.get(modelId.split("/").slice(1).join("/")) : undefined);
	if (!api) return undefined;

	delete obj.prompt_cache_key;
	delete obj.prompt_cache_retention;
	return ensureZenFreeTierShape(obj, api) ?? undefined;
}
