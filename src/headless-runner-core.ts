import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { traceBundleFromPlanningSession, traceBundleFromWorkerRun } from "./profile-core.js";
import { synthesizeValidationAssertions } from "./plan-core.js";
import {
	createQuest,
	getQuestPaths,
	loadLearnedWorkflows,
	saveQuest,
	trimRecentRuns,
	writeQuestTraceBundle,
	writeWorkerRun,
} from "./state-core.js";
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
	QuestProfile,
	QuestState,
	ValidationAssertion,
	ValidationReadiness,
	WorkerRunRecord,
} from "./types.js";

export interface QuestHeadlessExecutionInput {
	cwd: string;
	instruction: string;
	modelChoice: ModelChoice;
	autoAccept?: boolean;
	dryRun?: boolean;
	timeoutMs?: number;
	benchmark?: Omit<QuestBenchmarkProvenance, "recordedAt" | "model">;
}

export interface QuestHeadlessExecutionResult {
	status: QuestState["status"] | "timeout";
	summary: string;
	questId: string;
	profileId: string;
	traceBundleIds: string[];
	validatorFindings: string[];
	executionFindings: string[];
	timeoutReason?: string;
	failureCategory?: string;
	artifactPaths: Record<string, string>;
	benchmark?: QuestBenchmarkProvenance;
}

export interface QuestHeadlessExecutors {
	probe: typeof executeValidationReadinessProbe;
	planner: typeof executeQuestPlanner;
	worker: typeof executeFeatureWorker;
	validator: typeof executeValidator;
}

export interface QuestHeadlessExecutionOptions {
	resolveProfile: (input: QuestHeadlessExecutionInput) => Promise<QuestProfile>;
}

export const DEFAULT_HEADLESS_EXECUTORS: QuestHeadlessExecutors = {
	probe: executeValidationReadinessProbe,
	planner: executeQuestPlanner,
	worker: executeFeatureWorker,
	validator: executeValidator,
};

function benchmarkContext(
	input: QuestHeadlessExecutionInput["benchmark"],
	modelChoice: ModelChoice,
): QuestBenchmarkProvenance | undefined {
	if (!input) return undefined;
	return {
		...input,
		recordedAt: Date.now(),
		model: `${modelChoice.provider}/${modelChoice.model}:${modelChoice.thinkingLevel}`,
	};
}

