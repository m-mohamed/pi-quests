import { randomUUID } from "node:crypto";
import type {
	QuestBenchmarkName,
	QuestBenchmarkProvenance,
	ModelChoice,
	QuestEvalCase,
	QuestEvalDataset,
	QuestEvalDatasetKind,
	QuestExperimentCandidate,
	QuestExperimentScore,
	QuestFailureTag,
	QuestTrialTarget,
	QuestProfile,
	QuestProfilePatch,
	QuestPromptSurfaceId,
	QuestRole,
	QuestTraceBundle,
	QuestTraceToolEvent,
	QuestState,
	WorkerEventRecord,
	WorkerRunRecord,
} from "./types.js";

const PROFILE_VERSION = 1;
const TRACE_VERSION = 1;

function compact(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function uniqueCases(cases: QuestEvalCase[]): QuestEvalCase[] {
	const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
	return [...byId.values()];
}

function modelFamily(choice: ModelChoice): string {
	return `${choice.provider}/${choice.model.split(/[-/.]/)[0] ?? choice.model}`;
}

export function defaultQuestProfile(projectId: string, target: QuestTrialTarget = "repo"): QuestProfile {
	return {
		id: `${target}-${projectId}`,
		projectId,
		target,
		title: target === "quest-core" ? "Quest Core Profile" : "Repo Quest Profile",
		updatedAt: Date.now(),
		promptSurfaces: {
			version: PROFILE_VERSION,
			planningPolicy:
				"- Be explicit when validation is limited or unsupported.\n- Keep the first plan small and serial.\n- Preserve the final human QA handoff.\n- Prefer structured quest tools over ad-hoc file edits.",
			workerPolicy:
				"- Confirm prerequisites before deep implementation.\n- Prefer the shortest proof path that satisfies the assigned feature.\n- Spill very long evidence into trial reports instead of bloating inline summaries.",
			validatorCodeReviewPolicy:
				"- Stay read-only and call out weak validation honestly.\n- Prefer root-cause findings over adding repetitive corrective work.\n- Treat missing prerequisites as first-class issues.",
			validatorUserSurfacePolicy:
				"- Stay read-only and describe what remains limited.\n- Preserve the explicit human QA gate for final polish.\n- Prefer concise operator-facing findings over verbose transcripts.",
			readinessPolicy:
				"- Mark unsupported surfaces as unsupported.\n- Capture prerequisites, services, and commands that affect validation confidence.\n- Note when browser or user-surface checks still require manual coverage.",
			revisionPolicy:
				"- Preserve completed work.\n- Keep the remaining plan serial by default.\n- Revise only unfinished milestones, unfinished features, and unfinished validation.",
		},
		toolAllowlist: {
			orchestrator: ["read", "bash"],
			worker: ["read", "bash", "edit", "write"],
			validator: ["read", "bash"],
			trial: ["read", "bash"],
		},
		modelPolicy: {
			preferSameModelFamily: true,
			preferValidatorDivergence: false,
		},
		verificationBudget: {
			workerAttempts: 1,
			validatorAttempts: 1,
			correctiveFeatureBudget: 2,
		},
		contextPolicy: {
			spillThresholdChars: 1800,
			spillLongOutputsToReports: true,
			maxInlineEvidenceLines: 6,
		},
		workflowHintPolicy: {
			maxSharedHints: 24,
			promotePrerequisiteHints: true,
			promoteFailureHints: true,
		},
		traceGrading: {
			toolHeavyCount: 6,
			longRunMs: 1000 * 60 * 8,
			repeatedCorrectiveThreshold: 2,
			weakValidationPenalty: 0.2,
			blockedPenalty: 0.3,
			overflowPenalty: 0.25,
			abortPenalty: 0.15,
		},
		adoptedChanges: [],
	};
}

export function replayDatasetKindForBenchmark(benchmark?: QuestBenchmarkName): QuestEvalDatasetKind {
	switch (benchmark) {
		case "terminal-bench":
			return "terminal-bench-replays";
		case "slopcodebench":
			return "slopcodebench-replays";
		default:
			return "trace-replays";
	}
}

export function replayDatasetIdForBenchmark(projectId: string, benchmark?: QuestBenchmarkName): string {
	switch (replayDatasetKindForBenchmark(benchmark)) {
		case "terminal-bench-replays":
			return `terminal-bench-replays-${projectId}`;
		case "slopcodebench-replays":
			return `slopcodebench-replays-${projectId}`;
		default:
			return `trace-replays-${projectId}`;
	}
}

export function normalizeQuestProfile(
	profile: Partial<QuestProfile> | null | undefined,
	projectId: string,
	target: QuestTrialTarget = "repo",
): QuestProfile {
	const base = defaultQuestProfile(projectId, target);
	if (!profile) return base;
	return {
		...base,
		...profile,
		projectId,
		target: profile.target ?? target,
		promptSurfaces: {
			...base.promptSurfaces,
			...profile.promptSurfaces,
			version: profile.promptSurfaces?.version ?? base.promptSurfaces.version,
		},
		toolAllowlist: {
			...base.toolAllowlist,
			...profile.toolAllowlist,
			orchestrator: profile.toolAllowlist?.orchestrator ?? base.toolAllowlist.orchestrator,
			worker: profile.toolAllowlist?.worker ?? base.toolAllowlist.worker,
			validator: profile.toolAllowlist?.validator ?? base.toolAllowlist.validator,
			trial: profile.toolAllowlist?.trial ?? base.toolAllowlist.trial,
		},
		modelPolicy: { ...base.modelPolicy, ...profile.modelPolicy },
		verificationBudget: { ...base.verificationBudget, ...profile.verificationBudget },
		contextPolicy: { ...base.contextPolicy, ...profile.contextPolicy },
		workflowHintPolicy: { ...base.workflowHintPolicy, ...profile.workflowHintPolicy },
		traceGrading: { ...base.traceGrading, ...profile.traceGrading },
		adoptedChanges: profile.adoptedChanges ?? base.adoptedChanges,
		updatedAt: profile.updatedAt ?? base.updatedAt,
	};
}

export function toolAllowlistForRole(profile: QuestProfile, role: QuestRole): string[] {
	return profile.toolAllowlist[role];
}

export function promptSurfaceText(profile: QuestProfile, surfaceId: QuestPromptSurfaceId): string {
	switch (surfaceId) {
		case "planning":
			return profile.promptSurfaces.planningPolicy;
		case "feature-worker":
			return profile.promptSurfaces.workerPolicy;
		case "validator-code-review":
			return profile.promptSurfaces.validatorCodeReviewPolicy;
		case "validator-user-surface":
			return profile.promptSurfaces.validatorUserSurfacePolicy;
		case "readiness-probe":
			return profile.promptSurfaces.readinessPolicy;
		case "plan-revision":
			return profile.promptSurfaces.revisionPolicy;
	}
}

export function promptSurfaceForRun(role: QuestRole, kind: QuestTraceBundle["kind"], phase: string): QuestPromptSurfaceId {
	if (role === "worker" && kind === "feature") return "feature-worker";
	if (role === "validator" && phase === "user_surface") return "validator-user-surface";
	if (role === "validator" && kind === "readiness") return "readiness-probe";
	if (role === "orchestrator" && (kind === "replan" || phase === "replanning")) return "plan-revision";
	return role === "validator" ? "validator-code-review" : "planning";
}

function collectEvidence(run: WorkerRunRecord): string {
	return compact(
		[
			run.summary,
			run.stderr,
			run.issues?.join(" "),
			run.latestAssistantText,
			run.events.map((event) => [event.toolName, event.summary].filter(Boolean).join(": ")).join(" "),
		]
			.filter(Boolean)
			.join(" "),
	);
}

function collectToolTimeline(events: WorkerEventRecord[]): QuestTraceToolEvent[] {
	return events
		.filter((event) => event.toolName || event.type.startsWith("tool_"))
		.map((event) => ({
			ts: event.ts,
			type: event.type,
			toolName: event.toolName,
			summary: event.summary,
			isError: event.isError,
		}));
}

function deriveFailureTagsFromText(
	text: string,
	run: Pick<WorkerRunRecord, "role" | "ok" | "aborted" | "events" | "issues">,
	quest: QuestState | null,
	profile: QuestProfile,
): QuestFailureTag[] {
	const lower = text.toLowerCase();
	const tags: QuestFailureTag[] = [];

	if (/(docker|seed|db:push|db:migrate|db:seed|service|prerequisite|before .*validation|before .*check)/.test(lower)) {
		tags.push("prerequisite_miss");
	}
	if (/(limited|unsupported|manual|human qa|weak validation)/.test(lower)) {
		tags.push("weak_validation");
	}
	if (/blocked|blocker|cannot continue|stuck milestone/.test(lower)) {
		tags.push("blocked_milestone");
	}
	if (/corrective|follow-up|follow up|again|repeat|repeated/.test(lower)) {
		tags.push("repeated_corrective_loop");
	}
	if (/(context|token).*(overflow|limit|too long|too large)/.test(lower)) {
		tags.push("context_overflow");
	}
	if (run.aborted) {
		tags.push("operator_abort");
	}
	if (collectToolTimeline(run.events).length >= profile.traceGrading.toolHeavyCount) {
		tags.push("tool_heavy");
	}
	if (run.role === "validator" && !run.ok) {
		tags.push("validator_failure");
	}
	if (run.role === "worker" && !run.ok) {
		tags.push("worker_failure");
	}

	if (quest) {
		const orchestrator = quest.roleModels.orchestrator ?? quest.defaultModel;
		const runModel =
			run.role === "worker"
				? quest.roleModels.worker ?? quest.defaultModel
				: run.role === "validator"
					? quest.roleModels.validator ?? quest.defaultModel
					: orchestrator;
		if (
			profile.modelPolicy.preferSameModelFamily &&
			run.role === "worker" &&
			modelFamily(orchestrator) !== modelFamily(runModel) &&
			!run.ok
		) {
			tags.push("model_mismatch_suspected");
		}
	}

	return unique(tags);
}

export function describeFailureTag(tag: QuestFailureTag): string {
	switch (tag) {
		case "prerequisite_miss":
			return "Prerequisites were missing or discovered too late.";
		case "weak_validation":
			return "Validation coverage was limited or manually dependent.";
		case "blocked_milestone":
			return "Execution blocked a milestone instead of closing it cleanly.";
		case "repeated_corrective_loop":
			return "The run showed signs of repetitive corrective follow-up loops.";
		case "operator_abort":
			return "The run was interrupted by an operator abort.";
		case "context_overflow":
			return "The run likely overflowed context or evidence size.";
		case "model_mismatch_suspected":
			return "The role pairing may be mismatched for the task.";
		case "tool_heavy":
			return "The run used an unusually large number of tool events.";
		case "validator_failure":
			return "Validator execution failed or returned blocking issues.";
		case "worker_failure":
			return "Worker execution failed or returned blocking issues.";
	}
}

export function deriveIssuesFromTags(tags: QuestFailureTag[]): string[] {
	return tags.map(describeFailureTag);
}

export function traceBundleFromWorkerRun(quest: QuestState, run: WorkerRunRecord, profile: QuestProfile): QuestTraceBundle {
	const evidence = collectEvidence(run);
	const tags = deriveFailureTagsFromText(evidence, run, quest, profile);
	const validatorFindings = run.role === "validator" ? run.issues ?? [] : [];

	return {
		id: randomUUID(),
		traceVersion: TRACE_VERSION,
		projectId: quest.projectId,
		questId: quest.id,
		runId: run.id,
		role: run.role,
		kind: run.role === "worker" ? "feature" : run.role === "validator" ? (run.phase === "readiness" ? "readiness" : "validator") : "replan",
		featureId: run.featureId,
		milestoneId: run.milestoneId,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		durationMs: Math.max(0, run.endedAt - run.startedAt),
		modelChoice: {
			provider: run.provider,
			model: run.model,
			thinkingLevel: run.thinkingLevel,
		},
		ok: run.ok,
		aborted: run.aborted === true,
		summary: run.summary,
		latestToolName: run.latestToolName,
		latestAssistantText: run.latestAssistantText,
		promptSurfaceId: promptSurfaceForRun(run.role, run.role === "worker" ? "feature" : run.role === "validator" ? "validator" : "replan", run.phase),
		promptSurfaceVersion: profile.promptSurfaces.version,
		toolTimeline: collectToolTimeline(run.events),
		issues: run.issues ?? [],
		validatorFindings,
		tags,
		derivedIssues: deriveIssuesFromTags(tags),
		usage: run.usage,
		source: "worker_run",
		benchmark: run.benchmark,
	};
}

export function traceBundleFromPlanningSession(
	quest: QuestState,
	events: WorkerEventRecord[],
	modelChoice: ModelChoice,
	profile: QuestProfile,
	summary: string,
	ok: boolean,
	startedAt: number,
	endedAt: number,
	latestMessage?: string,
	benchmark?: QuestBenchmarkProvenance,
): QuestTraceBundle {
	const mockRun: Pick<WorkerRunRecord, "role" | "ok" | "aborted" | "events" | "issues"> = {
		role: "orchestrator",
		ok,
		aborted: false,
		events,
		issues: [],
	};
	const evidence = compact([summary, latestMessage, events.map((event) => event.summary).join(" ")].filter(Boolean).join(" "));
	const tags = deriveFailureTagsFromText(evidence, mockRun, quest, profile);

	return {
		id: randomUUID(),
		traceVersion: TRACE_VERSION,
		projectId: quest.projectId,
		questId: quest.id,
		role: "orchestrator",
		kind: "planning",
		startedAt,
		endedAt,
		durationMs: Math.max(0, endedAt - startedAt),
		modelChoice,
		ok,
		aborted: false,
		summary,
		latestAssistantText: latestMessage,
		promptSurfaceId: "planning",
		promptSurfaceVersion: profile.promptSurfaces.version,
		toolTimeline: collectToolTimeline(events),
		issues: [],
		validatorFindings: [],
		tags,
		derivedIssues: deriveIssuesFromTags(tags),
		source: "planning_session",
		benchmark,
	};
}

export function gradeTraceBundle(
	trace: QuestTraceBundle,
	profile: QuestProfile,
): { score: number; maxScore: number; findings: string[] } {
	let score = 1;
	const findings: string[] = [];
	for (const tag of trace.tags) {
		switch (tag) {
			case "weak_validation":
				score -= profile.traceGrading.weakValidationPenalty;
				break;
			case "blocked_milestone":
			case "validator_failure":
			case "worker_failure":
				score -= profile.traceGrading.blockedPenalty;
				break;
			case "context_overflow":
				score -= profile.traceGrading.overflowPenalty;
				break;
			case "operator_abort":
				score -= profile.traceGrading.abortPenalty;
				break;
			default:
				score -= 0.05;
		}
		findings.push(describeFailureTag(tag));
	}
	if (trace.durationMs >= profile.traceGrading.longRunMs) {
		score -= 0.05;
		findings.push("Run exceeded the long-run threshold.");
	}
	return {
		score: Math.max(0, Number(score.toFixed(3))),
		maxScore: 1,
		findings,
	};
}

function caseFromTag(tag: QuestFailureTag, trace: QuestTraceBundle): QuestEvalCase {
	const now = Date.now();
	const requiredSurfaceSnippets: string[] = [];
	const requiredPolicies: QuestEvalCase["expectations"]["requiredPolicies"] = {};
	const targetSurfaceIds: QuestPromptSurfaceId[] = [];

	switch (tag) {
		case "prerequisite_miss":
			requiredSurfaceSnippets.push("Confirm prerequisites");
			requiredPolicies.maxSharedHintsAtLeast = 1;
			targetSurfaceIds.push("feature-worker", "readiness-probe");
			break;
		case "weak_validation":
			requiredSurfaceSnippets.push("limited or unsupported");
			requiredPolicies.spillLongOutputsToReports = true;
			targetSurfaceIds.push("planning", "validator-code-review", "validator-user-surface");
			break;
		case "blocked_milestone":
		case "repeated_corrective_loop":
			requiredSurfaceSnippets.push("root-cause");
			requiredPolicies.correctiveFeatureBudgetAtMost = 2;
			targetSurfaceIds.push("validator-code-review", "validator-user-surface");
			break;
		case "context_overflow":
			requiredSurfaceSnippets.push("Spill very long evidence");
			requiredPolicies.spillLongOutputsToReports = true;
			targetSurfaceIds.push("feature-worker");
			break;
		case "model_mismatch_suspected":
			requiredPolicies.preferSameModelFamily = true;
			targetSurfaceIds.push("feature-worker");
			break;
		case "tool_heavy":
			requiredSurfaceSnippets.push("shortest proof path");
			targetSurfaceIds.push("feature-worker");
			break;
		default:
			requiredSurfaceSnippets.push("human QA");
			targetSurfaceIds.push("planning");
	}

	return {
		id: `trace-${trace.id}-${tag}`,
		title: `Trace replay: ${tag}`,
		description: `Replay expectations derived from ${tag} on trace ${trace.id}.`,
		source: "trace_replay",
		caseType: "trace_replay",
		targetSurfaceIds: unique(targetSurfaceIds),
		failureTags: [tag],
		provenance: {
			traceId: trace.id,
			runId: trace.runId,
			questId: trace.questId,
			benchmark: trace.benchmark,
			createdAt: now,
		},
		input: {
			role: trace.role,
			tags: trace.tags,
			issues: trace.issues,
			promptContains: [trace.summary],
		},
		expectations: {
			requiredSurfaceSnippets,
			requiredPolicies,
		},
	};
}

function seededCase(
	id: string,
	title: string,
	description: string,
	targetSurfaceIds: QuestPromptSurfaceId[],
	requiredSurfaceSnippets: string[],
	requiredPolicies: QuestEvalCase["expectations"]["requiredPolicies"] = {},
	failureTags: QuestFailureTag[] = [],
): QuestEvalCase {
	return {
		id,
		title,
		description,
		source: "seeded",
		caseType: "policy",
		targetSurfaceIds,
		failureTags,
		provenance: { createdAt: Date.now() },
		input: {},
		expectations: {
			requiredSurfaceSnippets,
			requiredPolicies,
		},
	};
}

export function seedQuestDatasets(projectId: string, traces: QuestTraceBundle[]): QuestEvalDataset[] {
	const coreCases: QuestEvalCase[] = [
		seededCase(
			"planning-honesty",
			"Planning stays explicit about limited validation",
			"Planning should call out weak validation instead of pretending automation exists.",
			["planning"],
			["limited or unsupported", "human QA"],
			{ spillLongOutputsToReports: true },
			["weak_validation"],
		),
		seededCase(
			"planning-serial",
			"Planning stays serial by default",
			"Quest planning should preserve serial-by-default execution.",
			["planning", "plan-revision"],
			["serial"],
		),
		seededCase(
			"worker-prereqs",
			"Worker prompt checks prerequisites early",
			"Workers should check prerequisites before deep implementation.",
			["feature-worker"],
			["Confirm prerequisites", "shortest proof path"],
			{},
			["prerequisite_miss"],
		),
		seededCase(
			"worker-context-spill",
			"Worker prompt spills long evidence to reports",
			"Workers should keep inline context small.",
			["feature-worker"],
			["Spill very long evidence"],
			{ spillLongOutputsToReports: true },
			["context_overflow"],
		),
		seededCase(
			"validator-code-review-honesty",
			"Code-review validator stays read-only and honest",
			"Validator should be read-only and explicit about weak coverage.",
			["validator-code-review"],
			["read-only", "weak validation", "root-cause"],
			{},
			["weak_validation", "blocked_milestone"],
		),
		seededCase(
			"validator-user-surface-honesty",
			"User-surface validator preserves the human QA gate",
			"User-surface validation should not erase the final human review step.",
			["validator-user-surface"],
			["read-only", "human QA", "limited"],
			{},
			["weak_validation"],
		),
		seededCase(
			"readiness-honesty",
			"Readiness probe marks unsupported surfaces honestly",
			"Readiness should surface unsupported checks directly.",
			["readiness-probe"],
			["unsupported", "prerequisites"],
			{},
			["weak_validation", "prerequisite_miss"],
		),
		seededCase(
			"revision-boundary",
			"Revision prompt preserves completed work",
			"Replanning should only touch unfinished work.",
			["plan-revision"],
			["Preserve completed work", "serial"],
		),
		seededCase(
			"model-pairing",
			"Model pairing prefers the same family by default",
			"Quest should prefer same-family orchestrator and worker pairings unless explicitly overridden.",
			["feature-worker"],
			["shortest proof path"],
			{ preferSameModelFamily: true },
			["model_mismatch_suspected"],
		),
		seededCase(
			"workflow-hint-promotion",
			"Workflow hints promote repeated prerequisites",
			"Repeated prerequisite misses should become reusable hints.",
			["feature-worker", "readiness-probe"],
			["Confirm prerequisites"],
			{ maxSharedHintsAtLeast: 1 },
			["prerequisite_miss"],
		),
		seededCase(
			"corrective-budget",
			"Corrective loops stay bounded",
			"Quest should avoid unbounded corrective feature churn.",
			["validator-code-review", "validator-user-surface"],
			["root-cause"],
			{ correctiveFeatureBudgetAtMost: 2 },
			["repeated_corrective_loop"],
		),
		seededCase(
			"tool-heavy-discipline",
			"Tool-heavy traces encourage tighter proof paths",
			"Workers should not overuse tools when a smaller proof path is available.",
			["feature-worker"],
			["shortest proof path"],
			{},
			["tool_heavy"],
		),
	];

	const heldOutCases: QuestEvalCase[] = [
		seededCase(
			"heldout-human-qa",
			"Held-out: human QA remains explicit",
			"Hold out a final human QA case against rubric overfitting.",
			["planning", "validator-user-surface"],
			["human QA"],
		),
		seededCase(
			"heldout-limited-validation",
			"Held-out: limited surfaces stay explicit",
			"Hold out a weak-validation case against automated optimism.",
			["planning", "readiness-probe", "validator-code-review"],
			["limited or unsupported"],
		),
		seededCase(
			"heldout-scope",
			"Held-out: revisions stay scoped",
			"Hold out a remaining-work boundary case.",
			["plan-revision"],
			["Preserve completed work"],
		),
	];

	const replayCases = traces.flatMap((trace) => trace.tags.map((tag) => caseFromTag(tag, trace)));
	const sharedReplayCases = replayCases.filter((testCase) => !testCase.provenance.benchmark);
	const terminalReplayCases = replayCases.filter((testCase) => testCase.provenance.benchmark?.benchmark === "terminal-bench");
	const slopReplayCases = replayCases.filter((testCase) => testCase.provenance.benchmark?.benchmark === "slopcodebench");

	return [
		{
			id: `core-regression-${projectId}`,
			title: "Quest core regression dataset",
			kind: "core-regression",
			description: "Seeded policy and prompt-surface checks that should remain stable.",
			updatedAt: Date.now(),
			cases: coreCases,
		},
		{
			id: `repo-profile-${projectId}`,
			title: "Repo Quest profile dataset",
			kind: "repo-profile",
			description: "Repo-facing profile checks for prerequisite handling and bounded validation loops.",
			updatedAt: Date.now(),
			cases: coreCases.filter((testCase) => testCase.failureTags.length > 0),
		},
		{
			id: `trace-replays-${projectId}`,
			title: "Trace replay dataset",
			kind: "trace-replays",
			description: "Offline cases automatically materialized from interesting quest traces.",
			updatedAt: Date.now(),
			cases: uniqueCases(sharedReplayCases),
		},
		{
			id: `terminal-bench-replays-${projectId}`,
			title: "Terminal-Bench replay dataset",
			kind: "terminal-bench-replays",
			description: "Replay cases derived from Terminal-Bench benchmark runs.",
			updatedAt: Date.now(),
			cases: uniqueCases(terminalReplayCases),
		},
		{
			id: `slopcodebench-replays-${projectId}`,
			title: "SlopCodeBench replay dataset",
			kind: "slopcodebench-replays",
			description: "Replay cases derived from SlopCodeBench checkpoint runs.",
			updatedAt: Date.now(),
			cases: uniqueCases(slopReplayCases),
		},
		{
			id: `held-out-${projectId}`,
			title: "Held-out Quest dataset",
			kind: "held-out",
			description: "Held-out checks used as an overfitting guard before adopting improvements.",
			updatedAt: Date.now(),
			cases: heldOutCases,
		},
	];
}

export function mergeTraceReplayCases(existing: QuestEvalDataset, traces: QuestTraceBundle[]): QuestEvalDataset {
	const replayCases = traces
		.filter((trace) => replayDatasetKindForBenchmark(trace.benchmark?.benchmark) === existing.kind)
		.flatMap((trace) => trace.tags.map((tag) => caseFromTag(tag, trace)));
	const byId = new Map(existing.cases.map((testCase) => [testCase.id, testCase]));
	for (const testCase of replayCases) {
		byId.set(testCase.id, testCase);
	}
	return {
		...existing,
		updatedAt: Date.now(),
		cases: [...byId.values()],
	};
}

function surfaceTextForCase(profile: QuestProfile, surfaceIds: QuestPromptSurfaceId[]): string {
	return surfaceIds.map((surfaceId) => promptSurfaceText(profile, surfaceId)).join("\n");
}

function policySatisfied(profile: QuestProfile, testCase: QuestEvalCase): string[] {
	const failures: string[] = [];
	const requiredPolicies = testCase.expectations.requiredPolicies;
	if (!requiredPolicies) return failures;
	if (requiredPolicies.preferSameModelFamily !== undefined && profile.modelPolicy.preferSameModelFamily !== requiredPolicies.preferSameModelFamily) {
		failures.push(`preferSameModelFamily should be ${requiredPolicies.preferSameModelFamily}`);
	}
	if (
		requiredPolicies.spillLongOutputsToReports !== undefined &&
		profile.contextPolicy.spillLongOutputsToReports !== requiredPolicies.spillLongOutputsToReports
	) {
		failures.push(`spillLongOutputsToReports should be ${requiredPolicies.spillLongOutputsToReports}`);
	}
	if (
		requiredPolicies.maxSharedHintsAtLeast !== undefined &&
		profile.workflowHintPolicy.maxSharedHints < requiredPolicies.maxSharedHintsAtLeast
	) {
		failures.push(`maxSharedHints should be at least ${requiredPolicies.maxSharedHintsAtLeast}`);
	}
	if (
		requiredPolicies.correctiveFeatureBudgetAtMost !== undefined &&
		profile.verificationBudget.correctiveFeatureBudget > requiredPolicies.correctiveFeatureBudgetAtMost
	) {
		failures.push(`correctiveFeatureBudget should be at most ${requiredPolicies.correctiveFeatureBudgetAtMost}`);
	}
	return failures;
}

export function evaluateQuestEvalCase(profile: QuestProfile, testCase: QuestEvalCase): { passed: boolean; findings: string[] } {
	const findings: string[] = [];
	const surfaceText = surfaceTextForCase(profile, testCase.targetSurfaceIds).toLowerCase();
	for (const snippet of testCase.expectations.requiredSurfaceSnippets ?? []) {
		if (!surfaceText.includes(snippet.toLowerCase())) {
			findings.push(`Missing required surface snippet: ${snippet}`);
		}
	}
	for (const snippet of testCase.expectations.forbidSurfaceSnippets ?? []) {
		if (surfaceText.includes(snippet.toLowerCase())) {
			findings.push(`Forbidden surface snippet present: ${snippet}`);
		}
	}
	findings.push(...policySatisfied(profile, testCase));
	return {
		passed: findings.length === 0,
		findings,
	};
}

export function evaluateQuestDataset(
	profile: QuestProfile,
	dataset: QuestEvalDataset,
	caseIds?: string[],
): QuestExperimentScore {
	const selected = caseIds && caseIds.length > 0 ? dataset.cases.filter((testCase) => caseIds.includes(testCase.id)) : dataset.cases;
	const findings: string[] = [];
	let passed = 0;
	for (const testCase of selected) {
		const outcome = evaluateQuestEvalCase(profile, testCase);
		if (outcome.passed) {
			passed += 1;
			continue;
		}
		findings.push(`${testCase.id}: ${outcome.findings.join("; ")}`);
	}
	return {
		datasetId: dataset.id,
		caseIds: selected.map((testCase) => testCase.id),
		passed,
		failed: selected.length - passed,
		score: passed,
		maxScore: selected.length,
		findings,
	};
}

export function applyQuestProfilePatch(profile: QuestProfile, patch: QuestProfilePatch): QuestProfile {
	const next = normalizeQuestProfile(
		{
			...profile,
			promptSurfaces: {
				...profile.promptSurfaces,
				...patch.promptSurfaces,
			},
			toolAllowlist: {
				...profile.toolAllowlist,
				...patch.toolAllowlist,
				orchestrator: patch.toolAllowlist?.orchestrator ?? profile.toolAllowlist.orchestrator,
				worker: patch.toolAllowlist?.worker ?? profile.toolAllowlist.worker,
				validator: patch.toolAllowlist?.validator ?? profile.toolAllowlist.validator,
				trial: patch.toolAllowlist?.trial ?? profile.toolAllowlist.trial,
			},
			modelPolicy: { ...profile.modelPolicy, ...patch.modelPolicy },
			verificationBudget: { ...profile.verificationBudget, ...patch.verificationBudget },
			contextPolicy: { ...profile.contextPolicy, ...patch.contextPolicy },
			workflowHintPolicy: { ...profile.workflowHintPolicy, ...patch.workflowHintPolicy },
			traceGrading: { ...profile.traceGrading, ...patch.traceGrading },
			adoptedChanges: patch.adoptedChange ? [...profile.adoptedChanges, patch.adoptedChange] : profile.adoptedChanges,
			updatedAt: Date.now(),
		},
		profile.projectId,
		profile.target,
	);
	return next;
}

export function selectInterestingTraces(traces: QuestTraceBundle[], profile: QuestProfile): QuestTraceBundle[] {
	return traces
		.filter((trace) => {
			if (trace.tags.length > 0) return true;
			const grade = gradeTraceBundle(trace, profile);
			return grade.score < 1;
		})
		.sort((left, right) => right.endedAt - left.endedAt);
}

export function chooseHeuristicCandidate(
	profile: QuestProfile,
	traces: QuestTraceBundle[],
	datasets: QuestEvalDataset[],
): QuestExperimentCandidate | null {
	const interesting = selectInterestingTraces(traces, profile);
	const tagCounts = new Map<QuestFailureTag, number>();
	for (const trace of interesting) {
		for (const tag of trace.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
	}
	const topTag = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (!topTag) return null;

	const replayDatasets = datasets.filter((dataset) => dataset.kind.endsWith("replays"));
	const targetedCaseIds =
		replayDatasets
			.flatMap((dataset) => dataset.cases)
			.filter((testCase) => testCase.failureTags.includes(topTag))
			.map((testCase) => testCase.id) ?? [];
	const patch: QuestProfilePatch = {};
	const promptSurfaceIds: QuestPromptSurfaceId[] = [];

	switch (topTag) {
		case "prerequisite_miss":
			patch.promptSurfaces = {
				workerPolicy: `${profile.promptSurfaces.workerPolicy}\n- Confirm prerequisites before deep implementation and mention them in the handoff when they block progress.`,
				readinessPolicy: `${profile.promptSurfaces.readinessPolicy}\n- Capture prerequisites explicitly when they gate confidence or startup.`,
			};
			patch.workflowHintPolicy = { promotePrerequisiteHints: true, maxSharedHints: Math.max(profile.workflowHintPolicy.maxSharedHints, 24) };
			patch.adoptedChange = "Strengthen prerequisite discovery and hint promotion.";
			promptSurfaceIds.push("feature-worker", "readiness-probe");
			break;
		case "weak_validation":
			patch.promptSurfaces = {
				planningPolicy: `${profile.promptSurfaces.planningPolicy}\n- If coverage is limited or unsupported, say so explicitly and preserve the human QA gate.`,
				validatorCodeReviewPolicy: `${profile.promptSurfaces.validatorCodeReviewPolicy}\n- Call limited or unsupported coverage out explicitly instead of implying full automation.`,
				validatorUserSurfacePolicy: `${profile.promptSurfaces.validatorUserSurfacePolicy}\n- Keep the human QA gate explicit when user-surface validation is partial.`,
			};
			patch.contextPolicy = { spillLongOutputsToReports: true };
			patch.adoptedChange = "Make weak-validation honesty more explicit across planning and validation.";
			promptSurfaceIds.push("planning", "validator-code-review", "validator-user-surface");
			break;
		case "context_overflow":
			patch.promptSurfaces = {
				workerPolicy: `${profile.promptSurfaces.workerPolicy}\n- Spill very long evidence into trial reports and keep inline summaries short.`,
			};
			patch.contextPolicy = {
				spillLongOutputsToReports: true,
				spillThresholdChars: Math.min(profile.contextPolicy.spillThresholdChars, 1400),
			};
			patch.adoptedChange = "Tighten spill-to-file behavior for long evidence.";
			promptSurfaceIds.push("feature-worker");
			break;
		case "model_mismatch_suspected":
			patch.modelPolicy = { preferSameModelFamily: true };
			patch.adoptedChange = "Bias orchestrator and worker toward the same model family.";
			promptSurfaceIds.push("feature-worker");
			break;
		case "repeated_corrective_loop":
		case "blocked_milestone":
		case "validator_failure":
			patch.promptSurfaces = {
				validatorCodeReviewPolicy: `${profile.promptSurfaces.validatorCodeReviewPolicy}\n- Prefer root-cause findings over repetitive corrective feature churn.`,
				validatorUserSurfacePolicy: `${profile.promptSurfaces.validatorUserSurfacePolicy}\n- Prefer one decisive operator-facing issue summary over repeated follow-up churn.`,
			};
			patch.verificationBudget = {
				correctiveFeatureBudget: Math.min(profile.verificationBudget.correctiveFeatureBudget, 2),
			};
			patch.adoptedChange = "Bound corrective loops and strengthen validator root-cause reporting.";
			promptSurfaceIds.push("validator-code-review", "validator-user-surface");
			break;
		case "tool_heavy":
			patch.promptSurfaces = {
				workerPolicy: `${profile.promptSurfaces.workerPolicy}\n- Prefer the shortest proof path and stop once the required proof is collected.`,
			};
			patch.adoptedChange = "Reduce tool-heavy execution by biasing toward shorter proof paths.";
			promptSurfaceIds.push("feature-worker");
			break;
		default:
			patch.promptSurfaces = {
				planningPolicy: `${profile.promptSurfaces.planningPolicy}\n- Preserve the human QA handoff and keep the plan small.`,
			};
			patch.adoptedChange = "Reinforce explicit QA and small-plan defaults.";
			promptSurfaceIds.push("planning");
			break;
	}

	return {
		id: randomUUID(),
		source: "heuristic",
		summary: `Trials candidate for ${topTag}`,
		rationale: `Most recent interesting traces clustered around ${topTag}.`,
		generalizationNote: `This change addresses the shared failure mode ${topTag} without relying on one exact trace output.`,
		targetedTags: [topTag],
		targetedCaseIds,
		patch,
		promptSurfaceIds: unique(promptSurfaceIds),
	};
}

export function parseQuestExperimentCandidate(text: string): QuestExperimentCandidate | null {
	const fenced = text.match(/```json\s*([\s\S]*?)```/i);
	const candidateText = fenced ? fenced[1] : text;
	try {
		const parsed = JSON.parse(candidateText) as {
			summary?: string;
			rationale?: string;
			generalizationNote?: string;
			targetedTags?: QuestFailureTag[];
			targetedCaseIds?: string[];
			promptSurfaceIds?: QuestPromptSurfaceId[];
			patch?: QuestProfilePatch;
		};
		if (!parsed.summary || !parsed.rationale || !parsed.generalizationNote || !parsed.patch) return null;
		return {
			id: randomUUID(),
			source: "agent",
			summary: parsed.summary,
			rationale: parsed.rationale,
			generalizationNote: parsed.generalizationNote,
			targetedTags: parsed.targetedTags ?? [],
			targetedCaseIds: parsed.targetedCaseIds ?? [],
			patch: parsed.patch,
			promptSurfaceIds: parsed.promptSurfaceIds ?? [],
		};
	} catch {
		return null;
	}
}

export function selectSpotCheckCaseIds(
	datasets: QuestEvalDataset[],
	candidate: QuestExperimentCandidate,
): string[] {
	if (candidate.targetedCaseIds.length > 0) return unique(candidate.targetedCaseIds);
	const replayMatches =
		datasets
			.filter((dataset) => dataset.kind.endsWith("replays"))
			.flatMap((dataset) => dataset.cases)
			.filter((testCase) => testCase.failureTags.some((tag) => candidate.targetedTags.includes(tag)))
			.map((testCase) => testCase.id) ?? [];
	if (replayMatches.length > 0) return unique(replayMatches).slice(0, 6);
	const core = datasets.find((dataset) => dataset.kind === "core-regression");
	return core?.cases.slice(0, 4).map((testCase) => testCase.id) ?? [];
}

export function selectHeldOutCaseIds(datasets: QuestEvalDataset[]): string[] {
	const heldOut = datasets.find((dataset) => dataset.kind === "held-out");
	return heldOut?.cases.map((testCase) => testCase.id) ?? [];
}

export function candidateWins(baseline: QuestExperimentScore[], candidate: QuestExperimentScore[]): boolean {
	const baselineScore = baseline.reduce((total, item) => total + item.score, 0);
	const baselineMax = baseline.reduce((total, item) => total + item.maxScore, 0);
	const candidateScore = candidate.reduce((total, item) => total + item.score, 0);
	const candidateMax = candidate.reduce((total, item) => total + item.maxScore, 0);
	if (candidateMax === 0) return false;
	return candidateScore > baselineScore || (candidateScore === baselineScore && candidateMax >= baselineMax);
}

export function summarizeExperimentScores(scores: QuestExperimentScore[]): string {
	if (scores.length === 0) return "No scores recorded.";
	return scores
		.map((score) => `${score.datasetId}: ${score.score}/${score.maxScore}${score.failed > 0 ? ` (${score.failed} failed)` : ""}`)
		.join(" · ");
}
