export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type QuestStatus = "planning" | "proposal_ready" | "running" | "paused" | "blocked" | "completed" | "aborted";
export type FeatureStatus = "pending" | "running" | "completed" | "blocked" | "skipped";
export type MilestoneStatus = "pending" | "running" | "completed" | "blocked";
export type QuestRole = "orchestrator" | "worker" | "validator" | "trial" | "proposer";
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
export type QuestTrialPhase =
	| "baseline-search"
	| "baseline-hold-out"
	| "propose"
	| "search-eval"
	| "hold-out-eval";
export type QuestPromptSurfaceId =
	| "planning"
	| "feature-worker"
	| "validator-code-review"
	| "validator-user-surface"
	| "readiness-probe"
	| "plan-revision"
	| "proposer";
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

export type PiKnownSessionEventType =
	| "session"
	| "session_info"
	| "model_change"
	| "thinking_level_change"
	| "message"
	| "compaction"
	| "custom"
	| "custom_message"
	| "label"
	| "branch_summary";
export type PiSessionEventType = PiKnownSessionEventType | (string & {});

export interface PiSessionEvent {
	type: PiSessionEventType;
	id?: string;
	parentId?: string | null;
	timestamp: string;
	[key: string]: unknown;
}

export interface PiSessionStartEvent extends PiSessionEvent {
	type: "session";
	version?: number;
	cwd: string;
}

export interface PiSessionInfoEvent extends PiSessionEvent {
	type: "session_info";
	config?: Record<string, unknown>;
	name?: string;
	skills?: string[];
	[key: string]: unknown;
}

export interface PiModelChangeEvent extends PiSessionEvent {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface PiThinkingLevelChangeEvent extends PiSessionEvent {
	type: "thinking_level_change";
	thinkingLevel: ThinkingLevel;
}

export interface PiMessageContentBlock {
	type: "text" | "toolCall" | "thinking";
	text?: string;
	name?: string;
	arguments?: Record<string, unknown> | string;
	thinking?: string;
	thinkingSignature?: string;
	partialJson?: string;
	[key: string]: unknown;
}

export interface PiMessageEvent extends PiSessionEvent {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content: PiMessageContentBlock[];
		timestamp?: number;
		api?: string;
		provider?: string;
		model?: string;
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				total: number;
			};
		};
		stopReason?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

export interface PiCompactionEvent extends PiSessionEvent {
	type: "compaction";
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	details?: Record<string, unknown>;
	fromHook?: boolean;
	originalTokens?: number;
	compactedTokens?: number;
	strategy?: string;
}

export interface PiSessionTrace {
	id: string;
	sourcePath: string;
	version?: number;
	cwd: string;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	events: PiSessionEvent[];
	modelChanges: Array<{ provider: string; modelId: string; timestamp: string }>;
	thinkingLevelChanges: Array<{ thinkingLevel: ThinkingLevel; timestamp: string }>;
	compactions: Array<{
		timestamp: string;
		summary?: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
		tokensAfter?: number;
		fromHook?: boolean;
		details?: Record<string, unknown>;
	}>;
	messageCount: number;
	toolCallCount: number;
	errorCount: number;
	usage: {
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalCost: number;
		turnCount: number;
	};
	derivedTags: QuestFailureTag[];
	derivedIssues: string[];
}
export type QuestEvalName = "local" | "frontierswe";
export type QuestEvalRunMode = "local" | "sample" | "full" | "custom";
export type QuestFrontierEvalFamily = "local" | "frontierswe";

export interface QuestEvalProvenance {
	name: QuestEvalName;
	dataset: string;
	taskId: string;
	checkpointId?: string;
	runMode: QuestEvalRunMode;
	adapterVersion: string;
	recordedAt: number;
	model?: string;
	passed?: boolean;
	score?: number;
}

export interface QuestEvalWorkItem {
	id: string;
	name: string;
	family: QuestFrontierEvalFamily;
	dataset: string;
	path?: string;
	tags: string[];
	metadata?: Record<string, unknown>;
}

export interface QuestEvalManifest {
	id: string;
	family: QuestFrontierEvalFamily;
	dataset: string;
	runMode: QuestEvalRunMode;
	createdAt: number;
	totalItems: number;
	seed?: number;
	source: "vendored" | "registry" | "generated" | "discovered";
	sourceFingerprint: string;
	items: QuestEvalWorkItem[];
	tagSummary: Record<string, number>;
	notes?: string[];
}

export interface QuestEvalSplit {
	id: string;
	family: QuestFrontierEvalFamily;
	dataset: string;
	split: "search" | "hold-out";
	createdAt: number;
	seed: number;
	sourceManifestId: string;
	sourceFingerprint: string;
	totalItems: number;
	items: QuestEvalWorkItem[];
	tagSummary: Record<string, number>;
	notes?: string[];
}

export interface QuestCandidateTagMetrics {
	itemCount: number;
	passed: number;
	totalScore: number;
	meanScore: number;
	totalCost: number;
	totalDurationMs: number;
}

export interface QuestPromptSurfaces {
	version: number;
	planningPolicy: string;
	workerPolicy: string;
	validatorCodeReviewPolicy: string;
	validatorUserSurfacePolicy: string;
	readinessPolicy: string;
	revisionPolicy: string;
	proposerPolicy: string;
}

export interface QuestRoleToolPolicy {
	orchestrator: string[];
	worker: string[];
	validator: string[];
	proposer: string[];
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
	sourceInfo?: QuestSourceInfo;
	compactionContext?: {
		tokensBefore: number;
		tokensAfter: number;
		droppedMessages: number;
	};
}

