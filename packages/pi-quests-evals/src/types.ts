export type {
	LearnedWorkflow,
	LiveRunSnapshot,
	ModelChoice,
	PiCompactionEvent,
	PiMessageContentBlock,
	PiMessageEvent,
	PiModelChangeEvent,
	PiSessionEvent,
	PiSessionInfoEvent,
	PiSessionStartEvent,
	PiSessionTrace,
	PiThinkingLevelChangeEvent,
	QuestContextPolicy,
	QuestFailureTag,
	QuestFeature,
	QuestMilestone,
	QuestModelPolicy,
	QuestPlan,
	QuestPlanRevisionRequest,
	QuestProfile,
	QuestPromptSurfaceId,
	QuestPromptSurfaces,
	QuestRoleToolPolicy,
	QuestState,
	QuestTraceGradingThresholds,
	QuestVerificationBudget,
	ThinkingLevel,
} from "@m-mohamed/pi-quests-core/types";

export type QuestEvalName = "local" | "frontierswe";
export type QuestEvalRunMode = "local" | "sample" | "full" | "custom";
export type QuestFrontierEvalFamily = "local" | "frontierswe";
export type QuestOptimizerTarget = "repo" | "quest-core";
export type QuestOptimizerStatus = "idle" | "running" | "stopped" | "blocked";
export type QuestOptimizerPhase =
	| "baseline-search"
	| "baseline-hold-out"
	| "propose"
	| "search-eval"
	| "hold-out-eval";

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

export interface QuestCandidateWorkItemResult {
	itemId: string;
	itemName: string;
	family: QuestFrontierEvalFamily;
	dataset: string;
	split: "search" | "hold-out";
	status: "passed" | "failed" | "error";
	score: number;
	maxScore?: number;
	durationMs: number;
	totalCost: number;
	modelChoice: string;
	evalDir?: string;
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
	maxScore?: number;
	meanScore: number;
	totalCost: number;
	totalDurationMs: number;
	metricKind?: string;
	metricDirection?: "maximize" | "minimize" | "target";
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
	targetedTags: import("@m-mohamed/pi-quests-core/types").QuestFailureTag[];
	promptSurfaceIds: import("@m-mohamed/pi-quests-core/types").QuestPromptSurfaceId[];
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
	failureTags: Partial<Record<import("@m-mohamed/pi-quests-core/types").QuestFailureTag, number>>;
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
	failureTags: Partial<Record<import("@m-mohamed/pi-quests-core/types").QuestFailureTag, number>>;
	topToolNames: Record<string, number>;
	sessionDurationBuckets: Array<{ label: string; count: number }>;
}

export interface QuestProfilePatch {
	promptSurfaces?: Partial<import("@m-mohamed/pi-quests-core/types").QuestPromptSurfaces>;
	toolAllowlist?: Partial<import("@m-mohamed/pi-quests-core/types").QuestRoleToolPolicy>;
	modelPolicy?: Partial<import("@m-mohamed/pi-quests-core/types").QuestModelPolicy>;
	verificationBudget?: Partial<import("@m-mohamed/pi-quests-core/types").QuestVerificationBudget>;
	contextPolicy?: Partial<import("@m-mohamed/pi-quests-core/types").QuestContextPolicy>;
	traceGrading?: Partial<import("@m-mohamed/pi-quests-core/types").QuestTraceGradingThresholds>;
	adoptedChange?: string;
}

export interface QuestExperimentCandidate {
	id: string;
	source: "agent" | "heuristic";
	summary: string;
	rationale: string;
	generalizationNote: string;
	targetedTags: import("@m-mohamed/pi-quests-core/types").QuestFailureTag[];
	targetedCaseIds: string[];
	patch: QuestProfilePatch;
	promptSurfaceIds: import("@m-mohamed/pi-quests-core/types").QuestPromptSurfaceId[];
}

export interface QuestOptimizerActiveRun {
	candidateId: string;
	phase: QuestOptimizerPhase;
	pid?: number;
	split?: "search" | "hold-out";
	startedAt: number;
}

export interface QuestOptimizerState {
	projectId: string;
	target: QuestOptimizerTarget;
	activeProfileId: string;
	storageVersion?: number;
	evalFamily?: QuestFrontierEvalFamily;
	evalDataset?: string;
	evalRunMode?: QuestEvalRunMode;
	currentCandidateId?: string;
	frontierCandidateIds?: string[];
	status: QuestOptimizerStatus;
	activeRun?: QuestOptimizerActiveRun;
	lastSummary?: string;
	updatedAt: number;
}

export interface QuestOptimizerPaths {
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
