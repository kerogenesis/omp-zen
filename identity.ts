import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

export const OPENCODE_CLIENT = "cli";
export const OPENCODE_UA_CHANNEL = "latest";
export const OPENCODE_UA_VERSION = "2.0.26";
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_TIME_SHIFT = 0x1000n;

let cachedProjectId: string | null = null;

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

const sessionIds = new Map<string, string>();

export function sessionIdFor(sessionId?: string): string {
	const key = sessionId || "";
	const cached = sessionIds.get(key);
	if (cached) return cached;
	const id = opencodeId("ses", Date.now(), 0, randomBytes(14));
	sessionIds.set(key, id);
	return id;
}

export const FALLBACK_SESSION_ID = sessionIdFor("");

export function opencodeUserAgent(version?: string): string {
	return `opencode/${OPENCODE_UA_CHANNEL}/${validOpencodeVersion(version)}/${OPENCODE_CLIENT}`;
}

export function opencodeUserAgent(version?: string): string {
	return `opencode/${OPENCODE_UA_CHANNEL}/${validOpencodeVersion(version)}/${OPENCODE_UA_CLIENT}`;
}

export function validOpencodeVersion(version?: string): string {
	const m = String(version ?? "").trim().match(/^(\d+)\.\d+\.\d+/);
	if (m && Number.parseInt(m[1] ?? "", 10) >= 2) return m[0] ?? OPENCODE_UA_VERSION;
	return OPENCODE_UA_VERSION;
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

let lastRequestMs = 0;
let msRequestCounter = 0;

export function nextRequestId(): string {
	const now = Date.now();
	if (now !== lastRequestMs) {
		lastRequestMs = now;
		msRequestCounter = 0;
	}
	msRequestCounter++;
	return opencodeId("msg", now, msRequestCounter, randomBytes(14));
}

export function isZenRequest(headers: Record<string, unknown>): boolean {
	return Boolean(headers["x-opencode-project"]);
}

export function opencodeHeaders(version?: string): Record<string, string> {
	return {
		"User-Agent": opencodeUserAgent(version),
		"x-opencode-client": OPENCODE_CLIENT,
		"x-opencode-project": resolveProjectId(),
		"x-opencode-session": FALLBACK_SESSION_ID,
	};
}
