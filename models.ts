import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validOpencodeVersion } from "./identity.js";
import {
	fromFreeModelEntry,
	validateFreeModelsFile,
	type FreeModelEntry,
	type FreeModelsFile,
	type ModelApi,
	type ZenModelConfig,
} from "./shared.js";

export const ZEN_PROVIDER_ID = "pi-zen";
export const ZEN_PROVIDER_NAME = "OpenCode Zen (Free)";
export const ZEN_ANONYMOUS_API_KEY = "public";
export const ZEN_BASE_URL = process.env.ZEN_BASE_URL || "https://opencode.ai/inference/v1";
export const FREE_MODELS_CDN_URL = "https://cdn.jsdelivr.net/gh/kerogenesis/omp-zen@data/free-models.json";
export const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

export const FREE_MODELS_CDN_TTL_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface Snapshot {
	savedAt: number;
	models: ZenModelConfig[];
}

interface FreeModelsCache {
	expiresAt: number;
	models: FreeModelEntry[];
}

interface HttpConditionalHeaders {
	etag?: string;
	lastModified?: string;
}

let lastKnownGoodModels: ZenModelConfig[] | null = null;
let freeModelsCache: FreeModelsCache | null = null;
let freeModelsConditionalHeaders: HttpConditionalHeaders = {};
let freeModelsRevalidate: Promise<void> | null = null;
export let freeModelsUpdatedAt = 0;
export let currentOpencodeVersion = "2.0.26";


export function getAgentDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	const ompDir = join(homedir(), ".omp", "agent");
	if (existsSync(ompDir)) return ompDir;
	return join(homedir(), ".pi", "agent");
}

function getUserCachePath(): string {
	return join(getAgentDir(), "cache", "pi-zen-models.json");
}

export function readUserCache(): ZenModelConfig[] {
	try {
		const snap = JSON.parse(readFileSync(getUserCachePath(), "utf8")) as Snapshot;
		return Array.isArray(snap?.models) ? snap.models : [];
	} catch {
		return [];
	}
}

export function readBundledModels(): ZenModelConfig[] {
	try {
		const snapshotPath = join(import.meta.dirname || ".", "free-models.json");
		const file = JSON.parse(readFileSync(snapshotPath, "utf8")) as FreeModelsFile;
		return Array.isArray(file?.models) ? file.models.map(fromFreeModelEntry) : [];
	} catch {
		return [];
	}
}

export function writeUserCache(models: ZenModelConfig[]): void {
	try {
		try {
			const disk = JSON.parse(readFileSync(getUserCachePath(), "utf8")) as Snapshot;
			if (
				deepEqualJson(
					disk.models.map((m) => ({ ...m, api: m.api ?? "openai-completions" })),
					models.map((m) => ({ ...m, api: m.api ?? "openai-completions" })),
				)
			) {
				return;
			}
		} catch {
		}
		const dir = join(getAgentDir(), "cache");
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify({ savedAt: Date.now(), models } satisfies Snapshot);
		const tmp = join(dir, `pi-zen-models.json.${process.pid}.tmp`);
		try {
			writeFileSync(tmp, payload);
			renameSync(tmp, getUserCachePath());
		} catch {
			try {
				writeFileSync(getUserCachePath(), payload);
			} catch {}
		}
	} catch {}
}

export function getStoredKey(): string {
	try {
		const auth = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		const cred = auth[ZEN_PROVIDER_ID];
		if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key) {
			return cred.key;
		}
	} catch {}
	return "";
}

export function getApiKey(): string {
	return getStoredKey() || process.env.ZEN_API_KEY || "";
}

function storeFreeModelsResponse(res: Response): void {
	freeModelsConditionalHeaders = {
		etag: res.headers.get("etag") ?? undefined,
		lastModified: res.headers.get("last-modified") ?? undefined,
	};
}

