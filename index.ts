import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createZenCompactionStreamFn } from "./compaction.js";
import { DEPRECATED_MODEL_REGEX, getZenFriendlyErrorMessage, type FailedAssistantMessage } from "./errors.js";
import {
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
	fromFreeModelEntry,
	isChatApi,
	shapeZenPayload,
	type ModelApi,
	type ZenModelConfig,
	type ZenShapedRequest,
} from "./shared.js";

let apiByModelId: ReadonlyMap<string, ModelApi> = new Map();
const inFlightShaping = new Map<string, ZenShapedRequest>();

function getSessionId(ctx?: ExtensionContext): string {
	let key = "";
	try {
		const sessionId = ctx?.sessionManager?.getSessionId();
		if (sessionId) key = sessionId;
	} catch {}
	return sessionIdFor(key);
}

function registerProvider(pi: ExtensionAPI, models: ZenModelConfig[]): number {
	// Exclude non-chat protocols
	const chatModels = models.filter((m) => isChatApi(m.api));
	apiByModelId = new Map(chatModels.map((m) => [m.id, m.api ?? "openai-completions"]));
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
		return {
			block: true,
			reason: "Placeholder tool added for Zen free-tier compatibility — no action needed.",
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
