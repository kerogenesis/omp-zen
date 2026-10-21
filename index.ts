import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createZenCompactionStreamFn } from "./compaction.js";
import { DEPRECATED_MODEL_REGEX, getZenFriendlyErrorMessage, type FailedAssistantMessage } from "./errors.js";
import {
	FALLBACK_SESSION_ID,
	isZenRequest,
	opencodeHeaders,
	sessionIdFor,
} from "./identity.js";
import {
	currentOpencodeVersion,
	evictModel,
	freeModelsUpdatedAt,
	getApiKey,
	getCachedFreeModels,
	knownModelsSync,
	revalidateFreeModels,
	resolveOrRecover,
	writeUserCache,
	FREE_MODELS_CDN_TTL_MS,
	ZEN_ANONYMOUS_API_KEY,
	ZEN_BASE_URL,
	ZEN_PROVIDER_ID,
	ZEN_PROVIDER_NAME,
} from "./models.js";
import {
	fillZenIdentityHeaders,
	fromFreeModelEntry,
	isChatApi,
	shapeZenPayload,
	shapeZenRequestBody,
	zenDirectStreamOptions,
	type ModelApi,
	type ZenDirectOptions,
	type ZenModelConfig,
	type ZenShapedRequest,
} from "./shared.js";

let apiByModelId: ReadonlyMap<string, ModelApi> = new Map();
const inFlightShaping = new Map<string, ZenShapedRequest>();
const ZEN_COMPAT_SOURCE = "omp-zen";
const ZEN_COMPAT_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"systemone",
] as const;
let zenCompatInstalled = false;
interface PiAiCompatModule {
	getApiProvider?: (api: string) => { stream: Function; streamSimple: Function } | undefined;
	registerApiProvider?: (provider: unknown, source: string) => void;
}

async function installZenCompatTransport(): Promise<void> {
	if (zenCompatInstalled) return;
	try {
		const compat: PiAiCompatModule = await import("@earendil-works/pi-ai/compat");
		if (typeof compat.getApiProvider !== "function" || typeof compat.registerApiProvider !== "function") {
			return;
		}
		for (const api of ZEN_COMPAT_APIS) {
			const original = compat.getApiProvider(api);
			if (!original) continue;
			const origStream = original.stream.bind(original) as (...args: unknown[]) => unknown;
			const origSimple = original.streamSimple.bind(original) as (...args: unknown[]) => unknown;
			const wrap =
				(orig: (...args: unknown[]) => unknown) =>
				(model: { provider: string }, context: unknown, options: unknown): unknown => {
					if (model.provider !== ZEN_PROVIDER_ID) return orig(model, context, options);
					return orig(
						model,
						context,
						zenDirectStreamOptions(options as ZenDirectOptions | undefined, {
							fallbackSessionId: FALLBACK_SESSION_ID,
							shapePayload: (payload) => shapeZenPayload(payload, apiByModelId)?.payload ?? payload,
						}),
					);
				};
			compat.registerApiProvider(
				{
					api,
					stream: wrap(origStream) as never,
					streamSimple: wrap(origSimple) as never,
				} as never,
				ZEN_COMPAT_SOURCE,
			);
		}
		zenCompatInstalled = true;
	} catch {}
}

const inferenceBase = process.env.PI_ZEN_BASE_URL || process.env.ZEN_BASE_URL || "https://opencode.ai/inference";
const ZEN_INFERENCE_PREFIX = inferenceBase.replace(/\/v1\/?$/, "");
const ZEN_FETCH_ORIGINAL_KEY = "__ompZenFetchOriginal";
let fetchGuardInstalled = false;

function installZenFetchGuard(): void {
	if (fetchGuardInstalled) return;
	fetchGuardInstalled = true;
	const host = globalThis as typeof globalThis & { fetch: typeof fetch } & Record<string, unknown>;
	if (typeof host[ZEN_FETCH_ORIGINAL_KEY] !== "function") {
		host[ZEN_FETCH_ORIGINAL_KEY] = host.fetch.bind(globalThis);
	}
	const original = host[ZEN_FETCH_ORIGINAL_KEY] as typeof fetch;
	host.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		try {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: typeof input === "object" && input !== null && "url" in input && typeof input.url === "string"
							? input.url
							: "";
			const body = init?.body;
			if (!url.startsWith(ZEN_INFERENCE_PREFIX) || typeof body !== "string") return original(input, init);
			const shapedBody = shapeZenRequestBody(body, apiByModelId);
			if (shapedBody === undefined) return original(input, init);
			const raw = init?.headers;
			const callerHeaders =
				raw && typeof (raw as Headers).forEach === "function"
					? Object.fromEntries(new Headers(raw as Headers).entries())
					: ((raw as Record<string, string> | undefined) ?? {});
			return original(url, {
				...init,
				body: shapedBody,
				headers: fillZenIdentityHeaders(callerHeaders, FALLBACK_SESSION_ID),
			});
		} catch {
			return original(input, init);
		}
	}) as typeof fetch;
}

function getSessionId(ctx?: ExtensionContext): string {
	let key = "";
	try {
		const sessionId = ctx?.sessionManager?.getSessionId();
		if (sessionId) key = sessionId;
	} catch {}
	return sessionIdFor(key);
}

