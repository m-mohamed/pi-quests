import { credentialsAvailableForModel, defaultEvalModel, parseModelChoice } from "../shared.js";
import { defaultFrontiersweDataset, discoverFrontiersweManifest, resolveFrontiersweRunMode, runFrontiersweSplit } from "../../src/frontierswe-evals.js";
import type { QuestEvalWorkItem } from "../../src/types.js";

function usage(): string {
	return `Usage: node --import tsx evals/frontierswe/run.ts [--dataset <suite>] [--repo <frontier-swe checkout>] [--task-id <id>] [--limit <n>] [--model <provider/model>] [--thinking <level>] [--profile <id>] [--json]`;
}

function filterItems(items: QuestEvalWorkItem[], taskId?: string, limit?: number): QuestEvalWorkItem[] {
	let next = taskId ? items.filter((item) => item.id === taskId) : items;
	if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
		next = next.slice(0, limit);
	}
	return next;
}

async function main(argv: string[]): Promise<void> {
	const datasetIndex = argv.indexOf("--dataset");
	const repoIndex = argv.indexOf("--repo");
	const taskIdIndex = argv.indexOf("--task-id");
	const limitIndex = argv.indexOf("--limit");
	const modelIndex = argv.indexOf("--model");
	const thinkingIndex = argv.indexOf("--thinking");
	const profileIndex = argv.indexOf("--profile");
	const json = argv.includes("--json");
	const dataset = datasetIndex >= 0 ? argv[datasetIndex + 1] : defaultFrontiersweDataset();
	const repo = repoIndex >= 0 ? argv[repoIndex + 1] : undefined;
	const taskId = taskIdIndex >= 0 ? argv[taskIdIndex + 1] : undefined;
	const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : undefined;
	const model = modelIndex >= 0 ? argv[modelIndex + 1] : defaultEvalModel();
	const thinking = thinkingIndex >= 0 ? argv[thinkingIndex + 1] : dataset.includes("sample") ? "low" : "medium";
	const profileId = profileIndex >= 0 ? argv[profileIndex + 1] : "repo-active";
	if (!dataset || !model) throw new Error(usage());
	const credentials = credentialsAvailableForModel(model);
	if (!credentials.ok) {
		throw new Error(credentials.detail);
	}
	const runMode = resolveFrontiersweRunMode(dataset);
	const manifest = await discoverFrontiersweManifest({ dataset, runMode, repo });
	const items = filterItems(manifest.items, taskId, limit);
	if (items.length === 0) {
		throw new Error(taskId ? `FrontierSWE task not found: ${taskId}` : "No FrontierSWE tasks discovered.");
	}
	const scorecard = await runFrontiersweSplit({
		cwd: process.cwd(),
		modelChoice: parseModelChoice(model, thinking),
		profileId,
		split: {
			id: `${dataset}-search`,
			family: "frontierswe",
			dataset,
			split: "search",
			createdAt: Date.now(),
			seed: 42,
			sourceManifestId: manifest.id,
			sourceFingerprint: manifest.sourceFingerprint,
			totalItems: items.length,
			items,
			tagSummary: Object.fromEntries(
				[...new Set(items.flatMap((item) => item.tags))].sort().map((tag) => [tag, items.filter((item) => item.tags.includes(tag)).length]),
			),
			notes: manifest.notes,
		},
		candidateId: "manual",
		repo,
	});
	if (json) {
		console.log(JSON.stringify(scorecard, null, 2));
		return;
	}
	console.log(`FrontierSWE eval ${dataset}`);
	console.log(`Tasks: ${scorecard.itemCount}`);
	console.log(`Passed: ${scorecard.passed}/${scorecard.itemCount}`);
	console.log(`Mean score: ${scorecard.meanScore.toFixed(3)}`);
}

await main(process.argv.slice(2));
