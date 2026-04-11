import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBenchmarkModel, materializeWorkspaceCopy } from "../shared.js";
import { runInternalQuestHeadless } from "../../src/internal-headless.js";
import type { ModelChoice } from "../../src/types.js";

interface LocalDatasetTask {
	id: string;
	title: string;
	cwd: string;
	instruction: string;
	dryRun?: boolean;
}

interface LocalDataset {
	name: string;
	tasks: LocalDatasetTask[];
}

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

function parseDatasetPath(argv: string[]): string {
	const index = argv.indexOf("--dataset");
	if (index >= 0) return resolve(argv[index + 1]);
	const root = dirname(fileURLToPath(import.meta.url));
	return resolve(root, "quest-local.json");
}

async function main() {
	const datasetPath = parseDatasetPath(process.argv.slice(2));
	const modelChoice = parseModel(process.argv.slice(2));
	const raw = await readFile(datasetPath, "utf-8");
	const dataset = JSON.parse(raw) as LocalDataset;
	const datasetDir = dirname(datasetPath);
	const results = [];

	for (const task of dataset.tasks) {
		const workspace = await materializeWorkspaceCopy(resolve(datasetDir, task.cwd), `quest-local-${task.id}-`);
		try {
			const result = await runInternalQuestHeadless({
				cwd: workspace.workdir,
				instruction: task.instruction,
				modelChoice,
				dryRun: task.dryRun === true,
				autoAccept: task.dryRun !== true,
				benchmark: {
					benchmark: "local",
					dataset: dataset.name,
					taskId: task.id,
					runMode: "local",
					adapterVersion: "quest-bench-v1",
				},
			});
			results.push({ id: task.id, title: task.title, status: result.status, artifact: result.artifactPaths.result });
		} finally {
			await workspace.cleanup();
		}
	}

	for (const result of results) {
		console.log(`[local-benchmark] ${result.status} ${result.id} - ${result.title}`);
		console.log(`[local-benchmark] artifact ${result.artifact}`);
	}
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
