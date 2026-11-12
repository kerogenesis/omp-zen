export interface FailedAssistantMessage {
	role?: string;
	provider: string;
	model: string;
	stopReason: string;
	errorMessage?: string;
}

const QUOTA_ERROR_REGEX = /FreeUsageLimitError|GoUsageLimitError|insufficient_quota|usage limit|quota/i;
const FREE_TIER_POLICY_REGEX = /FreeTierError|free tier can only be used/i;

function formatDuration(ms: number): string {
	const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${hours} h ${minutes} min`;
}

/** Extracts the reset delay Zen reports as `retry-after-ms=...` or `retry-after: ...`. */
function quotaResetHint(errorMessage: string): string | undefined {
	const ms = /retry-after-ms\s*[=:]\s*(\d+)/i.exec(errorMessage);
	const seconds = ms ? undefined : /retry-after\s*[=:]\s*(\d+)/i.exec(errorMessage);
	const waitMs = ms ? Number(ms[1]) : seconds ? Number(seconds[1]) * 1000 : undefined;
	if (!waitMs || !Number.isFinite(waitMs) || waitMs <= 0) return undefined;
	const reset = new Date(Date.now() + waitMs);
	return `This session's limit resets in ${formatDuration(waitMs)} (${reset.toLocaleString()}).`;
}

export function formatQuotaError(msg: FailedAssistantMessage, providerId: string): string | undefined {
	if (msg.stopReason !== "error" || msg.provider !== providerId) return undefined;
	if (!msg.errorMessage || !QUOTA_ERROR_REGEX.test(msg.errorMessage)) return undefined;

	const resetHint = quotaResetHint(msg.errorMessage);
	return [
		`Free usage limit reached for "${msg.model}" on OpenCode Zen.`,
		"",
		"OpenCode's free tier enforces the limit per session: once a session uses up",
		"its free allowance, every request from that session returns 429 until the",
		"limit resets, even though other sessions still work. This is not your API",
		"key or account.",
		"",
		...(resetHint ? [resetHint, ""] : []),
		"Options:",
		"1. Continue in a new session - each session gets its own free allowance",
		`2. Run /login ${providerId} to use your own API key from https://opencode.ai/zen`,
		"3. Subscribe to OpenCode Go (https://opencode.ai/go) or add paid credits",
	].join("\n");
}

export function formatFreeTierError(msg: FailedAssistantMessage, providerId: string): string | undefined {
	if (msg.stopReason !== "error" || msg.provider !== providerId) return undefined;
	if (!msg.errorMessage || !FREE_TIER_POLICY_REGEX.test(msg.errorMessage)) return undefined;

	return [
		`OpenCode Zen rejected request for "${msg.model}" (403 FreeTierError).`,
		"",
		"The free service is currently rejecting the client integration (this is a gate refusal, not your quota or key).",
		"",
		"Options:",
		`1. Use another model for now (/model)`,
		`2. Run /login ${providerId} with a personal API key from https://opencode.ai/zen`,
	].join("\n");
}
export const DEPRECATED_MODEL_REGEX = /ModelDeprecated|has been deprecated/i;

export function formatModelDeprecatedError(msg: FailedAssistantMessage, providerId: string): string | undefined {
	if (msg.stopReason !== "error" || msg.provider !== providerId) return undefined;
	if (!msg.errorMessage || !DEPRECATED_MODEL_REGEX.test(msg.errorMessage)) return undefined;

	return `Model "${msg.model}" has been deprecated on OpenCode Zen and was removed from the available models list. Please select another model (/model).`;
}

export function getZenFriendlyErrorMessage(msg: FailedAssistantMessage, providerId: string): string | undefined {
	return formatModelDeprecatedError(msg, providerId) ?? formatFreeTierError(msg, providerId) ?? formatQuotaError(msg, providerId);
}
