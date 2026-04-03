import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	defaultQuestProfile,
	traceBundleFromPlanningSession,
	traceBundleFromWorkerRun,
} from "./trials-core.js";
import { synthesizeValidationAssertions } from "./plan-core.js";
import {
	createQuest,
	getQuestPaths,
	loadLearnedWorkflows,
	loadQuestProfile,
	loadQuestTrialState,
	saveQuest,
	trimRecentRuns,
	writeQuestTraceBundle,
	writeWorkerRun,
} from "./state.js";
import {
	executeFeatureWorker,
	executeQuestPlanner,
	executeValidationReadinessProbe,
	executeValidator,
} from "./workers.js";
import type {
	ModelChoice,
	QuestBenchmarkProvenance,
	QuestFeature,
	QuestMilestone,
	QuestPlan,
	QuestState,
	ValidationAssertion,
	ValidationReadiness,
	WorkerRunRecord,
} from "./types.js";

export interface QuestHeadlessRunInput {
	cwd: string;
	instruction: string;
	modelChoice: ModelChoice;
	profileId?: string;
	autoAccept?: boolean;
	dryRun?: boolean;
	timeoutMs?: number;
	benchmark?: Omit<QuestBenchmarkProvenance, "recordedAt" | "model">;
}

export interface QuestHeadlessRunResult {
	status: QuestState["status"] | "timeout";
	summary: string;
	questId: string;
	profileId: string;
	traceBundleIds: string[];
	validatorFindings: string[];
	timeoutReason?: string;
	artifactPaths: Record<string, string>;
	benchmark?: QuestBenchmarkProvenance;
}

export interface QuestHeadlessExecutors {
	probe: typeof executeValidationReadinessProbe;
	planner: typeof executeQuestPlanner;
	worker: typeof executeFeatureWorker;
	validator: typeof executeValidator;
}

const DEFAULT_EXECUTORS: QuestHeadlessExecutors = {
	probe: executeValidationReadinessProbe,
	planner: executeQuestPlanner,
	worker: executeFeatureWorker,
	validator: executeValidator,
};

function benchmarkContext(
	input: QuestHeadlessRunInput["benchmark"],
	modelChoice: ModelChoice,
): QuestBenchmarkProvenance | undefined {
	if (!input) return undefined;
	return {
		...input,
		recordedAt: Date.now(),
		model: `${modelChoice.provider}/${modelChoice.model}:${modelChoice.thinkingLevel}`,
	};
}

function fallbackPlan(goal: string, readiness: ValidationReadiness | null): QuestPlan {
	return {
		title: goal.slice(0, 72),
		summary: "Complete the assigned benchmark task with a minimal serial quest plan.",
		goal,
		risks: readiness
			? readiness.checks
					.filter((check) => check.status === "limited" || check.status === "unsupported")
					.map((check) => `${check.surface}: ${check.status}`)
			: [],
		environment: ["Headless benchmark execution."],
		services: [],
		validationSummary: readiness?.summary ?? "No readiness summary captured.",
		humanQaChecklist: ["Review the final repo state manually before shipping any benchmark-derived changes."],
		milestones: [
			{
				id: "m1",
				order: 1,
				title: "Complete benchmark task",
				description: "Solve the assigned task and collect validation evidence.",
				successCriteria: ["The task completes with validator confirmation."],
				status: "pending",
			},
		],
		features: [
			{
				id: "f1",
				order: 1,
				milestoneId: "m1",
				title: "Implement benchmark task",
				description: goal,
				preconditions: [],
				fulfills: ["The task completes with validator confirmation."],
				status: "pending",
				handoff: "Summarize files changed and remaining risks.",
				acceptanceCriteria: ["The task completes with validator confirmation."],
			},
		],
	};
}

