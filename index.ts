import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createZenCompactionStreamFn } from "./compaction.js";
import { getZenFriendlyErrorMessage, type FailedAssistantMessage } from "./errors.js";
import {
	FALLBACK_SESSION_ID,
	isZenRequest,
	nextRequestId,
	opencodeHeaders,
	opencodeIdFromSeed,
} from "./identity.js";
import {
	currentOpencodeVersion,
	freeModelsUpdatedAt,
	getApiKey,
	getCachedFreeModels,
	knownModelsSync,
	revalidateFreeModels,
	resolveOrRecover,
	writeSnapshot,
	FREE_MODELS_CDN_TTL_MS,
	ZEN_ANONYMOUS_API_KEY,
	ZEN_BASE_URL,
	ZEN_PROVIDER_ID,
	ZEN_PROVIDER_NAME,
} from "./models.js";
import { fromFreeModelEntry, isSpeakableApi, shapeZenPayload, type ModelApi, type ZenModelConfig } from "./shared.js";

let apiByModelId: ReadonlyMap<string, ModelApi> = new Map();
const inFlightDecoys = new Map<string, (toolName: string) => boolean>();

function getSessionId(ctx: ExtensionContext): string {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) return opencodeIdFromSeed("ses", sessionId);
	} catch {
		// Session manager not initialized yet
	}
	return FALLBACK_SESSION_ID;
}

function registerProvider(pi: ExtensionAPI, models: ZenModelConfig[]): number {
	// The endpoint family is per model; everything shared — baseUrl,
	// credential, headers — stays here. Provider-level `api` is the default
	// family for any model that omits one.
	//
	// Hold back families pi has no wire client for — today that is
	// `systemone` (Jev), Zen's structured-evaluation protocol on
	// /zen/v1/systemone, which answers typed questions rather than chat turns.
	// Registering it would offer a model that fails on its first request; the
	// curated list keeps its `endpoint` either way, so pi's Jev support only
	// has to flip its family to speakable in shared.ts.
	const speakable = models.filter((m) => isSpeakableApi(m.api));
	apiByModelId = new Map(speakable.map((m) => [m.id, m.api ?? "openai-completions"]));
	pi.registerProvider(ZEN_PROVIDER_ID, {
		name: ZEN_PROVIDER_NAME,
		baseUrl: ZEN_BASE_URL,
		apiKey: getApiKey() || ZEN_ANONYMOUS_API_KEY,
		authHeader: true,
		api: "openai-completions",
		headers: opencodeHeaders(currentOpencodeVersion),
		models: speakable,
	});
	return speakable.length;
}
function applyFreeModelsIfChanged(pi: ExtensionAPI, knownAt: number): boolean {
	if (freeModelsUpdatedAt === knownAt) return false;
	const configs = getCachedFreeModels().map(fromFreeModelEntry);
	if (configs.length === 0) return false;
	registerProvider(pi, configs);
	writeSnapshot(configs);
	return true;
}

/** Always register something: the resolved list, or the last-known-good. */
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
		event.headers["x-opencode-session"] = getSessionId(ctx);
		event.headers["x-opencode-request"] = nextRequestId();
	});

	pi.on("before_provider_request", (event, ctx) => {
		const shaped = shapeZenPayload(event?.payload, apiByModelId);
		const key = getSessionId(ctx);
		if (shaped) {
			inFlightDecoys.set(key, shaped.shouldBlock);
			return shaped.payload;
		}
		inFlightDecoys.delete(key);
		return event?.payload;
	});

	pi.on("tool_call", (event, ctx) => {
		const shouldBlock = inFlightDecoys.get(getSessionId(ctx));
		if (!shouldBlock || !shouldBlock(event.toolName)) return;
		return {
			block: true,
			reason: "Decoy tool added for OpenCode Zen compatibility — no action needed.",
		};
	});

	pi.on("message_end", (event) => {
		const msg = event.message as FailedAssistantMessage;
		if (msg.role !== "assistant") return;
		const friendly = getZenFriendlyErrorMessage(msg, ZEN_PROVIDER_ID);
		if (!friendly) return;
		return { message: { ...msg, errorMessage: friendly } };
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
				createZenCompactionStreamFn(getSessionId(ctx), auth.headers, apiByModelId),
			);
			return { compaction };
		} catch {
			return undefined;
		}
	});
}
