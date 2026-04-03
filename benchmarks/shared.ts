import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export function defaultBenchmarkModel(): string {
	const explicit = process.env.QUEST_BENCH_MODEL?.trim();
	if (explicit) return explicit;
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "google/gemini-2.5-flash";
	if (process.env.OPENAI_API_KEY) return "openai-codex/gpt-5.4";
	return "openai-codex/gpt-5.4";
}

export function requiredEnvVarsForModel(modelSpec: string): string[] {
	switch (benchmarkProvider(modelSpec)) {
		case "google":
			return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
		case "openai":
		case "openai-codex":
			return ["OPENAI_API_KEY"];
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
