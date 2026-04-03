import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	applyQuestProfilePatch,
	candidateWins,
	chooseHeuristicCandidate,
	defaultQuestProfile,
	evaluateQuestDataset,
	gradeTraceBundle,
	mergeTraceReplayCases,
	normalizeQuestProfile,
	replayDatasetIdForBenchmark,
	seedQuestDatasets,
	selectHeldOutCaseIds,
	selectInterestingTraces,
	selectSpotCheckCaseIds,
	summarizeExperimentScores,
} from "./trials-core.js";
import { runEvalSuite } from "./evals-core.js";
import {
	listQuestEvalDatasets,
	listQuestExperiments,
	listQuestTraceBundles,
	loadQuestEvalDataset,
	loadQuestTrialState,
	loadQuestProfile,
	saveQuestBaselineProfile,
	saveQuestEvalDataset,
	saveQuestExperiment,
	saveQuestTrialReport,
	saveQuestTrialState,
	saveQuestProfile,
} from "./state.js";
import { executeTrialCandidateAgent } from "./workers.js";
import type {
	ModelChoice,
	QuestEvalDataset,
	QuestExperiment,
	QuestExperimentCandidate,
	QuestExperimentScore,
	QuestProfile,
	QuestTraceBundle,
	LiveRunSnapshot,
	QuestTrialState,
} from "./types.js";

export interface QuestTrialsSnapshot {
	state: QuestTrialState;
	profile: QuestProfile;
	traces: QuestTraceBundle[];
	datasets: QuestEvalDataset[];
	experiments: QuestExperiment[];
}

function scoreDatasets(datasets: QuestEvalDataset[], profile: QuestProfile, caseIds?: string[]): QuestExperimentScore[] {
	return datasets
		.map((dataset) => evaluateQuestDataset(profile, dataset, caseIds))
		.filter((score) => score.maxScore > 0);
}

function packageRepoEvalEligible(cwd: string): boolean {
	const file = join(cwd, "package.json");
	if (!existsSync(file)) return false;
	return true;
}

async function packageEvalScores(cwd: string): Promise<QuestExperimentScore[]> {
	if (!packageRepoEvalEligible(cwd)) return [];
	try {
		const pkgRaw = await readFile(join(cwd, "package.json"), "utf-8");
		if (!pkgRaw.includes("\"@m-mohamed/pi-quests\"")) return [];
		const regression = await runEvalSuite("regression");
		const capability = await runEvalSuite("capability");
		const offlineCore = await runEvalSuite("offline-core");
		return [
			{
				datasetId: "package-regression",
				caseIds: regression.results.map((item) => item.id),
				passed: regression.passed,
				failed: regression.failed,
				score: regression.score,
				maxScore: regression.maxScore,
				findings: regression.results.filter((item) => !item.passed).map((item) => `${item.id}: ${item.summary}`),
			},
			{
				datasetId: "package-capability",
				caseIds: capability.results.map((item) => item.id),
				passed: capability.passed,
				failed: capability.failed,
				score: capability.score,
				maxScore: capability.maxScore,
				findings: capability.results.filter((item) => !item.passed).map((item) => `${item.id}: ${item.summary}`),
			},
			{
				datasetId: "package-offline-core",
				caseIds: offlineCore.results.map((item) => item.id),
				passed: offlineCore.passed,
				failed: offlineCore.failed,
				score: offlineCore.score,
				maxScore: offlineCore.maxScore,
				findings: offlineCore.results.filter((item) => !item.passed).map((item) => `${item.id}: ${item.summary}`),
			},
		];
	} catch {
		return [];
	}
}

async function ensureDatasets(cwd: string, profile: QuestProfile, traces: QuestTraceBundle[]): Promise<QuestEvalDataset[]> {
	let datasets = await listQuestEvalDatasets(cwd);
	if (datasets.length === 0) {
		datasets = seedQuestDatasets(profile.projectId, traces);
		for (const dataset of datasets) await saveQuestEvalDataset(cwd, dataset);
		return datasets;
	}
	const replayDatasets = datasets.filter((dataset) => dataset.kind.endsWith("replays"));
	for (const replayDataset of replayDatasets) {
		const next = mergeTraceReplayCases(replayDataset, traces);
		if (next.cases.length !== replayDataset.cases.length) {
			await saveQuestEvalDataset(cwd, next);
			datasets = datasets.map((dataset) => (dataset.id === next.id ? next : dataset));
		}
	}
	return datasets;
}

