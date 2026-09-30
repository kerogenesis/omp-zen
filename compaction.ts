import {
	streamSimple,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { nextRequestId } from "./identity.js";
import { shapeZenPayload, type ZenApiLookup } from "./shared.js";

export type ZenStreamFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessageEventStream>;

/**
 * Creates a custom stream function for pi's compact() pipeline.
 * Injects required OpenCode identity headers and free-tier payload shaping.
 */
export function createZenCompactionStreamFn(
	sessionId: string,
	authHeaders: ProviderHeaders | undefined,
	apiByModelId: ZenApiLookup,
): ZenStreamFn {
	return async (model, context, options) =>
		streamSimple(model, context, {
			...options,
			headers: {
				...(authHeaders ?? {}),
				...(options?.headers ?? {}),
				"x-opencode-session": sessionId,
				"x-opencode-request": nextRequestId(),
			},
			onPayload: (payload: unknown) =>
				shapeZenPayload(payload, apiByModelId)?.payload ?? payload,
		});
}
