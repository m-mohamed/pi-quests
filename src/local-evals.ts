import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { availableEvalSuites, runEvalSuite, type EvalSuiteId } from "./evals-core.js";
import type {
	ModelChoice,
	QuestCandidateScorecard,
	QuestCandidateTagMetrics,
	QuestCandidateWorkItemResult,
	QuestEvalManifest,
	QuestEvalRunMode,
	QuestEvalSplit,
	QuestEvalWorkItem,
} from "./types.js";

const LOCAL_DATASET = "local@core";

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function summarizeTags(items: QuestEvalWorkItem[]): Record<string, number> {
	const summary: Record<string, number> = {};
	for (const item of items) {
		for (const tag of item.tags) summary[tag] = (summary[tag] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(summary).sort((left, right) => left[0].localeCompare(right[0])));
}

function buildTagBreakdown(results: QuestCandidateWorkItemResult[]): Record<string, QuestCandidateTagMetrics> {
	const breakdown = new Map<string, { itemCount: number; passed: number; totalScore: number; totalCost: number; totalDurationMs: number }>();
	for (const result of results) {
		const tags = Array.isArray(result.evalMetrics?.workItemTags) ? (result.evalMetrics.workItemTags as string[]) : [];
		for (const tag of tags) {
			const bucket = breakdown.get(tag) ?? {
				itemCount: 0,
				passed: 0,
				totalScore: 0,
				totalCost: 0,
				totalDurationMs: 0,
			};
			bucket.itemCount += 1;
			if (result.status === "passed") bucket.passed += 1;
			bucket.totalScore += result.score;
			bucket.totalCost += result.totalCost;
			bucket.totalDurationMs += result.durationMs;
			breakdown.set(tag, bucket);
		}
	}
	return Object.fromEntries(
		[...breakdown.entries()].map(([tag, metrics]) => [
			tag,
			{
				...metrics,
				meanScore: metrics.itemCount > 0 ? metrics.totalScore / metrics.itemCount : 0,
			},
		]),
	);
}

export function defaultLocalEvalDataset(): string {
	return LOCAL_DATASET;
}

export function resolveLocalEvalRunMode(dataset: string, requested?: QuestEvalRunMode): QuestEvalRunMode {
	if (requested) return requested;
	return dataset === LOCAL_DATASET ? "local" : "custom";
}

export async function discoverLocalEvalManifest(dataset = LOCAL_DATASET, runMode: QuestEvalRunMode, now = Date.now()): Promise<QuestEvalManifest> {
	const items: QuestEvalWorkItem[] = availableEvalSuites().map((suite) => ({
		id: suite,
		name: suite,
		family: "local",
		dataset,
		tags: ["local", suite],
		metadata: { suite },
	}));
	return {
		id: dataset,
		family: "local",
		dataset,
		runMode,
		createdAt: now,
		totalItems: items.length,
		source: "generated",
		sourceFingerprint: `local:${dataset}:${items.map((item) => item.id).join(",")}`,
		items,
		tagSummary: summarizeTags(items),
		notes: ["Quest-native local eval suites from src/evals-core.ts."],
	};
}

export async function runLocalEvalSplit(
	cwd: string,
	modelChoice: ModelChoice,
	split: QuestEvalSplit,
	candidateId: string,
): Promise<QuestCandidateScorecard> {
	const results: QuestCandidateWorkItemResult[] = [];
	for (const item of split.items) {
		const suite = item.id as EvalSuiteId;
		const suiteDir = join(cwd, ".pi", "quests", "trials", "candidates", candidateId, "evals", split.split, item.id);
		await mkdir(suiteDir, { recursive: true });
		const startedAt = Date.now();
		const suiteResult = await runEvalSuite(suite);
		const durationMs = Date.now() - startedAt;
		const resultFile = join(suiteDir, "result.json");
		await writeFile(resultFile, jsonWithNewline(suiteResult), "utf-8");
		results.push({
			itemId: item.id,
			itemName: item.name,
			family: split.family,
			dataset: split.dataset,
			split: split.split,
			status: suiteResult.failed === 0 ? "passed" : "failed",
			score: suiteResult.score,
			maxScore: suiteResult.maxScore,
			durationMs,
			totalCost: 0,
			modelChoice: `${modelChoice.provider}/${modelChoice.model}:${modelChoice.thinkingLevel}`,
			artifactPaths: [resultFile],
			evalMetrics: {
				suite,
				passedSuites: suiteResult.passed,
				failedSuites: suiteResult.failed,
				workItemTags: item.tags,
			},
			evaluation: {
				name: "local",
				dataset: split.dataset,
				taskId: item.id,
				runMode: split.dataset === LOCAL_DATASET ? "local" : "custom",
				adapterVersion: "local-evals-v1",
				recordedAt: Date.now(),
				model: `${modelChoice.provider}/${modelChoice.model}:${modelChoice.thinkingLevel}`,
				passed: suiteResult.failed === 0,
				score: suiteResult.score,
			},
		});
	}

	const totalScore = results.reduce((total, result) => total + result.score, 0);
	const maxScore = results.reduce((total, result) => total + result.maxScore, 0);
	const totalCost = results.reduce((total, result) => total + result.totalCost, 0);
	const totalDurationMs = results.reduce((total, result) => total + result.durationMs, 0);
	const passed = results.filter((result) => result.status === "passed").length;
	const failed = results.length - passed;
	return {
		family: split.family,
		split: split.split,
		dataset: split.dataset,
		generatedAt: Date.now(),
		itemCount: results.length,
		passed,
		failed,
		totalScore,
		maxScore,
		meanScore: results.length > 0 ? totalScore / results.length : 0,
		totalCost,
		totalDurationMs,
		tagBreakdown: buildTagBreakdown(results),
		evalMetrics: {
			suites: results.map((result) => result.itemId),
		},
		items: results,
	};
}
