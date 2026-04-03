export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type QuestStatus = "planning" | "ready" | "running" | "paused" | "completed" | "failed" | "aborted";
export type FeatureStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
export type MilestoneStatus = "pending" | "running" | "completed" | "failed" | "blocked";
export type QuestRole = "orchestrator" | "worker" | "validator";
export type HumanQaStatus = "pending" | "approved";
export type ShipReadiness = "not_ready" | "validated_waiting_for_human_qa" | "human_qa_complete";
export type ValidationProofStrategy = "browser" | "command" | "read_only" | "manual" | "mixed";
export type ValidationConfidence = "high" | "medium" | "low";
export type ActiveRunKind = "feature" | "validator" | "replan";

export interface ModelChoice {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

export interface QuestFeature {
	id: string;
	title: string;
	summary: string;
	milestoneId: string;
	acceptanceCriteria: string[];
	workerPrompt?: string;
	status: FeatureStatus;
	lastRunSummary?: string;
	lastError?: string;
}

export interface QuestMilestone {
	id: string;
	title: string;
	summary: string;
	successCriteria: string[];
	validationPrompt?: string;
	status: MilestoneStatus;
}

export interface QuestValidationMilestoneExpectation {
	milestoneId: string;
	title: string;
	expectedBehaviors: string[];
}

export interface QuestValidationFeatureCheck {
	featureId: string;
	title: string;
	criterionIds: string[];
}

export interface QuestValidationCriterion {
	id: string;
	title: string;
	milestoneId: string;
	featureIds: string[];
	expectedBehavior: string;
	proofStrategy: ValidationProofStrategy;
	proofDetails: string;
	commands: string[];
	confidence: ValidationConfidence;
}

export interface QuestValidationContract {
	summary: string;
	milestoneExpectations: QuestValidationMilestoneExpectation[];
	featureChecks: QuestValidationFeatureCheck[];
	criteria: QuestValidationCriterion[];
	weakValidationWarnings: string[];
}

export interface QuestPlan {
	title: string;
	summary: string;
	successCriteria: string[];
	features: QuestFeature[];
	milestones: QuestMilestone[];
	validationContract: QuestValidationContract;
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
	defaultModel: ModelChoice;
	roleModels: Partial<Record<QuestRole, ModelChoice>>;
	plan?: QuestPlan;
	planHash?: string;
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
	projectDir: string;
	activeFile: string;
	questDir: string;
	questFile: string;
	eventsFile: string;
	workersDir: string;
	projectMetadataRoot: string;
	projectMetadataDir: string;
	projectWorkflowsDir: string;
	projectWorkflowsFile: string;
}