export async function loadQuestTrialsSnapshot(cwd: string, ensure = false): Promise<QuestTrialsSnapshot> {
	const state = await loadQuestTrialState(cwd, { ensure });
	const profile = normalizeQuestProfile(await loadQuestProfile(cwd, state.activeProfileId, { ensure, target: state.target }), state.projectId, state.target);
	const traces = await listQuestTraceBundles(cwd);
	const datasets = await ensureDatasets(cwd, profile, traces);
	const experiments = await listQuestExperiments(cwd);
	return {
		state,
		profile,
		traces,
		datasets,
		experiments,
	};
}

export async function replayQuestRunIntoTrialDataset(cwd: string, runId: string): Promise<QuestEvalDataset | null> {
	const snapshot = await loadQuestTrialsSnapshot(cwd, true);
	const matchingTrace = snapshot.traces.find((trace) => trace.runId === runId || trace.id === runId);
	if (!matchingTrace) return null;
	const dataset =
		(await loadQuestEvalDataset(cwd, replayDatasetIdForBenchmark(snapshot.profile.projectId, matchingTrace.benchmark?.benchmark))) ??
		seedQuestDatasets(snapshot.profile.projectId, snapshot.traces).find(
			(item) => item.id === replayDatasetIdForBenchmark(snapshot.profile.projectId, matchingTrace.benchmark?.benchmark),
		) ??
		null;
	if (!dataset) return null;
	const merged = mergeTraceReplayCases(dataset, [matchingTrace]);
	await saveQuestEvalDataset(cwd, merged);
	return merged;
}

function traceSummary(trace: QuestTraceBundle): string {
	return `[${trace.role}] ${trace.summary} · tags=${trace.tags.join(",") || "none"} · surface=${trace.promptSurfaceId}`;
}

function buildExperimentReport(
	profile: QuestProfile,
	candidateProfile: QuestProfile | null,
	traces: QuestTraceBundle[],
	baselineScores: QuestExperimentScore[],
	candidateScores: QuestExperimentScore[],
	packageScores: QuestExperimentScore[],
	candidate: QuestExperimentCandidate | null,
) {
	return {
		generatedAt: new Date().toISOString(),
		profileId: profile.id,
		baselineProfile: profile,
		candidateProfile,
		tracesAnalyzed: traces.map((trace) => ({
			id: trace.id,
			summary: trace.summary,
			tags: trace.tags,
			grade: gradeTraceBundle(trace, profile),
		})),
		baselineScores,
		candidateScores,
		packageScores,
		candidate,
	};
}

