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
export const ZEN_BASE_URL = process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1";
export const FREE_MODELS_CDN_URL = "https://cdn.jsdelivr.net/gh/kerogenesis/omp-zen@data/free-models.json";

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

interface HttpCacheValidators {
	etag?: string;
	lastModified?: string;
}

let lastKnownGoodModels: ZenModelConfig[] | null = null;
let freeModelsCache: FreeModelsCache | null = null;
let freeModelsValidators: HttpCacheValidators = {};
let freeModelsRevalidate: Promise<void> | null = null;
export let freeModelsUpdatedAt = 0;
export let currentOpencodeVersion = "1.18.31";


export function getAgentDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	const ompDir = join(homedir(), ".omp", "agent");
	if (existsSync(ompDir)) return ompDir;
	return join(homedir(), ".pi", "agent");
}

function getSnapshotPath(): string {
	return join(getAgentDir(), "cache", "pi-zen-models.json");
}

export function readSnapshot(): ZenModelConfig[] {
	try {
		const snap = JSON.parse(readFileSync(getSnapshotPath(), "utf8")) as Snapshot;
		return Array.isArray(snap?.models) ? snap.models : [];
	} catch {
		return [];
	}
}

export function readBundledSnapshot(): ZenModelConfig[] {
	try {
		const snapshotPath = join(import.meta.dirname || ".", "free-models.snapshot.json");
		const file = JSON.parse(readFileSync(snapshotPath, "utf8")) as FreeModelsFile;
		return Array.isArray(file?.models) ? file.models.map(fromFreeModelEntry) : [];
	} catch {
		return [];
	}
}

export function writeSnapshot(models: ZenModelConfig[]): void {
	try {
		try {
			const disk = JSON.parse(readFileSync(getSnapshotPath(), "utf8")) as Snapshot;
			if (
				deepEqualJson(
					disk.models.map((m) => ({ ...m, api: m.api ?? "openai-completions" })),
					models.map((m) => ({ ...m, api: m.api ?? "openai-completions" })),
				)
			) {
				return;
			}
		} catch {
			// No snapshot present yet
		}
		const dir = join(getAgentDir(), "cache");
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify({ savedAt: Date.now(), models } satisfies Snapshot);
		const tmp = join(dir, `pi-zen-models.json.${process.pid}.tmp`);
		try {
			writeFileSync(tmp, payload);
			renameSync(tmp, getSnapshotPath());
		} catch {
			try {
				writeFileSync(getSnapshotPath(), payload);
			} catch {
				// Best-effort write
			}
		}
	} catch {
		// Best-effort persistence
	}
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
	} catch {
		// No auth file or invalid format
	}
	return "";
}

export function getApiKey(): string {
	return getStoredKey() || process.env.ZEN_API_KEY || "";
}

function storeFreeModelsResponse(res: Response): void {
	freeModelsValidators = {
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
		if (freeModelsValidators.etag) headers["If-None-Match"] = freeModelsValidators.etag;
		else if (freeModelsValidators.lastModified) headers["If-Modified-Since"] = freeModelsValidators.lastModified;

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

export function knownModelsSync(): ZenModelConfig[] {
	if (lastKnownGoodModels && lastKnownGoodModels.length > 0) return lastKnownGoodModels;
	const disk = readSnapshot();
	return disk.length > 0 ? disk : readBundledSnapshot();
}

export async function resolveOrRecover(): Promise<ZenModelConfig[]> {
	try {
		const curated = await fetchFreeModelsList();
		if (curated.length > 0) {
			const configs = curated.map(fromFreeModelEntry);
			lastKnownGoodModels = configs;
			writeSnapshot(configs);
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
