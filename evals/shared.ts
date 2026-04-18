import { cp, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ModelChoice } from "../src/types.js";

export interface MaterializedWorkspace {
	sourceDir: string;
	workdir: string;
	cleanup(): Promise<void>;
}

const DEFAULT_MODEL = "zai/glm-5.1";

function providerFor(modelSpec: string): string {
	const splitAt = modelSpec.indexOf("/");
	return splitAt > 0 ? modelSpec.slice(0, splitAt) : modelSpec;
}

function readPiDefaultModel(): string | undefined {
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { defaultProvider?: string; defaultModel?: string };
		if (settings.defaultProvider && settings.defaultModel) {
			return `${settings.defaultProvider}/${settings.defaultModel}`;
		}
	} catch {
		// fall through
	}
	return undefined;
}

export function defaultEvalModel(): string {
	const explicit = process.env.QUEST_EVAL_MODEL?.trim();
	if (explicit) return explicit;
	return readPiDefaultModel() ?? DEFAULT_MODEL;
}

export function parseModelChoice(modelSpec: string, thinkingLevel = "high"): ModelChoice {
	const splitAt = modelSpec.indexOf("/");
	if (splitAt <= 0 || splitAt === modelSpec.length - 1) {
		throw new Error(`Invalid model spec: ${modelSpec}`);
	}
	return {
		provider: modelSpec.slice(0, splitAt),
		model: modelSpec.slice(splitAt + 1),
		thinkingLevel: thinkingLevel as ModelChoice["thinkingLevel"],
	};
}

export function requiredEnvVarsForModel(modelSpec: string): string[] {
	switch (providerFor(modelSpec)) {
		case "google":
			return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
		case "openai":
			return ["OPENAI_API_KEY"];
		case "zai":
		case "openai-codex":
			return [];
		default:
			return [];
	}
}

export function credentialsAvailableForModel(modelSpec: string): { ok: boolean; detail: string } {
	const envCandidates = requiredEnvVarsForModel(modelSpec);
	if (envCandidates.length === 0) {
		return { ok: true, detail: `No explicit credential gate required for ${modelSpec}` };
	}
	const available = envCandidates.find((name) => process.env[name]?.trim());
	return available
		? { ok: true, detail: `Credentials available for ${modelSpec} via ${available}` }
		: { ok: false, detail: `Missing one of: ${envCandidates.join(", ")}` };
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
			if (process.env.QUEST_KEEP_EVAL_WORKDIRS === "1") return;
			await rm(tempRoot, { recursive: true, force: true });
		},
	};
}
