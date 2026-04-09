import { randomUUID } from "node:crypto";
import type {
	QuestBenchmarkProvenance,
	ModelChoice,
	QuestExperimentCandidate,
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
import { compact, unique } from "./utils.js";

const PROFILE_VERSION = 1;
const TRACE_VERSION = 1;

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
			proposerPolicy:
				"- Read candidate profiles, summaries, and benchmark artifacts from .pi/quests/trials/candidates/.\n- Read community trace statistics from .pi/quests/trials/community-stats.json.\n- Optimize for search-set mean score first, then lower cost, then lower duration.\n- Use hold-out results only as a regression gate, not as an overfitting target.\n- Prefer changes that improve weak behavioral tag cohorts, not one-off task ids.\n- Propose a QuestProfilePatch only on profile-owned surfaces.\n- Output valid JSON only: summary, rationale, generalizationNote, targetedTags, targetedCaseIds, promptSurfaceIds, patch.\n- Do not execute code and do not mutate files.",
		},
		toolAllowlist: {
			orchestrator: ["read", "bash"],
			worker: ["read", "bash", "edit", "write"],
			validator: ["read", "bash"],
			trial: ["read", "bash"],
			proposer: ["read", "bash", "grep"],
		},
		modelPolicy: {
			preferSameModelFamily: true,
			preferValidatorDivergence: false,
		},
		ensemblePolicy: {
			enabled: true,
			families: [
				{
					provider: "zai",
					model: "glm-5.1",
					thinkingLevel: "high",
					role: "worker",
					costPer1KInput: 0,
					costPer1KOutput: 0,
					latencyMs: 4000,
					strengths: ["zai coding plan", "good at code execution"],
					weaknesses: ["single provider dependency"],
				},
			],
			defaultWorker: "zai/glm-5.1",
			defaultValidator: "zai/glm-5.1",
			escalationThreshold: 2,
			autoEscalateOnFailure: false,
			routingRules: [],
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
		harnessPolicy: {
			computationalGuides: {
				enabled: true,
				linterConfigs: ["Use the repo-native check or lint/typecheck entrypoint before promotion."],
				preCommitHooks: ["Preserve canonical benchmark and quest artifacts; do not add side-channel state."],
				structuralTests: ["Run the benchmark-facing preflight or smoke path after changing benchmark adapters or helpers."],
				archConstraints: [
					"Keep frontier Trials as the only optimization runtime.",
					"Keep proposer edits constrained to profile-owned surfaces.",
				],
			},
			inferentialGuides: {
				enabled: true,
				agentsMdPath: "AGENTS.md",
				skillsDir: ".codex/skills",
				codeReviewAgents: ["validator-code-review"],
			},
			sensors: {
				computational: {
					enabled: true,
					linters: ["repo-native check or lint command"],
					typeCheckers: ["repo-native typecheck command"],
					testRunners: ["repo-native test suite", "benchmark preflight or smoke for benchmark-facing changes"],
					driftDetectors: ["benchmark split sourceFingerprint changes", "community corpus stats drift"],
				},
				inferential: {
					enabled: true,
					codeReviewAgents: ["validator-code-review"],
					qualityJudges: ["hold-out regression gate", "operator review for costly or low-signal edits"],
					runtimeMonitors: ["quest-headless JSON artifact validation", "benchmark smoke probe"],
				},
			},
			fitnessFunctions: {
				enabled: true,
				performanceRequirements: [
					{ metric: "meanScore", threshold: 0.0, unit: "maximize" },
					{ metric: "totalCost", threshold: 0.0, unit: "minimize" },
					{ metric: "totalDurationMs", threshold: 0.0, unit: "minimize" },
				],
				observabilityRequirements: [
					{ standard: "quest-headless-output", required: true },
					{ standard: "candidate-archive-artifacts", required: true },
				],
				architectureConstraints: [
					"Community traces remain Pi-native JSONL.",
					"Benchmark adapters share the canonical candidate archive and frontier gate.",
				],
			},
		},
		adoptedChanges: [],
	};
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
			proposer: profile.toolAllowlist?.proposer ?? base.toolAllowlist.proposer,
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
		case "proposer":
			return profile.promptSurfaces.proposerPolicy;
	}
}

export function promptSurfaceForRun(role: QuestRole, kind: QuestTraceBundle["kind"], phase: string): QuestPromptSurfaceId {
	if (role === "worker" && kind === "feature") return "feature-worker";
	if (role === "validator" && phase === "user_surface") return "validator-user-surface";
	if (role === "validator" && kind === "readiness") return "readiness-probe";
	if (role === "orchestrator" && (kind === "replan" || phase === "replanning")) return "plan-revision";
	if (role === "proposer") return "proposer";
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
		diagnostics: [],
		compactionEvents: [],
		cancellationReason: run.aborted === true ? "user_abort" : undefined,
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
		diagnostics: [],
		compactionEvents: [],
		cancellationReason: undefined,
		source: "planning_session",
		benchmark,
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
				proposer: patch.toolAllowlist?.proposer ?? profile.toolAllowlist.proposer,
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
