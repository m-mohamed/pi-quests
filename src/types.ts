export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type QuestStatus = "planning" | "proposal_ready" | "running" | "paused" | "blocked" | "completed" | "aborted";
export type FeatureStatus = "pending" | "running" | "completed" | "blocked" | "skipped";
export type MilestoneStatus = "pending" | "running" | "completed" | "blocked";
export type QuestRole = "orchestrator" | "worker" | "validator";
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
