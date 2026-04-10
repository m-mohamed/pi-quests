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

function benchmarkExecutionFindings(run: WorkerRunRecord): string[] {
	return [...new Set((run.issues ?? []).map((issue) => issue.trim()).filter(Boolean))];
}

function inferBenchmarkFailureCategory(
	status: QuestHeadlessRunResult["status"],
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
	status: QuestHeadlessRunResult["status"],
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
			return quest.lastError ?? validatorFindings[0] ?? "Quest blocked during benchmark execution.";
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
	const executionFindings: string[] = [];
	const startedAt = Date.now();
	const benchmarkFastPath = Boolean(benchmark);
	let failureCategory: string | undefined;

	let readiness: ValidationReadiness | null = benchmark ? benchmarkFastPathReadiness(benchmark) : null;
	if (benchmarkFastPath && readiness) {
		quest.validationReadiness = readiness;
	}
	if (!input.dryRun && !benchmarkFastPath) {
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
	if (!input.dryRun && !benchmarkFastPath) {
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
				benchmark ? { ...benchmark } : undefined,
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
				summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
				questId: quest.id,
			profileId: profile.id,
			traceBundleIds,
			validatorFindings,
			executionFindings,
			failureCategory,
			artifactPaths: {},
			benchmark: benchmark ? { ...benchmark } : undefined,
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
			failureCategory = benchmark
				? inferBenchmarkFailureCategory("timeout", executionFindings, quest.lastSummary, `Exceeded ${input.timeoutMs}ms before finishing the quest.`)
				: undefined;
			const timeoutResult: QuestHeadlessRunResult = {
				status: "timeout",
				summary: nextSummary("timeout", quest, validatorFindings, benchmark),
				questId: quest.id,
				profileId: profile.id,
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
			const benchmarkFindings = benchmarkFastPath ? benchmarkExecutionFindings(run) : [];
			const runBlocked = !run.ok || (benchmarkFastPath && benchmarkFindings.length > 0);
			appendFindings(executionFindings, benchmarkFindings);
			feature.lastRunSummary = run.summary;
			feature.lastError = runBlocked ? (benchmarkFindings[0] ?? run.stderr ?? run.summary) : undefined;
			feature.status = runBlocked ? "blocked" : "completed";
			quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
			await writeWorkerRun(quest.cwd, quest.id, run);
			const trace = traceBundleFromWorkerRun(quest, run, profile);
			traceBundleIds.push(trace.id);
			await writeQuestTraceBundle(quest.cwd, trace);
			if (runBlocked) {
				milestone.status = "blocked";
				quest.status = "blocked";
				quest.lastError = benchmarkFindings[0] ?? run.summary;
				failureCategory = benchmark
					? inferBenchmarkFailureCategory(quest.status, executionFindings, run.summary, run.stderr)
					: undefined;
				await saveQuest(quest);
				const blockedResult: QuestHeadlessRunResult = {
					status: quest.status,
					summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
					questId: quest.id,
					profileId: profile.id,
					traceBundleIds,
					validatorFindings,
					executionFindings,
					failureCategory,
					artifactPaths: {},
					benchmark: benchmark ? { ...benchmark } : undefined,
				};
				const resultFile = await persistResultFile(quest, blockedResult);
				blockedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
				await writeFile(resultFile, `${JSON.stringify(blockedResult, null, 2)}\n`, "utf-8");
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
				summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
				questId: quest.id,
				profileId: profile.id,
				traceBundleIds,
				validatorFindings,
				executionFindings,
				failureCategory,
				artifactPaths: {},
				benchmark: benchmark ? { ...benchmark } : undefined,
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
	quest.lastSummary = benchmark
		? "Benchmark quest completed execution after a final self-check. External scores remain contingent on harness integrity."
		: "Benchmark quest completed. Human QA remains explicit before any release claims or shipping.";
	await saveQuest(quest);

	const completedResult: QuestHeadlessRunResult = {
		status: quest.status,
		summary: nextSummary(quest.status, quest, validatorFindings, benchmark),
		questId: quest.id,
		profileId: profile.id,
		traceBundleIds,
		validatorFindings,
		executionFindings,
		failureCategory,
		artifactPaths: {},
		benchmark: benchmark ? { ...benchmark } : undefined,
	};
	const resultFile = await persistResultFile(quest, completedResult);
	completedResult.artifactPaths = resultArtifactPaths(quest, resultFile);
	await writeFile(resultFile, `${JSON.stringify(completedResult, null, 2)}\n`, "utf-8");
	return completedResult;
}