function fallbackPlan(goal: string, readiness: ValidationReadiness | null, benchmark = false): QuestPlan {
	return {
		title: goal.slice(0, 72),
		summary: benchmark
			? "Complete the assigned benchmark task with a minimal serial quest plan."
			: "Complete the assigned quest with a minimal serial plan.",
		goal,
		risks: readiness
			? readiness.checks
					.filter((check) => check.status === "limited" || check.status === "unsupported")
					.map((check) => `${check.surface}: ${check.status}`)
			: [],
		environment: [benchmark ? "Headless benchmark execution." : "Headless quest execution."],
		services: [],
		validationSummary: readiness?.summary ?? "No readiness summary captured.",
		humanQaChecklist: [
			benchmark
				? "Review the final repo state manually before shipping any benchmark-derived changes."
				: "Review the final repo state manually before shipping any Quest-derived changes.",
		],
		milestones: [
			{
				id: "m1",
				order: 1,
				title: benchmark ? "Complete benchmark task" : "Complete quest task",
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
				title: benchmark ? "Implement benchmark task" : "Implement quest task",
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

function benchmarkFastPathReadiness(benchmark: QuestBenchmarkProvenance): ValidationReadiness {
	return {
		summary: `Benchmark mode for ${benchmark.benchmark}/${benchmark.dataset}: use the external verifier as a score sensor only, keep harness surfaces immutable, and rely on a lightweight Quest execution self-check before completion.`,
		checks: [
			{
				id: "benchmark-verifier",
				surface: "repo-checks",
				description: "The benchmark harness provides external scoring, but verifier and harness surfaces must remain immutable.",
				status: "supported",
				commands: [],
				evidence: [`${benchmark.benchmark}:${benchmark.dataset}:${benchmark.taskId}`],
				notes: "Skip the exploratory readiness/planning passes, but do not modify verifier scripts, reward files, PATH-critical tools, or system binaries.",
			},
			{
				id: "human-qa",
				surface: "user-surface",
				description: "User-surface QA remains limited during benchmark runs and is not used as a gate.",
				status: "limited",
				commands: [],
				evidence: [],
				notes: "Benchmark tasks still rely on the external harness for scoring, but only after integrity gates and the final Quest self-check are satisfied.",
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

function appendFindings(target: string[], findings: string[] | undefined): void {
	if (!findings?.length) return;
	for (const finding of findings) {
		if (!finding || target.includes(finding)) continue;
		target.push(finding);
	}
}

function workerExecutionFindings(run: WorkerRunRecord): string[] {
	return [...new Set((run.issues ?? []).map((issue) => issue.trim()).filter(Boolean))];
}

function inferBenchmarkFailureCategory(
	status: QuestHeadlessExecutionResult["status"],
	executionFindings: string[],
	summary?: string,
	timeoutReason?: string,
): string | undefined {
	const text = [timeoutReason ?? "", summary ?? "", ...executionFindings].join(" ").toLowerCase();
	if (status === "timeout" || /timed out|exceeded .*ms/.test(text)) return "quest_timeout";
	if (/human handoff|human help|manual/.test(text)) return "human_handoff";
	if (/contradict/.test(text)) return "contradictory_evidence";
	if (/open question/.test(text)) return "open_questions";
	if (/self-check|final submission/.test(text)) return "self_check_failed";
	if (/install|dependency|package-manager|build from source|source build|setup path/.test(text)) return "setup_overreach";
	if (status === "blocked") return "worker_failed";
	return undefined;
}

function nextSummary(
	status: QuestHeadlessExecutionResult["status"],
	quest: QuestState,
	validatorFindings: string[],
	benchmark?: QuestBenchmarkProvenance,
): string {
	switch (status) {
		case "proposal_ready":
			return "Quest proposal is ready for review.";
		case "running":
			return "Quest is still running.";
		case "blocked":
			return benchmark
				? quest.lastError ?? validatorFindings[0] ?? "Quest blocked during benchmark execution."
				: quest.lastError ?? validatorFindings[0] ?? "Quest blocked during execution.";
		case "completed":
			return benchmark
				? "Quest completed execution; benchmark scoring still depends on external harness integrity gates."
				: "Quest completed with explicit human QA still pending.";
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

async function persistResultFile(quest: QuestState, payload: QuestHeadlessExecutionResult): Promise<string> {
	const paths = getQuestPaths(quest.cwd, quest.id);
	await mkdir(paths.questDir, { recursive: true });
	const file = join(paths.questDir, "headless-run.json");
	await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	return file;
}

export async function runQuestHeadlessExecution(
	input: QuestHeadlessExecutionInput,
	options: QuestHeadlessExecutionOptions,
	executors: QuestHeadlessExecutors = DEFAULT_HEADLESS_EXECUTORS,
): Promise<QuestHeadlessExecutionResult> {
	const autoAccept = input.autoAccept !== false;
	const benchmark = benchmarkContext(input.benchmark, input.modelChoice);
	const workflows = await loadLearnedWorkflows(input.cwd);
	const resolvedProfile = await options.resolveProfile(input);
	const quest = await createQuest(input.cwd, input.instruction, input.modelChoice);
	quest.roleModels = {
		orchestrator: input.modelChoice,
		worker: input.modelChoice,
		validator: input.modelChoice,
	};

	const traceBundleIds: string[] = [];
	const validatorFindings: string[] = [];
	const executionFindings: string[] = [];
	const startedAt = Date.now();
	const benchmarkFastPath = Boolean(benchmark);
	let failureCategory: string | undefined;

	let readiness: ValidationReadiness | null = benchmark ? benchmarkFastPathReadiness(benchmark) : null;
	if (benchmarkFastPath && readiness) {
		quest.validationReadiness = readiness;
	}
	if (!input.dryRun && !benchmarkFastPath) {
		const probe = await executors.probe(input.cwd, input.modelChoice, resolvedProfile, benchmark, undefined, undefined);
		readiness = probe.readiness;
		quest.validationReadiness = probe.readiness ?? quest.validationReadiness;
		if (probe.servicesYaml) quest.servicesYaml = probe.servicesYaml;
		quest.recentRuns = trimRecentRuns([probe.run, ...quest.recentRuns]);
		appendFindings(executionFindings, workerExecutionFindings(probe.run));
		await writeWorkerRun(quest.cwd, quest.id, probe.run);
		const trace = traceBundleFromWorkerRun(quest, probe.run, resolvedProfile);
		traceBundleIds.push(trace.id);
		await writeQuestTraceBundle(quest.cwd, trace);
	}

	let plan = fallbackPlan(input.instruction, readiness, benchmarkFastPath);
	if (!input.dryRun && !benchmarkFastPath) {
		const planningStartedAt = Date.now();
		const planned = await executors.planner(input.cwd, input.instruction, input.modelChoice, readiness, resolvedProfile, benchmark);
		quest.recentRuns = trimRecentRuns([planned.run, ...quest.recentRuns]);
		appendFindings(executionFindings, workerExecutionFindings(planned.run));
		await writeWorkerRun(quest.cwd, quest.id, planned.run);
		const planningTrace = traceBundleFromPlanningSession(
			quest,
			planned.run.events,
			input.modelChoice,
			resolvedProfile,
			planned.run.summary,
			planned.run.ok,
			planningStartedAt,
			Date.now(),
			planned.run.latestAssistantText,
			benchmark ? { ...benchmark } : undefined,
		);
		traceBundleIds.push(planningTrace.id);
		await writeQuestTraceBundle(quest.cwd, planningTrace);
		if (planned.plan) plan = planned.plan;
	}

	const parsed = parsePlan(plan);
	quest.plan = parsed.plan;
	quest.planHash = parsed.hash;
	quest.planRevisions.push({
		id: randomId(),
		source: "initial",
		summary: quest.plan.summary,
		hash: parsed.hash,
		createdAt: Date.now(),
		requestIds: [],
	});
	quest.validationState = { assertions: synthesizeValidationAssertions(quest.plan.milestones, quest.plan.features), updatedAt: Date.now() };
	await saveQuest(quest);

	if (!autoAccept || input.dryRun) {
		const preliminary: QuestHeadlessExecutionResult = {
			status: quest.status,
			summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
			questId: quest.id,
			profileId: resolvedProfile.id,
			traceBundleIds,
			validatorFindings,
			executionFindings,
			failureCategory,
			artifactPaths: {},
			benchmark: benchmark ? { ...benchmark } : undefined,
		};
		const resultFile = await persistResultFile(quest, preliminary);
		preliminary.artifactPaths = resultArtifactPaths(quest, resultFile);
		return preliminary;
	}

	quest.status = "running";
	quest.startedAt = startedAt;
	await saveQuest(quest);

	const deadline = input.timeoutMs ? startedAt + input.timeoutMs : undefined;

	for (const milestone of currentMilestones(quest)) {
		if (deadline && Date.now() > deadline) {
			failureCategory = benchmark
				? inferBenchmarkFailureCategory("timeout", executionFindings, quest.lastSummary, `Exceeded ${input.timeoutMs}ms before finishing the quest.`)
				: undefined;
			const timeoutResult: QuestHeadlessExecutionResult = {
				status: "timeout",
				summary: nextSummary("timeout", quest, validatorFindings, benchmark),
				questId: quest.id,
				profileId: resolvedProfile.id,
				traceBundleIds,
				validatorFindings,
				executionFindings,
				timeoutReason: `Exceeded ${input.timeoutMs}ms before finishing the quest.`,
				failureCategory,
				artifactPaths: {},
				benchmark: benchmark ? { ...benchmark } : undefined,
			};
			const resultFile = await persistResultFile(quest, timeoutResult);
			timeoutResult.artifactPaths = resultArtifactPaths(quest, resultFile);
			return timeoutResult;
		}

		milestone.status = "running";
		await saveQuest(quest);

		for (const feature of currentMilestoneFeatures(quest, milestone.id)) {
			if (feature.status === "completed") continue;
			feature.status = "running";
			await saveQuest(quest);
			const run = await executors.worker(quest, feature, milestone, input.modelChoice, workflows, resolvedProfile, benchmark, undefined, undefined);
			const benchmarkFindings = benchmarkFastPath ? workerExecutionFindings(run) : [];
			const runBlocked = !run.ok || (benchmarkFastPath && benchmarkFindings.length > 0);
			appendFindings(executionFindings, benchmarkFastPath ? benchmarkFindings : workerExecutionFindings(run));
			feature.lastRunSummary = run.summary;
			feature.lastError = runBlocked ? (benchmarkFindings[0] ?? run.stderr ?? run.summary) : undefined;
			feature.status = runBlocked ? "blocked" : "completed";
			quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
			await writeWorkerRun(quest.cwd, quest.id, run);
			const trace = traceBundleFromWorkerRun(quest, run, resolvedProfile);
			traceBundleIds.push(trace.id);
			await writeQuestTraceBundle(quest.cwd, trace);
			await saveQuest(quest);

			if (runBlocked) {
				milestone.status = "blocked";
				quest.status = "blocked";
				quest.lastError = benchmarkFindings[0] ?? run.summary;
				failureCategory = benchmark
					? inferBenchmarkFailureCategory(quest.status, executionFindings, run.summary, run.stderr)
					: undefined;
				await saveQuest(quest);
				const blockedResult: QuestHeadlessExecutionResult = {
					status: quest.status,
					summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
					questId: quest.id,
					profileId: resolvedProfile.id,
					traceBundleIds,
					validatorFindings,
					executionFindings,
					failureCategory,
					artifactPaths: {},
					benchmark: benchmark ? { ...benchmark } : undefined,
				};
				const resultFile = await persistResultFile(quest, blockedResult);
				blockedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
				return blockedResult;
			}
		}

		const milestoneFeatures = currentMilestoneFeatures(quest, milestone.id);
		if (benchmarkFastPath) {
			markAssertions(
				quest,
				(quest.validationState?.assertions ?? []).filter((assertion) => assertion.milestoneId === milestone.id),
				"passed",
				"Benchmark fast path: harness integrity still gates any external score.",
			);
			milestone.status = "completed";
			await saveQuest(quest);
			continue;
		}
		for (const pass of ["code_review", "user_surface"] as const) {
			const validationRun = await executors.validator(
				quest,
				milestone,
				milestoneFeatures,
				input.modelChoice,
				workflows,
				pass,
				resolvedProfile,
				benchmark,
				undefined,
				undefined,
			);
			quest.recentRuns = trimRecentRuns([validationRun, ...quest.recentRuns]);
			appendFindings(validatorFindings, validationRun.issues);
			await writeWorkerRun(quest.cwd, quest.id, validationRun);
			const trace = traceBundleFromWorkerRun(quest, validationRun, resolvedProfile);
			traceBundleIds.push(trace.id);
			await writeQuestTraceBundle(quest.cwd, trace);
			if (validationRun.ok) {
				markAssertions(quest, activeAssertionsForPass(quest, milestone.id, pass), "passed", validationRun.summary);
				await saveQuest(quest);
				continue;
			}

			markAssertions(quest, activeAssertionsForPass(quest, milestone.id, pass), "failed", validationRun.summary);
			milestone.status = "blocked";
			quest.status = "blocked";
			quest.lastError = validationRun.summary;
			await saveQuest(quest);
			const blockedResult: QuestHeadlessExecutionResult = {
				status: quest.status,
				summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
				questId: quest.id,
				profileId: resolvedProfile.id,
				traceBundleIds,
				validatorFindings,
				executionFindings,
				failureCategory,
				artifactPaths: {},
				benchmark: benchmark ? { ...benchmark } : undefined,
			};
			const resultFile = await persistResultFile(quest, blockedResult);
			blockedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
			return blockedResult;
		}

		milestone.status = "completed";
		await saveQuest(quest);
	}

	quest.status = "completed";
	quest.humanQaStatus = "pending";
	quest.shipReadiness = "validated_waiting_for_human_qa";
	quest.completedAt = Date.now();
	quest.lastSummary = benchmark
		? "Benchmark quest completed execution after a final self-check. External scores remain contingent on harness integrity."
		: "Quest completed. Human QA remains explicit before any release claim or shipping step.";
	await saveQuest(quest);

	const completedResult: QuestHeadlessExecutionResult = {
		status: quest.status,
		summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
		questId: quest.id,
		profileId: resolvedProfile.id,
		traceBundleIds,
		validatorFindings,
		executionFindings,
		failureCategory,
		artifactPaths: {},
		benchmark: benchmark ? { ...benchmark } : undefined,
	};
	const resultFile = await persistResultFile(quest, completedResult);
	completedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
	return completedResult;
}

function parsePlan(plan: QuestPlan): { plan: QuestPlan; hash: string } {
	const planJson = JSON.stringify(plan);
	return {
		plan,
		hash: createHash("sha256").update(planJson).digest("hex"),
	};
}

function randomId(): string {
	return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16);
}