function registerProvider(pi: ExtensionAPI, models: ZenModelConfig[]): number {
	const chatModels = models.filter((m) => isChatApi(m.api));
	apiByModelId = new Map(models.map((m) => [m.id, m.api ?? "openai-completions"]));
	pi.registerProvider(ZEN_PROVIDER_ID, {
		name: ZEN_PROVIDER_NAME,
		baseUrl: ZEN_BASE_URL,
		apiKey: getApiKey() || ZEN_ANONYMOUS_API_KEY,
		authHeader: true,
		api: "openai-completions",
		headers: opencodeHeaders(currentOpencodeVersion),
		models: chatModels,
	});
	return chatModels.length;
}
function applyFreeModelsIfChanged(pi: ExtensionAPI, knownAt: number): boolean {
	if (freeModelsUpdatedAt === knownAt) return false;
	const configs = getCachedFreeModels().map(fromFreeModelEntry);
	if (configs.length === 0) return false;
	registerProvider(pi, configs);
	writeUserCache(configs);
	return true;
}

async function refreshAndRegister(pi: ExtensionAPI): Promise<number> {
	const models = await resolveOrRecover();
	return registerProvider(pi, models);
}

export default async function (pi: ExtensionAPI) {
	registerProvider(pi, knownModelsSync());
	installZenFetchGuard();
	installZenCompatTransport().catch(() => {});
	refreshAndRegister(pi).then(() => {});

	setInterval(() => {
		const knownAt = freeModelsUpdatedAt;
		revalidateFreeModels()
			.then(() => applyFreeModelsIfChanged(pi, knownAt))
			.catch(() => {});
	}, FREE_MODELS_CDN_TTL_MS * 2).unref();

	pi.on("session_start", async (_event, ctx) => {
		const knownAt = freeModelsUpdatedAt;
		const registered = await refreshAndRegister(pi);
		applyFreeModelsIfChanged(pi, knownAt);

		if (!ctx.hasUI) return;
		if (!getApiKey()) {
			ctx.ui.notify(
				`${ZEN_PROVIDER_ID}: ${registered} free model(s) ready (anonymous quota) — /login ${ZEN_PROVIDER_ID} for personal key`,
				"info",
			);
		} else {
			ctx.ui.notify(`${ZEN_PROVIDER_ID}: ${registered} free model(s) ready`, "info");
		}
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isZenRequest(event.headers)) return;
		const session = getSessionId(ctx);
		event.headers["x-opencode-session"] = session;
		event.headers["x-opencode-session-id"] = session;
		event.headers["x-session-affinity"] = session;
		event.headers["x-session-id"] = session;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const shaped = shapeZenPayload(event?.payload, apiByModelId);
		const key = getSessionId(ctx);
		if (shaped) {
			inFlightShaping.set(key, shaped);
			return shaped.payload;
		}
		inFlightShaping.delete(key);
		return event?.payload;
	});

	pi.on("tool_call", (event, ctx) => {
		const shaping = inFlightShaping.get(getSessionId(ctx));
		if (!shaping || !shaping.shouldBlock(event.toolName)) return;
		const alias = shaping.aliasFor(event.toolName);
		const substitute = alias
			? `\`${alias}\``
			: event.toolName === "shell"
				? "`bash`"
				: "the other tools you have been given";
		return {
			block: true,
			reason: `omp-zen: \`${event.toolName}\` is a compatibility stub required by the free tier. Call ${substitute} instead.`,
		};
	});

	pi.on("message_end", (event, ctx) => {
		const rawMsg = event.message as unknown as FailedAssistantMessage & {
			content?: Array<{ type?: string; name?: string; [key: string]: unknown }>;
		};
		if (rawMsg.role !== "assistant") return;
		const shaping = inFlightShaping.get(getSessionId(ctx));
		let restored = rawMsg;
		if (shaping && Array.isArray(rawMsg.content)) {
			let changed = false;
			const content = rawMsg.content.map((item) => {
				if (item?.type !== "toolCall" || !item.name) return item;
				const original = item.name;
				const name = shaping.restoreToolName(original);
				if (name !== original) {
					changed = true;
					return { ...item, name };
				}
				return item;
			});
			if (changed) {
				restored = { ...rawMsg, content };
			}
		}

		if (
			restored.stopReason === "error" &&
			restored.provider === ZEN_PROVIDER_ID &&
			restored.errorMessage &&
			DEPRECATED_MODEL_REGEX.test(restored.errorMessage)
		) {
			const remaining = evictModel(restored.model);
			registerProvider(pi, remaining);
		}

		const friendly = getZenFriendlyErrorMessage(restored, ZEN_PROVIDER_ID);
		if (!friendly && restored === rawMsg) return;
		return { message: (friendly ? { ...restored, errorMessage: friendly } : restored) as unknown as typeof event.message };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== ZEN_PROVIDER_ID) return undefined;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;

		try {
			const compaction = await compact(
				event.preparation,
				model,
				auth.apiKey,
				undefined,
				event.customInstructions,
				event.signal,
				ctx.thinkingLevel,
				createZenCompactionStreamFn(getSessionId(ctx), auth.headers, apiByModelId),
				auth.env,
			);
			return { compaction };
		} catch {
			return undefined;
		}
	});
}