function activeAssertionsForPass(
	quest: QuestState,
	milestoneId: string,
	pass: "code_review" | "user_surface",
): ValidationAssertion[] {
	const assertions = (quest.validationState?.assertions ?? []).filter((assertion) => assertion.milestoneId === milestoneId);
	if (pass === "code_review") return assertions.filter((assertion) => assertion.method !== "user_surface");
	return assertions.filter((assertion) => assertion.method === "user_surface" || assertion.method === "mixed");
}

function markAssertions(
	quest: QuestState,
	assertions: ValidationAssertion[],
	status: ValidationAssertion["status"],
	evidence: string,
): void {
	if (!quest.validationState) return;
	const ids = new Set(assertions.map((assertion) => assertion.id));
	quest.validationState.assertions = quest.validationState.assertions.map((assertion) =>
		ids.has(assertion.id)
			? {
					...assertion,
					status,
					evidence: evidence ? [...assertion.evidence, evidence].slice(-8) : assertion.evidence,
				}
			: assertion,
	);
	quest.validationState.updatedAt = Date.now();
}

function currentMilestoneFeatures(quest: QuestState, milestoneId: string): QuestFeature[] {
	return (quest.plan?.features ?? [])
		.filter((feature) => feature.milestoneId === milestoneId)
		.sort((left, right) => left.order - right.order);
}

function currentMilestones(quest: QuestState): QuestMilestone[] {
	return [...(quest.plan?.milestones ?? [])].sort((left, right) => left.order - right.order);
}

function nextSummary(status: QuestHeadlessRunResult["status"], quest: QuestState, validatorFindings: string[]): string {
	switch (status) {
		case "proposal_ready":
			return "Quest proposal is ready for review.";
		case "running":
			return "Quest is still running.";
		case "blocked":
			return quest.lastError ?? validatorFindings[0] ?? "Quest blocked during benchmark execution.";
		case "completed":
			return "Quest completed with explicit human QA still pending.";
		case "timeout":
			return "Quest timed out before completion.";
		default:
			return quest.lastSummary ?? "Quest run finished.";
	}
}

function resultArtifactPaths(quest: QuestState, resultFile: string): Record<string, string> {
	const paths = getQuestPaths(quest.cwd, quest.id);
	return {
		quest: paths.questFile,
		proposal: paths.proposalFile,
		validationReadiness: paths.validationReadinessFile,
		validationState: paths.validationStateFile,
		features: paths.featuresFile,
		services: paths.servicesFile,
		result: resultFile,
	};
}

async function persistResultFile(quest: QuestState, payload: QuestHeadlessRunResult): Promise<string> {
	const paths = getQuestPaths(quest.cwd, quest.id);
	await mkdir(paths.questDir, { recursive: true });
	const file = join(paths.questDir, "headless-run.json");
	await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	return file;
}

