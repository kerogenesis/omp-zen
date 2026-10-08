/**
 * zen-endpoints.mjs
 *
 * The single rule mapping a Zen endpoint URL to the pi api family that speaks
 * it. The build (build-free-models.mjs) applies it while scraping the docs
 * table.
 *
 * Deliberately strict: an endpoint no pattern recognizes is an error, not a
 * default. The old default (`openai-completions` for anything unknown) is what
 * let `jev-1.13-free` — a SystemOne structured-evaluation model served on
 * /zen/v1/systemone — enter the picker as a chat model that 500s on every
 * request. Failing the build names the row instead, so a new Zen route costs
 * one mapping line rather than a silently broken model.
 */

/** Endpoints in use on opencode.ai/docs/zen → the pi api family that speaks them. */
export const API_BY_ENDPOINT = [
	{ pattern: /:stream?[gG]enerateContent/, api: "google-generative-ai" },
	{ pattern: /\/responses\/?$/, api: "openai-responses" },
	{ pattern: /\/messages\/?$/, api: "anthropic-messages" },
	{ pattern: /\/chat\/completions\/?$/, api: "openai-completions" },
	{ pattern: /\/systemone\/?$/, api: "systemone" },
];

/**
 * pi api family for a Zen endpoint URL.
 *
 * @param {string} endpoint Absolute endpoint URL from the docs table.
 * @param {string} [id] Model id, for the error message.
 * @throws when no pattern matches — see the file header for why there is no
 *   fallback.
 */
export function apiForEndpoint(endpoint, id) {
	for (const { pattern, api } of API_BY_ENDPOINT) {
		if (pattern.test(endpoint ?? "")) return api;
	}
	throw new Error(
		`${id ? `${id}: ` : ""}unrecognized Zen endpoint ${JSON.stringify(endpoint)} — ` +
			`add it to API_BY_ENDPOINT in scripts/zen-endpoints.mjs with the pi api family it serves`,
	);
}
