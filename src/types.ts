export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type QuestStatus = "planning" | "proposal_ready" | "running" | "paused" | "blocked" | "completed" | "aborted";
export type FeatureStatus = "pending" | "running" | "completed" | "blocked" | "skipped";
export type MilestoneStatus = "pending" | "running" | "completed" | "blocked";
export type QuestRole = "orchestrator" | "worker" | "validator" | "trial";
export type HumanQaStatus = "pending" | "approved";
export type ShipReadiness = "not_ready" | "validated_waiting_for_human_qa" | "human_qa_complete";
export type ValidationSurfaceStatus = "supported" | "limited" | "unsupported";
export type ValidationMethod =
	| "code_review"
	| "procedure_review"
	| "user_surface"
	| "command"
	| "read_only"
	| "manual"
	| "mixed";
export type ValidationCriticality = "critical" | "important" | "informational";
export type ValidationAssertionStatus = "pending" | "passed" | "failed" | "limited";
export type ActiveRunKind = "feature" | "validator" | "replan" | "readiness";
export type QuestTrialTarget = "repo" | "quest-core";
export type QuestTrialStatus = "idle" | "running" | "stopped" | "blocked";
export type QuestPromptSurfaceId =
	| "planning"
	| "feature-worker"
	| "validator-code-review"
	| "validator-user-surface"
	| "readiness-probe"
	| "plan-revision";
export type QuestFailureTag =
	| "prerequisite_miss"
	| "weak_validation"
	| "blocked_milestone"
	| "repeated_corrective_loop"
	| "operator_abort"
	| "context_overflow"
	| "model_mismatch_suspected"
	| "tool_heavy"
	| "validator_failure"
	| "worker_failure";
export type QuestBenchmarkName = "local" | "terminal-bench" | "slopcodebench";
export type QuestBenchmarkRunMode = "local" | "sample" | "full" | "smoke" | "custom";
export type QuestEvalDatasetKind =
	| "core-regression"
	| "repo-profile"
	| "trace-replays"
	| "terminal-bench-replays"
	| "slopcodebench-replays"
	| "held-out";
export type QuestEvalCaseSource = "seeded" | "trace_replay";
export type QuestEvalCaseType = "policy" | "trace_replay";
export type QuestExperimentState = "planned" | "running" | "rejected" | "applied" | "failed" | "stopped";

export interface QuestBenchmarkProvenance {
	benchmark: QuestBenchmarkName;
	dataset: string;
	taskId: string;
	checkpointId?: string;
	runMode: QuestBenchmarkRunMode;
	adapterVersion: string;
	recordedAt: number;
	model?: string;
	passed?: boolean;
	score?: number;
}

export interface QuestPromptSurfaces {
	version: number;
	planningPolicy: string;
	workerPolicy: string;
	validatorCodeReviewPolicy: string;
	validatorUserSurfacePolicy: string;
	readinessPolicy: string;
	revisionPolicy: string;
}

export interface QuestRoleToolPolicy {
	orchestrator: string[];
	worker: string[];
	validator: string[];
	trial: string[];
}

export interface QuestModelPolicy {
	preferSameModelFamily: boolean;
	preferValidatorDivergence: boolean;
}

export interface QuestVerificationBudget {
	workerAttempts: number;
	validatorAttempts: number;
	correctiveFeatureBudget: number;
}

export interface QuestContextPolicy {
	spillThresholdChars: number;
	spillLongOutputsToReports: boolean;
	maxInlineEvidenceLines: number;
}

export interface QuestWorkflowHintPolicy {
	maxSharedHints: number;
	promotePrerequisiteHints: boolean;
	promoteFailureHints: boolean;
}

export interface QuestTraceGradingThresholds {
	toolHeavyCount: number;
	longRunMs: number;
	repeatedCorrectiveThreshold: number;
	weakValidationPenalty: number;
	blockedPenalty: number;
	overflowPenalty: number;
	abortPenalty: number;
}

export interface QuestProfile {
	id: string;
	projectId: string;
	target: QuestTrialTarget;
	title: string;
	updatedAt: number;
	promptSurfaces: QuestPromptSurfaces;
	toolAllowlist: QuestRoleToolPolicy;
	modelPolicy: QuestModelPolicy;
	verificationBudget: QuestVerificationBudget;
	contextPolicy: QuestContextPolicy;
	workflowHintPolicy: QuestWorkflowHintPolicy;
	traceGrading: QuestTraceGradingThresholds;
	adoptedChanges: string[];
}

