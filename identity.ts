import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

export const OPENCODE_CLIENT = "cli";
export const OPENCODE_UA_SUFFIX = "ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
export const OPENCODE_MIN_UA_VERSION = "1.18.31";
export const FALLBACK_SESSION_ID = "ses_f4f54dfb4ffenca2ngz8p9R1uA";

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_TIME_SHIFT = 0x1000n;

let cachedProjectId: string | null = null;
let idCounter = 0;

/** Formats 6 bytes of timestamp (12 hex chars) + 14 random base62 characters. */
function formatIdBody(timeBytes: Uint8Array, bodyBytes: Uint8Array): string {
	const time = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const body = Array.from(bodyBytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
	return time + body;
}

export function opencodeId(
	prefix: "ses" | "msg",
	timestamp: number,
	counter: number,
	random: Uint8Array,
): string {
	const current = BigInt(timestamp) * ID_TIME_SHIFT + BigInt(counter);
	const value = prefix === "ses" ? ~current : current;
	const timeBytes = Uint8Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn),
	);
	return `${prefix}_${formatIdBody(timeBytes, random.subarray(0, 14))}`;
}

export function opencodeIdFromSeed(prefix: "ses" | "msg", seed: string): string {
	const digest = createHash("sha1").update(seed).digest();
	return `${prefix}_${formatIdBody(digest.subarray(0, 6), digest.subarray(6, 20))}`;
}

export function opencodeUserAgent(version: string): string {
	return `opencode/${version} ${OPENCODE_UA_SUFFIX}`;
}

export function validOpencodeVersion(version: string): string {
	const match = String(version || "").trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
	if (!match) return OPENCODE_MIN_UA_VERSION;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	if (Number.isNaN(major) || Number.isNaN(minor) || major < 1 || (major === 1 && minor < 17)) {
		return OPENCODE_MIN_UA_VERSION;
	}
	return match[0] ?? OPENCODE_MIN_UA_VERSION;
}

export function normalizeGitRemote(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol === "file:") return undefined;
		return formatRemoteSlug(parsed.hostname, parsed.pathname);
	} catch {
		const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
		return scp && scp[2] && scp[3] ? formatRemoteSlug(scp[2], scp[3]) : undefined;
	}
}

function formatRemoteSlug(host: string, path: string): string | undefined {
	const pathname = path.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
	return host && pathname ? `${host.toLowerCase()}/${pathname}` : undefined;
}

export function projectIdFromRemote(remoteUrl: string): string | undefined {
	const normalized = normalizeGitRemote(remoteUrl);
	return normalized ? createHash("sha1").update(`git-remote:${normalized}`).digest("hex") : undefined;
}

export function resolveProjectId(): string {
	if (cachedProjectId) return cachedProjectId;
	try {
		const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		});
		cachedProjectId = projectIdFromRemote(origin) ?? "global";
	} catch {
		cachedProjectId = "global";
	}
	return cachedProjectId;
}

export function nextRequestId(): string {
	idCounter = (idCounter + 1) % 4096;
	return opencodeId("msg", Date.now(), idCounter, randomBytes(14));
}

export function isZenRequest(headers: Record<string, unknown>): boolean {
	return Boolean(headers["x-opencode-project"]);
}

export function opencodeHeaders(version: string): Record<string, string> {
	return {
		"User-Agent": opencodeUserAgent(version),
		"x-opencode-client": OPENCODE_CLIENT,
		"x-opencode-project": resolveProjectId(),
		"x-opencode-session": FALLBACK_SESSION_ID,
	};
}
