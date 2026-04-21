import { defaultEvalModel, parseModelChoice, resolveEvalWorkingDirectory } from "../shared.js";
import { defaultLocalEvalDataset, discoverLocalEvalManifest, resolveLocalEvalRunMode, runLocalEvalSplit } from "../../src/local-evals.js";

function usage(): string {
	return `Usage: node --import tsx evals/local/run.ts [--dataset <suite>] [--model <provider/model>] [--thinking <level>] [--json]`;
}

async function main(argv: string[]): Promise<void> {
	const datasetIndex = argv.indexOf("--dataset");
	const modelIndex = argv.indexOf("--model");
	const thinkingIndex = argv.indexOf("--thinking");
	const json = argv.includes("--json");
	const dataset = datasetIndex >= 0 ? argv[datasetIndex + 1] : defaultLocalEvalDataset();
	const model = modelIndex >= 0 ? argv[modelIndex + 1] : defaultEvalModel();
	const thinking = thinkingIndex >= 0 ? argv[thinkingIndex + 1] : "high";
	if (!dataset || !model) throw new Error(usage());
	const modelChoice = parseModelChoice(model, thinking);
	const runMode = resolveLocalEvalRunMode(dataset);
	const manifest = await discoverLocalEvalManifest(dataset, runMode);
	const cwd = resolveEvalWorkingDirectory();
	const scorecard = await runLocalEvalSplit(
		cwd,
		modelChoice,
		{
			id: `${dataset}-search`,
			family: "local",
			dataset,
			split: "search",
			createdAt: Date.now(),
			seed: 42,
			sourceManifestId: manifest.id,
			sourceFingerprint: manifest.sourceFingerprint,
			totalItems: manifest.totalItems,
			items: manifest.items,
			tagSummary: manifest.tagSummary,
			notes: manifest.notes,
		},
		"manual",
	);
	if (json) {
		console.log(JSON.stringify(scorecard, null, 2));
		return;
	}
	console.log(`Local eval ${dataset}`);
	console.log(`Passed: ${scorecard.passed}/${scorecard.itemCount}`);
	console.log(`Mean score: ${scorecard.meanScore.toFixed(3)}`);
}

await main(process.argv.slice(2));
