export interface FailedAssistantMessage {
	role?: string;
	provider: string;
	model: string;
	stopReason: string;
	errorMessage?: string;
}

const QUOTA_ERROR_REGEX = /FreeUsageLimitError|GoUsageLimitError|insufficient_quota|usage limit|quota/i;
const FREE_TIER_POLICY_REGEX = /FreeTierError|free tier can only be used/i;

export function formatQuotaError(msg: FailedAssistantMessage, providerId: string): string | undefined {
	if (msg.stopReason !== "error" || msg.provider !== providerId) return undefined;
	if (!msg.errorMessage || !QUOTA_ERROR_REGEX.test(msg.errorMessage)) return undefined;

	return [
		`Free usage limit reached for "${msg.model}" on OpenCode Zen.`,
		"",
		"The anonymous free tier uses a shared per-network pool.",
		"",
		"Options:",
		`1. Wait for the reset (usually within minutes)`,
		`2. Run /login ${providerId} to configure your free personal API key`,
		"3. Add paid credits at https://opencode.ai/zen",
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

export function getZenFriendlyErrorMessage(msg: FailedAssistantMessage, providerId: string): string | undefined {
	return formatFreeTierError(msg, providerId) ?? formatQuotaError(msg, providerId);
}