export interface ModelChoice {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

export interface QuestConfig {
	orchestratorModel: ModelChoice;
	workerModel: ModelChoice;
	validatorModel: ModelChoice;
	validationConcurrency: number;
	cwd: string;
	createdAt: number;
}

export interface QuestServiceDefinition {
	name: string;
	purpose: string;
	commands: string[];
	ports?: number[];
	notes?: string[];
}

export interface QuestFeature {
	id: string;
	order: number;
	milestoneId: string;
	title: string;
	description: string;
	preconditions: string[];
	fulfills: string[];
	status: FeatureStatus;
	handoff?: string;
	workerPrompt?: string;
	lastRunSummary?: string;
	lastError?: string;
	summary?: string;
	acceptanceCriteria?: string[];
}

export interface QuestMilestone {
	id: string;
	order: number;
	title: string;
	description: string;
	successCriteria: string[];
	validationPrompt?: string;
	status: MilestoneStatus;
	summary?: string;
}

export interface ValidationReadinessCheck {
	id: string;
	surface: string;
	description: string;
	status: ValidationSurfaceStatus;
	commands: string[];
	evidence: string[];
	notes?: string;
}

export interface ValidationReadiness {
	summary: string;
	checks: ValidationReadinessCheck[];
}

export interface ValidationAssertion {
	id: string;
	milestoneId: string;
	description: string;
	method: ValidationMethod;
	criticality: ValidationCriticality;
	status: ValidationAssertionStatus;
	evidence: string[];
	featureIds?: string[];
	notes?: string;
	commands?: string[];
}

export interface ValidationState {
	assertions: ValidationAssertion[];
	updatedAt: number;
}

export interface QuestPlan {
	title: string;
	summary: string;
	goal?: string;
	risks: string[];
	environment: string[];
	services: QuestServiceDefinition[];
	validationSummary?: string;
	humanQaChecklist: string[];
	milestones: QuestMilestone[];
	features: QuestFeature[];
}

export interface QuestPlanRevisionRequest {
	id: string;
	source: "steer" | "validator";
	note: string;
	createdAt: number;
	milestoneId?: string;
	issues?: string[];
}

export interface QuestPlanRevision {
	id: string;
	source: "initial" | "steer" | "validator";
	summary: string;
	hash: string;
	createdAt: number;
	requestIds: string[];
}

export interface WorkerEventRecord {
	ts: number;
	type: string;
	phase: string;
	summary?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

export interface QuestTraceToolEvent {
	ts: number;
	type: string;
	toolName?: string;
	summary?: string;
	isError?: boolean;
}

export interface LiveRunSnapshot {
	role: QuestRole;
	featureId?: string;
	milestoneId?: string;
	phase: string;
	latestToolName?: string;
	latestToolSummary?: string;
	latestMessage?: string;
	updatedAt: number;
}

export interface QuestActiveRun {
	role: QuestRole;
	kind: ActiveRunKind;
	pid?: number;
	featureId?: string;
	milestoneId?: string;
	phase: string;
	startedAt: number;
	abortRequestedAt?: number;
}

export interface QuestInterruption {
	reason: "operator_abort";
	role: QuestRole;
	kind: ActiveRunKind;
	featureId?: string;
	milestoneId?: string;
	pid?: number;
	startedAt: number;
	interruptedAt: number;
	summary: string;
}

export interface WorkerRunRecord {
	id: string;
	role: QuestRole;
	featureId?: string;
	milestoneId?: string;
	startedAt: number;
	endedAt: number;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	exitCode: number;
	ok: boolean;
	summary: string;
	stopReason?: string;
	stderr?: string;
	issues?: string[];
	aborted?: boolean;
	signal?: string;
	phase: string;
	latestToolName?: string;
	latestToolSummary?: string;
	latestAssistantText?: string;
	events: WorkerEventRecord[];
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	benchmark?: QuestBenchmarkProvenance;
}

export interface QuestTraceBundle {
	id: string;
	traceVersion: number;
	projectId: string;
	questId?: string;
	runId?: string;
	role: QuestRole;
	kind: ActiveRunKind | "planning";
	featureId?: string;
	milestoneId?: string;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	modelChoice: ModelChoice;
	ok: boolean;
	aborted: boolean;
	summary: string;
	latestToolName?: string;
	latestAssistantText?: string;
	promptSurfaceId: QuestPromptSurfaceId;
	promptSurfaceVersion: number;
	toolTimeline: QuestTraceToolEvent[];
	issues: string[];
	validatorFindings: string[];
	tags: QuestFailureTag[];
	derivedIssues: string[];
	usage?: WorkerRunRecord["usage"];
	source: "worker_run" | "planning_session";
	benchmark?: QuestBenchmarkProvenance;
}

export interface QuestEvalCase {
	id: string;
	title: string;
	description: string;
	source: QuestEvalCaseSource;
	caseType: QuestEvalCaseType;
	targetSurfaceIds: QuestPromptSurfaceId[];
	failureTags: QuestFailureTag[];
	provenance: {
		traceId?: string;
		runId?: string;
		questId?: string;
		benchmark?: QuestBenchmarkProvenance;
		createdAt: number;
	};
	input: {
		role?: QuestRole;
		tags?: QuestFailureTag[];
		issues?: string[];
		promptContains?: string[];
	};
	expectations: {
		requiredSurfaceSnippets?: string[];
		forbidSurfaceSnippets?: string[];
		requiredPolicies?: {
			preferSameModelFamily?: boolean;
			spillLongOutputsToReports?: boolean;
			maxSharedHintsAtLeast?: number;
			correctiveFeatureBudgetAtMost?: number;
		};
	};
}

export interface QuestEvalDataset {
	id: string;
	title: string;
	kind: QuestEvalDatasetKind;
	description: string;
	updatedAt: number;
	cases: QuestEvalCase[];
}

export interface QuestExperimentScore {
	datasetId: string;
	caseIds: string[];
	passed: number;
	failed: number;
	score: number;
	maxScore: number;
	findings: string[];
}

export interface QuestProfilePatch {
	promptSurfaces?: Partial<QuestPromptSurfaces>;
	toolAllowlist?: Partial<QuestRoleToolPolicy>;
	modelPolicy?: Partial<QuestModelPolicy>;
	verificationBudget?: Partial<QuestVerificationBudget>;
	contextPolicy?: Partial<QuestContextPolicy>;
	workflowHintPolicy?: Partial<QuestWorkflowHintPolicy>;
	traceGrading?: Partial<QuestTraceGradingThresholds>;
	adoptedChange?: string;
}

export interface QuestExperimentCandidate {
	id: string;
	source: "agent" | "heuristic";
	summary: string;
	rationale: string;
	generalizationNote: string;
	targetedTags: QuestFailureTag[];
	targetedCaseIds: string[];
	patch: QuestProfilePatch;
	promptSurfaceIds: QuestPromptSurfaceId[];
}

export interface QuestExperiment {
	id: string;
	projectId: string;
	target: QuestTrialTarget;
	profileId: string;
	state: QuestExperimentState;
	createdAt: number;
	updatedAt: number;
	baselineScores: QuestExperimentScore[];
	candidateScores: QuestExperimentScore[];
	spotCheckCaseIds: string[];
	heldOutCaseIds: string[];
	tracesAnalyzed: string[];
	candidate?: QuestExperimentCandidate;
	summary: string;
	failureReason?: string;
	reportFile?: string;
	changedArtifacts?: string[];
}

export interface QuestTrialState {
	projectId: string;
	target: QuestTrialTarget;
	activeProfileId: string;
	activeExperimentId?: string;
	status: QuestTrialStatus;
	lastSummary?: string;
	updatedAt: number;
}

export interface LearnedWorkflow {
	id: string;
	title: string;
	note: string;
	source: "worker_success" | "worker_failure" | "validator_failure" | "validator_success";
	createdAt: number;
	updatedAt: number;
	evidence: string[];
}

export interface QuestState {
	id: string;
	projectId: string;
	cwd: string;
	title: string;
	goal: string;
	status: QuestStatus;
	config: QuestConfig;
	defaultModel: ModelChoice;
	roleModels: Partial<Record<QuestRole, ModelChoice>>;
	plan?: QuestPlan;
	planHash?: string;
	validationReadiness?: ValidationReadiness;
	validationState?: ValidationState;
	proposalMarkdown?: string;
	servicesYaml?: string;
	planRevisions: QuestPlanRevision[];
	pendingPlanRevisionRequests: QuestPlanRevisionRequest[];
	steeringNotes: string[];
	humanQaStatus: HumanQaStatus;
	shipReadiness: ShipReadiness;
	lastSummary?: string;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	prunedAt?: number;
	activeRun?: QuestActiveRun;
	lastInterruption?: QuestInterruption;
	recentRuns: WorkerRunRecord[];
}

export interface QuestEventRecord {
	ts: number;
	type: string;
	data?: Record<string, unknown>;
}

export interface ParsedQuestPlan {
	plan: QuestPlan;
	hash: string;
}

export interface QuestStoragePaths {
	rootDir: string;
	activeFile: string;
	sharedSkillsDir: string;
	sharedWorkflowsFile: string;
	questDir: string;
	questFile: string;
	proposalFile: string;
	validationReadinessFile: string;
	validationContractFile: string;
	validationStateFile: string;
	featuresFile: string;
	servicesFile: string;
	skillsDir: string;
	eventsFile: string;
	runsDir: string;
}

export interface QuestTrialPaths {
	rootDir: string;
	stateFile: string;
	profilesDir: string;
	datasetsDir: string;
	tracesDir: string;
	experimentsDir: string;
	baselinesDir: string;
	reportsDir: string;
}