export async function fetchFreeModelsList(force = false): Promise<FreeModelEntry[]> {
	if (!force && freeModelsCache) {
		if (freeModelsCache.expiresAt > Date.now()) {
			return freeModelsCache.models;
		}
		revalidateFreeModels();
		return freeModelsCache.models;
	}

	const res = await fetch(FREE_MODELS_CDN_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	storeFreeModelsResponse(res);
	const data = await res.json();
	if (!validateFreeModelsFile(data)) {
		throw new Error("Curated free-models.json failed validation");
	}
	applyFreeModels(data.models);
	if (data.opencodeVersion) currentOpencodeVersion = validOpencodeVersion(data.opencodeVersion);
	return data.models;
}

export function revalidateFreeModels(): Promise<void> {
	freeModelsRevalidate ??= (async () => {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (freeModelsConditionalHeaders.etag) headers["If-None-Match"] = freeModelsConditionalHeaders.etag;
		else if (freeModelsConditionalHeaders.lastModified) headers["If-Modified-Since"] = freeModelsConditionalHeaders.lastModified;

		try {
			const res = await fetch(FREE_MODELS_CDN_URL, {
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (res.status === 304) {
				if (freeModelsCache) freeModelsCache.expiresAt = Date.now() + FREE_MODELS_CDN_TTL_MS;
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

			storeFreeModelsResponse(res);
			const data = await res.json();
			if (!validateFreeModelsFile(data)) {
				throw new Error("Curated free-models.json failed validation");
			}
			applyFreeModels(data.models);
			if (data.opencodeVersion) currentOpencodeVersion = validOpencodeVersion(data.opencodeVersion);
		} catch {
			if (freeModelsCache) freeModelsCache.expiresAt = Date.now() + FREE_MODELS_CDN_TTL_MS;
		} finally {
			freeModelsRevalidate = null;
		}
	})();
	return freeModelsRevalidate;
}

export function applyFreeModels(models: FreeModelEntry[]): boolean {
	const changed = !deepEqualJson(freeModelsCache?.models ?? null, models);
	if (!freeModelsCache) freeModelsCache = { expiresAt: 0, models: [] };
	freeModelsCache.models = models;
	freeModelsCache.expiresAt = Date.now() + FREE_MODELS_CDN_TTL_MS;
	if (changed) freeModelsUpdatedAt = Date.now();
	return changed;
}

export function getCachedFreeModels(): FreeModelEntry[] {
	return freeModelsCache?.models ?? [];
}

export async function fetchLiveZenModelIds(): Promise<Set<string> | null> {
	try {
		const res = await fetch(ZEN_MODELS_URL, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; omp-zen/1.0)" },
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { data?: Array<{ id?: string }> };
		if (!Array.isArray(data?.data)) return null;
		return new Set(data.data.map((m) => m.id).filter(Boolean) as string[]);
	} catch {
		return null;
	}
}

export function evictModel(modelId: string): ZenModelConfig[] {
	const current = (lastKnownGoodModels && lastKnownGoodModels.length > 0 ? lastKnownGoodModels : knownModelsSync()).filter(
		(m) => m.id !== modelId,
	);
	lastKnownGoodModels = current;
	if (freeModelsCache) {
		freeModelsCache.models = freeModelsCache.models.filter((m) => m.id !== modelId);
	}
	writeUserCache(current);
	return current;
}

export function knownModelsSync(): ZenModelConfig[] {
	if (lastKnownGoodModels && lastKnownGoodModels.length > 0) return lastKnownGoodModels;
	const bundled = readBundledModels();
	const bundledIds = new Set(bundled.map((m) => m.id));
	const disk = readUserCache().filter((m) => bundledIds.has(m.id));
	return disk.length > 0 ? disk : bundled;
}

export async function resolveOrRecover(): Promise<ZenModelConfig[]> {
	try {
		const [curated, liveIds] = await Promise.all([fetchFreeModelsList(), fetchLiveZenModelIds()]);
		const filtered = liveIds ? curated.filter((m) => liveIds.has(m.id)) : curated;
		if (filtered.length > 0) {
			const configs = filtered.map(fromFreeModelEntry);
			lastKnownGoodModels = configs;
			writeUserCache(configs);
			return configs;
		}
	} catch (err) {
		console.warn(
			`[${ZEN_PROVIDER_ID}] Model resolution failed (${err instanceof Error ? err.message : String(err)}); using last-known-good`,
		);
	}
	lastKnownGoodModels = knownModelsSync();
	return lastKnownGoodModels;
}

function canonicalJsonString(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJsonString).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
	return canonicalJsonString(a) === canonicalJsonString(b);
}
