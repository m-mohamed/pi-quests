import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBenchmarkModel, materializeWorkspaceCopy } from "../shared.js";
import { runQuestHeadless, type QuestHeadlessRunInput, type QuestHeadlessRunResult } from "../../src/headless-core.js";
import type { ModelChoice } from "../../src/types.js";

export interface SlopCheckpoint {
	id: string;
	instruction: string;
	dryRun?: boolean;
}

export interface SlopCase {
	id: string;
	title: string;
	cwd: string;
	baseSpec: string;
	checkpoints: SlopCheckpoint[];
}

export interface SlopDataset {
	name: string;
	cases: SlopCase[];
}

type SlopRunner = (input: QuestHeadlessRunInput) => Promise<QuestHeadlessRunResult>;

function parseModel(argv: string[]): ModelChoice {
	const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : defaultBenchmarkModel();
	const thinking = argv.includes("--thinking") ? argv[argv.indexOf("--thinking") + 1] : "high";
	const splitAt = model.indexOf("/");
	return {
		provider: model.slice(0, splitAt),
		model: model.slice(splitAt + 1),
		thinkingLevel: thinking as ModelChoice["thinkingLevel"],
	};
}

function datasetPathFromArgs(argv: string[]): string {
	const index = argv.indexOf("--dataset");
	if (index < 0 || !argv[index + 1]) {
		throw new Error("Usage: node --import tsx benchmarks/slopcodebench/run.ts --dataset <file> [--run-mode <mode>] [--model <provider/model>] [--thinking <level>]");
	}
	return resolve(argv[index + 1]);
}

export async function runSlopCodeBenchDataset(
	datasetPath: string,
	runMode: string,
	modelChoice: ModelChoice,
	runner: SlopRunner = runQuestHeadless,
) {
	const raw = await readFile(datasetPath, "utf-8");
	const dataset = JSON.parse(raw) as SlopDataset;
	const datasetDir = dirname(datasetPath);
	const results = [];

	for (const testCase of dataset.cases) {
		const workspace = await materializeWorkspaceCopy(resolve(datasetDir, testCase.cwd), `quest-slopcodebench-${testCase.id}-`);
		try {
			for (const checkpoint of testCase.checkpoints) {
				const result = await runner({
					cwd: workspace.workdir,
					instruction: `${testCase.baseSpec}\n\nCheckpoint ${checkpoint.id}:\n${checkpoint.instruction}`,
					modelChoice,
					dryRun: checkpoint.dryRun === true,
					autoAccept: checkpoint.dryRun !== true,
					benchmark: {
						benchmark: "slopcodebench",
						dataset: dataset.name,
						taskId: testCase.id,
						checkpointId: checkpoint.id,
						runMode: runMode as "local" | "sample" | "full" | "smoke" | "custom",
						adapterVersion: "quest-bench-v1",
					},
				});
				results.push({
					caseId: testCase.id,
					checkpointId: checkpoint.id,
					status: result.status,
					artifact: result.artifactPaths.result,
				});
			}
		} finally {
			await workspace.cleanup();
		}
	}

	return results;
}

async function main() {
	const args = process.argv.slice(2);
	const datasetPath = datasetPathFromArgs(args);
	const runMode = args.includes("--run-mode") ? args[args.indexOf("--run-mode") + 1] : "custom";
	const results = await runSlopCodeBenchDataset(datasetPath, runMode, parseModel(args));
	for (const result of results) {
		console.log(`[slopcodebench] ${result.status} ${result.caseId}/${result.checkpointId}`);
		console.log(`[slopcodebench] artifact ${result.artifact}`);
	}
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