export interface QuestSourceInfo {
	path: string;
	scope: "builtin" | "extension" | "skill" | "user" | "project";
	source: "builtin" | "package" | "extension" | "cli" | "user" | "project";
}

export type QuestDiagnosticSeverity = "info" | "warning" | "error";

export interface QuestDiagnostic {
	severity: QuestDiagnosticSeverity;
	source: string;
	message: string;
	timestamp: number;
}

export type QuestCancellationReason = "user_abort" | "timeout" | "error" | "context_overflow" | "completed" | "signal";

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
	sessionId?: string;
	sessionFile?: string;
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
	evaluation?: QuestEvalProvenance;
}

export interface QuestTraceBundle {
	id: string;
	traceVersion: number;
	projectId: string;
	questId?: string;
	runId?: string;
	sessionId?: string;
	sessionFile?: string;
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
	diagnostics: QuestDiagnostic[];
	compactionEvents: Array<{
		timestamp: number;
		tokensBefore: number;
		tokensAfter: number;
		droppedMessages: number;
		reason: string;
	}>;
	cancellationReason?: QuestCancellationReason;
	usage?: WorkerRunRecord["usage"];
	source: "worker_run" | "planning_session";
	evaluation?: QuestEvalProvenance;
}

export interface QuestCandidateWorkItemResult {
	itemId: string;
	itemName: string;
	family: QuestFrontierEvalFamily;
	dataset: string;
	split: "search" | "hold-out";
	status: "passed" | "failed" | "error";
	score: number;
	maxScore: number;
	durationMs: number;
	totalCost: number;
	modelChoice: string;
	trialDir?: string;
	questOutputFile?: string;
	artifactPaths: string[];
	failureReason?: string;
	rewardValues?: Record<string, number>;
	evalMetrics?: Record<string, unknown>;
	evaluation?: QuestEvalProvenance;
}

export interface QuestCandidateScorecard {
	family: QuestFrontierEvalFamily;
	split: "search" | "hold-out";
	dataset: string;
	generatedAt: number;
	itemCount: number;
	passed: number;
	failed: number;
	totalScore: number;
	maxScore: number;
	meanScore: number;
	totalCost: number;
	totalDurationMs: number;
	tagBreakdown?: Record<string, QuestCandidateTagMetrics>;
	evalMetrics?: Record<string, unknown>;
	items: QuestCandidateWorkItemResult[];
}

export interface QuestCandidateSummary {
	candidateId: string;
	profileId: string;
	createdAt: number;
	source: "baseline" | "proposer";
	status: "accepted" | "rejected" | "frontier" | "archived" | "partial" | "failed";
	summary: string;
	rationale: string;
	generalizationNote?: string;
	targetedTags: QuestFailureTag[];
	promptSurfaceIds: QuestPromptSurfaceId[];
	searchScore?: QuestCandidateScorecard;
	holdOutScore?: QuestCandidateScorecard;
	paretoOptimal: boolean;
	frontierRank?: number;
	failureReason?: string;
}

export interface QuestFrontierState {
	generatedAt: number;
	leaderCandidateId?: string;
	frontierCandidateIds: string[];
}

export interface CommunitySourceStats {
	sourceId: string;
	sessionCount: number;
	parsedSessions: number;
	failedSessions: number;
	failedPaths: string[];
	models: Record<string, number>;
	providers: Record<string, number>;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	totalDurationMs: number;
	totalToolCalls: number;
	totalErrors: number;
	totalMessages: number;
	failureTags: Partial<Record<QuestFailureTag, number>>;
}

export interface CommunityStats {
	generatedAt: number;
	totalFiles: number;
	totalSessions: number;
	parsedSessions: number;
	failedSessions: number;
	failedPaths: string[];
	sources: Record<string, CommunitySourceStats>;
	models: Record<string, number>;
	providers: Record<string, number>;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	avgDurationMs: number;
	avgToolCalls: number;
	avgErrors: number;
	avgMessages: number;
	failureTags: Partial<Record<QuestFailureTag, number>>;
	topToolNames: Record<string, number>;
	sessionDurationBuckets: Array<{ label: string; count: number }>;
}

export interface QuestProfilePatch {
	promptSurfaces?: Partial<QuestPromptSurfaces>;
	toolAllowlist?: Partial<QuestRoleToolPolicy>;
	modelPolicy?: Partial<QuestModelPolicy>;
	verificationBudget?: Partial<QuestVerificationBudget>;
	contextPolicy?: Partial<QuestContextPolicy>;
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

export interface QuestTrialActiveRun {
	candidateId: string;
	phase: QuestTrialPhase;
	pid?: number;
	split?: "search" | "hold-out";
	startedAt: number;
}

export interface QuestTrialState {
	projectId: string;
	target: QuestTrialTarget;
	activeProfileId: string;
	storageVersion?: number;
	evalFamily?: QuestFrontierEvalFamily;
	evalDataset?: string;
	evalRunMode?: QuestEvalRunMode;
	currentCandidateId?: string;
	frontierCandidateIds?: string[];
	status: QuestTrialStatus;
	activeRun?: QuestTrialActiveRun;
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
	currentDir: string;
	currentProfileFile: string;
	candidatesDir: string;
	searchSetFile: string;
	holdOutSetFile: string;
	frontierFile: string;
	communityStatsFile: string;
	communityTracesDir: string;
	profilesDir: string;
}

export interface QuestTelemetryPaths {
	rootDir: string;
	tracesDir: string;
}
