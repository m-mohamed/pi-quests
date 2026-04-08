import { cp, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface MaterializedWorkspace {
	sourceDir: string;
	workdir: string;
	cleanup(): Promise<void>;
}

function benchmarkProvider(modelSpec: string): string {
	const splitAt = modelSpec.indexOf("/");
	return splitAt > 0 ? modelSpec.slice(0, splitAt) : modelSpec;
}

const DEFAULT_MODEL = "zai/glm-5.1";

function readPiDefaultModel(): string | undefined {
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const provider = settings.defaultProvider;
		const model = settings.defaultModel;
		if (provider && model) return `${provider}/${model}`;
	} catch {
		// Pi config not available — fall through to env var / default
	}
	return undefined;
}

export function defaultBenchmarkModel(): string {
	const explicit = process.env.QUEST_BENCH_MODEL?.trim();
	if (explicit) return explicit;
	const piDefault = readPiDefaultModel();
	if (piDefault) return piDefault;
	return DEFAULT_MODEL;
}

export function requiredEnvVarsForModel(modelSpec: string): string[] {
	switch (benchmarkProvider(modelSpec)) {
		case "google":
			return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
		case "openai":
			return ["OPENAI_API_KEY"];
		case "openai-codex":
		case "zai":
			return [];
		default:
			return [];
	}
}

export function missingEnvVarsForModel(modelSpec: string): string[] {
	const candidates = requiredEnvVarsForModel(modelSpec);
	if (candidates.length === 0) return [];
	if (candidates.some((name) => process.env[name]?.trim())) return [];
	return candidates;
}

function readPiAuth(): Record<string, any> | null {
	try {
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		return JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, any>;
	} catch {
		return null;
	}
}

export function credentialsAvailableForModel(modelSpec: string): { ok: boolean; detail: string } {
	const provider = benchmarkProvider(modelSpec);
	const envCandidates = requiredEnvVarsForModel(modelSpec);
	if (envCandidates.length > 0) {
		const available = envCandidates.find((name) => process.env[name]?.trim());
		return available
			? { ok: true, detail: `Credentials available for ${modelSpec} via ${available}` }
			: { ok: false, detail: `Missing one of: ${envCandidates.join(", ")}` };
	}

	const auth = readPiAuth();
	switch (provider) {
		case "zai":
			if (process.env.ZAI_API_KEY?.trim()) {
				return { ok: true, detail: `Credentials available for ${modelSpec} via ZAI_API_KEY` };
			}
			if (auth?.["zai"]?.key) {
				return { ok: true, detail: `Credentials available for ${modelSpec} via ~/.pi/agent/auth.json` };
			}
			return { ok: false, detail: `Missing ZAI credentials for ${modelSpec}. Set ZAI_API_KEY or sign in with Pi.` };
		case "openai-codex":
			if (process.env.OPENAI_API_KEY?.trim()) {
				return { ok: true, detail: `Credentials available for ${modelSpec} via OPENAI_API_KEY` };
			}
			if (auth?.["openai-codex"]?.access) {
				return { ok: true, detail: `Credentials available for ${modelSpec} via ~/.pi/agent/auth.json` };
			}
			return {
				ok: false,
				detail: `Missing OpenAI Codex credentials for ${modelSpec}. Set OPENAI_API_KEY or sign in with Pi.`,
			};
		default:
			return { ok: true, detail: `No explicit benchmark credential check required for ${modelSpec}` };
	}
}

export async function materializeWorkspaceCopy(sourceDir: string, prefix: string): Promise<MaterializedWorkspace> {
	const absoluteSource = resolve(sourceDir);
	const tempRoot = await mkdtemp(join(tmpdir(), prefix));
	const workdir = join(tempRoot, basename(absoluteSource));
	await cp(absoluteSource, workdir, {
		recursive: true,
		force: true,
		dereference: false,
	});
	return {
		sourceDir: absoluteSource,
		workdir,
		async cleanup() {
			if (process.env.QUEST_KEEP_BENCH_WORKDIRS === "1") return;
			await rm(tempRoot, { recursive: true, force: true });
		},
	};
}