export async function runQuestHeadless(
	input: QuestHeadlessRunInput,
	executors: QuestHeadlessExecutors = DEFAULT_EXECUTORS,
): Promise<QuestHeadlessRunResult> {
	const autoAccept = input.autoAccept !== false;
	const benchmark = benchmarkContext(input.benchmark, input.modelChoice);
	const trialState = await loadQuestTrialState(input.cwd, { ensure: true });
	const profile =
		(await loadQuestProfile(input.cwd, input.profileId ?? trialState.activeProfileId, {
			ensure: true,
			target: trialState.target,
		})) ?? defaultQuestProfile(trialState.projectId, trialState.target);
	const workflows = await loadLearnedWorkflows(input.cwd);
	const quest = await createQuest(input.cwd, input.instruction, input.modelChoice);
	quest.roleModels = {
		orchestrator: input.modelChoice,
		worker: input.modelChoice,
		validator: input.modelChoice,
	};

	const traceBundleIds: string[] = [];
	const validatorFindings: string[] = [];
	const startedAt = Date.now();

	let readiness: ValidationReadiness | null = null;
	if (!input.dryRun) {
		const probe = await executors.probe(input.cwd, input.modelChoice, profile, benchmark);
		readiness = probe.readiness;
		quest.validationReadiness = probe.readiness ?? quest.validationReadiness;
		if (probe.servicesYaml) quest.servicesYaml = probe.servicesYaml;
		quest.recentRuns = trimRecentRuns([probe.run, ...quest.recentRuns]);
		await writeWorkerRun(quest.cwd, quest.id, probe.run);
		const trace = traceBundleFromWorkerRun(quest, probe.run, profile);
		traceBundleIds.push(trace.id);
		await writeQuestTraceBundle(quest.cwd, trace);
	}

	let plan = fallbackPlan(input.instruction, readiness);
	if (!input.dryRun) {
		const planningStartedAt = Date.now();
		const planned = await executors.planner(input.cwd, input.instruction, input.modelChoice, readiness, profile, benchmark);
		quest.recentRuns = trimRecentRuns([planned.run, ...quest.recentRuns]);
		await writeWorkerRun(quest.cwd, quest.id, planned.run);
		const planningTrace = traceBundleFromPlanningSession(
			quest,
			planned.run.events,
			input.modelChoice,
			profile,
			planned.run.summary,
			planned.run.ok,
			planningStartedAt,
			Date.now(),
			planned.run.latestAssistantText,
			benchmark ? { ...benchmark, passed: planned.run.ok } : undefined,
		);
		traceBundleIds.push(planningTrace.id);
		await writeQuestTraceBundle(quest.cwd, planningTrace);
		if (planned.plan) plan = planned.plan;
	}

	quest.plan = plan;
	quest.planHash = createHash("sha1").update(JSON.stringify(plan)).digest("hex");
	quest.validationState = {
		assertions: synthesizeValidationAssertions(plan.milestones, plan.features),
		updatedAt: Date.now(),
	};
	quest.status = "proposal_ready";
	quest.lastSummary = "Headless quest proposal prepared.";
	await saveQuest(quest);

	if (!autoAccept || input.dryRun) {
		const preliminary: QuestHeadlessRunResult = {
			status: quest.status,
			summary: nextSummary(quest.status, quest, validatorFindings),
			questId: quest.id,
			profileId: profile.id,
			traceBundleIds,
			validatorFindings,
			artifactPaths: {},
			benchmark: benchmark ? { ...benchmark, passed: false } : undefined,
		};
		const resultFile = await persistResultFile(quest, preliminary);
		preliminary.artifactPaths = resultArtifactPaths(quest, resultFile);
		await writeFile(resultFile, `${JSON.stringify(preliminary, null, 2)}\n`, "utf-8");
		return preliminary;
	}

	quest.status = "running";
	quest.startedAt = Date.now();
	await saveQuest(quest);

	const deadline = input.timeoutMs ? startedAt + input.timeoutMs : undefined;

	for (const milestone of currentMilestones(quest)) {
		if (deadline && Date.now() > deadline) {
			const timeoutResult: QuestHeadlessRunResult = {
				status: "timeout",
				summary: nextSummary("timeout", quest, validatorFindings),
				questId: quest.id,
				profileId: profile.id,
				traceBundleIds,
				validatorFindings,
				timeoutReason: `Exceeded ${input.timeoutMs}ms before finishing the quest.`,
				artifactPaths: {},
				benchmark: benchmark ? { ...benchmark, passed: false } : undefined,
			};
			const resultFile = await persistResultFile(quest, timeoutResult);
			timeoutResult.artifactPaths = resultArtifactPaths(quest, resultFile);
			await writeFile(resultFile, `${JSON.stringify(timeoutResult, null, 2)}\n`, "utf-8");
			return timeoutResult;
		}

		milestone.status = "running";
		await saveQuest(quest);
		for (const feature of currentMilestoneFeatures(quest, milestone.id)) {
			if (feature.status === "completed") continue;
			feature.status = "running";
			await saveQuest(quest);
			const run = await executors.worker(quest, feature, milestone, input.modelChoice, workflows, profile, benchmark);
			feature.lastRunSummary = run.summary;
			feature.lastError = run.ok ? undefined : run.stderr || run.summary;
			feature.status = run.ok ? "completed" : "blocked";
			quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
			await writeWorkerRun(quest.cwd, quest.id, run);
			const trace = traceBundleFromWorkerRun(quest, run, profile);
			traceBundleIds.push(trace.id);
			await writeQuestTraceBundle(quest.cwd, trace);
			if (!run.ok) {
				milestone.status = "blocked";
				quest.status = "blocked";
				quest.lastError = run.summary;
				await saveQuest(quest);
				const blockedResult: QuestHeadlessRunResult = {
					status: quest.status,
					summary: nextSummary(quest.status, quest, validatorFindings),
					questId: quest.id,
					profileId: profile.id,
					traceBundleIds,
					validatorFindings,
					artifactPaths: {},
					benchmark: benchmark ? { ...benchmark, passed: false } : undefined,
				};
				const resultFile = await persistResultFile(quest, blockedResult);
				blockedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
				await writeFile(resultFile, `${JSON.stringify(blockedResult, null, 2)}\n`, "utf-8");
				return blockedResult;
			}
		}

		const milestoneFeatures = currentMilestoneFeatures(quest, milestone.id);
		for (const pass of ["code_review", "user_surface"] as const) {
			const validationRun = await executors.validator(
				quest,
				milestone,
				milestoneFeatures,
				input.modelChoice,
				workflows,
				pass,
				profile,
				benchmark,
			);
			quest.recentRuns = trimRecentRuns([validationRun, ...quest.recentRuns]);
			validatorFindings.push(...(validationRun.issues ?? []));
			await writeWorkerRun(quest.cwd, quest.id, validationRun);
			const trace = traceBundleFromWorkerRun(quest, validationRun, profile);
			traceBundleIds.push(trace.id);
			await writeQuestTraceBundle(quest.cwd, trace);
			const assertions = activeAssertionsForPass(quest, milestone.id, pass);
			if (validationRun.ok && (validationRun.issues?.length ?? 0) === 0) {
				markAssertions(quest, assertions, "passed", validationRun.summary);
				await saveQuest(quest);
				continue;
			}
			markAssertions(quest, assertions, "failed", validationRun.summary);
			milestone.status = "blocked";
			quest.status = "blocked";
			quest.lastError = validationRun.summary;
			await saveQuest(quest);
			const blockedResult: QuestHeadlessRunResult = {
				status: quest.status,
				summary: nextSummary(quest.status, quest, validatorFindings),
				questId: quest.id,
				profileId: profile.id,
				traceBundleIds,
				validatorFindings,
				artifactPaths: {},
				benchmark: benchmark ? { ...benchmark, passed: false } : undefined,
			};
			const resultFile = await persistResultFile(quest, blockedResult);
			blockedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
			await writeFile(resultFile, `${JSON.stringify(blockedResult, null, 2)}\n`, "utf-8");
			return blockedResult;
		}

		milestone.status = "completed";
		await saveQuest(quest);
	}

	quest.status = "completed";
	quest.humanQaStatus = "pending";
	quest.shipReadiness = "validated_waiting_for_human_qa";
	quest.completedAt = Date.now();
	quest.lastSummary = "Benchmark quest completed. Human QA remains explicit before any release claims or shipping.";
	await saveQuest(quest);

	const completedResult: QuestHeadlessRunResult = {
		status: quest.status,
		summary: nextSummary(quest.status, quest, validatorFindings),
		questId: quest.id,
		profileId: profile.id,
		traceBundleIds,
		validatorFindings,
		artifactPaths: {},
		benchmark: benchmark ? { ...benchmark, passed: true } : undefined,
	};
	const resultFile = await persistResultFile(quest, completedResult);
	completedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
	await writeFile(resultFile, `${JSON.stringify(completedResult, null, 2)}\n`, "utf-8");
	return completedResult;
}