export async function runQuestTrialsLoop(
	cwd: string,
	modelChoice: ModelChoice,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ snapshot: QuestTrialsSnapshot; experiment: QuestExperiment | null; summary: string }> {
	const snapshot = await loadQuestTrialsSnapshot(cwd, true);
	const traces = selectInterestingTraces(snapshot.traces, snapshot.profile);
	const datasets = snapshot.datasets;
	const baselineScores = scoreDatasets(datasets, snapshot.profile);
	const datasetFindings = baselineScores.flatMap((score) => score.findings).slice(0, 12);

	let candidate = chooseHeuristicCandidate(snapshot.profile, traces, datasets);
	const agentCandidateRun = await executeTrialCandidateAgent(
		cwd,
		modelChoice,
		snapshot.profile,
		snapshot.state.target,
		traces.map(traceSummary).slice(0, 8),
		datasetFindings,
		undefined,
		onSnapshot,
		onProcessStart,
	);
	if (agentCandidateRun.candidate) candidate = agentCandidateRun.candidate;

	if (!candidate) {
		snapshot.state.status = "blocked";
		snapshot.state.lastSummary = "Trials could not derive a candidate from the current traces and datasets.";
		await saveQuestTrialState(cwd, snapshot.state);
		return { snapshot, experiment: null, summary: snapshot.state.lastSummary };
	}

	const experimentId = randomUUID();
	const spotCheckCaseIds = selectSpotCheckCaseIds(datasets, candidate);
	const heldOutCaseIds = selectHeldOutCaseIds(datasets);
	const candidateProfile = applyQuestProfilePatch(snapshot.profile, candidate.patch);
	const baselineSpotScores = scoreDatasets(datasets, snapshot.profile, spotCheckCaseIds);
	const candidateSpotScores = scoreDatasets(datasets, candidateProfile, spotCheckCaseIds);

	let experiment: QuestExperiment = {
		id: experimentId,
		projectId: snapshot.profile.projectId,
		target: snapshot.state.target,
		profileId: snapshot.profile.id,
		state: "running",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		baselineScores: baselineSpotScores,
		candidateScores: candidateSpotScores,
		spotCheckCaseIds,
		heldOutCaseIds,
		tracesAnalyzed: traces.map((trace) => trace.id),
		candidate,
		summary: `Trials evaluating candidate: ${candidate.summary}`,
	};
	await saveQuestExperiment(cwd, experiment);
	snapshot.state.status = "running";
	snapshot.state.activeExperimentId = experiment.id;
	snapshot.state.lastSummary = experiment.summary;
	await saveQuestTrialState(cwd, snapshot.state);

	if (!candidateWins(baselineSpotScores, candidateSpotScores)) {
		const reportFile = await saveQuestTrialReport(
			cwd,
			experiment.id,
			buildExperimentReport(snapshot.profile, candidateProfile, traces, baselineSpotScores, candidateSpotScores, [], candidate),
		);
		experiment = {
			...experiment,
			state: "rejected",
			summary: "Trials rejected the candidate after spot-check evals.",
			reportFile,
		};
		await saveQuestExperiment(cwd, experiment);
		snapshot.state.status = "stopped";
		snapshot.state.activeExperimentId = undefined;
		snapshot.state.lastSummary = experiment.summary;
		await saveQuestTrialState(cwd, snapshot.state);
		return { snapshot: await loadQuestTrialsSnapshot(cwd, true), experiment, summary: experiment.summary };
	}

	const fullBaselineScores = scoreDatasets(datasets, snapshot.profile);
	const fullCandidateScores = scoreDatasets(datasets, candidateProfile);
	const heldOutBaseline = scoreDatasets(datasets, snapshot.profile, heldOutCaseIds);
	const heldOutCandidate = scoreDatasets(datasets, candidateProfile, heldOutCaseIds);
	const packageScores = snapshot.state.target === "quest-core" ? await packageEvalScores(cwd) : [];
	const heldOutPass = candidateWins(heldOutBaseline, heldOutCandidate);
	const fullPass = candidateWins(fullBaselineScores, fullCandidateScores);

	if (!heldOutPass || !fullPass) {
		const reportFile = await saveQuestTrialReport(
			cwd,
			experiment.id,
			buildExperimentReport(snapshot.profile, candidateProfile, traces, fullBaselineScores, fullCandidateScores, packageScores, candidate),
		);
		experiment = {
			...experiment,
			state: "rejected",
			baselineScores: fullBaselineScores,
			candidateScores: fullCandidateScores,
			summary: heldOutPass ? "Trials rejected the candidate after full offline evals." : "Trials rejected the candidate because held-out evals regressed.",
			reportFile,
		};
		await saveQuestExperiment(cwd, experiment);
		snapshot.state.status = "stopped";
		snapshot.state.activeExperimentId = undefined;
		snapshot.state.lastSummary = experiment.summary;
		await saveQuestTrialState(cwd, snapshot.state);
		return { snapshot: await loadQuestTrialsSnapshot(cwd, true), experiment, summary: experiment.summary };
	}

	const baselineFile = await saveQuestBaselineProfile(cwd, experiment.id, snapshot.profile);
	await saveQuestProfile(cwd, candidateProfile);
	const reportFile = await saveQuestTrialReport(
		cwd,
		experiment.id,
		buildExperimentReport(snapshot.profile, candidateProfile, traces, fullBaselineScores, fullCandidateScores, packageScores, candidate),
	);
	experiment = {
		...experiment,
		state: "applied",
		baselineScores: fullBaselineScores,
		candidateScores: fullCandidateScores,
		summary: `Trials applied candidate "${candidate.summary}". ${summarizeExperimentScores(fullCandidateScores)}`,
		reportFile,
		changedArtifacts: [baselineFile, reportFile],
	};
	await saveQuestExperiment(cwd, experiment);
	snapshot.state.status = "idle";
	snapshot.state.activeExperimentId = undefined;
	snapshot.state.lastSummary = experiment.summary;
	await saveQuestTrialState(cwd, snapshot.state);
	return { snapshot: await loadQuestTrialsSnapshot(cwd, true), experiment, summary: experiment.summary };
}
