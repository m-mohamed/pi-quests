import { randomUUID } from "node:crypto";
import type {
	QuestBenchmarkProvenance,
	QuestFailureTag,
	ModelChoice,
	QuestTrialTarget,
	QuestProfile,
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

function basePromptSurfaces() {
	return {
		version: PROFILE_VERSION,
		planningPolicy:
			"- Ask clarifying questions when the goal is ambiguous.\n- Define the validation contract before decomposing features.\n- Keep the orchestrator high-level and out of worker implementation detail.\n- Keep the first plan small and serial.\n- Use Quest tools to write Quest state instead of editing control artifacts manually.\n- Preserve the final human QA handoff.",
		workerPolicy:
			"- Confirm prerequisites before deep implementation.\n- Stay scoped to one feature and one success claim at a time.\n- When the repo has a fitting test harness or validation command, add or update the narrowest failing proof first.\n- Prefer the shortest proof path that satisfies the assigned feature.\n- Re-open edited outputs or generated artifacts before declaring completion.\n- If evidence contradicts the current path, re-plan inside the same turn instead of shipping provisional output.\n- After one failed setup path, pivot instead of repeating the same install or build sequence.\n- Spill long evidence into Quest artifacts instead of bloating inline summaries.\n- Do not self-approve; implement, run the smallest relevant proof, and hand off to validation.",
		validatorCodeReviewPolicy:
			"- Stay read-only and call out weak validation honestly.\n- Prefer root-cause findings over repetitive corrective work.\n- Phrase findings so the orchestrator can spawn targeted fix features.\n- Treat missing prerequisites as first-class issues.",
		validatorUserSurfacePolicy:
			"- Stay read-only and describe what remains limited.\n- Preserve the explicit human QA gate for final polish.\n- Phrase findings so the orchestrator can spawn targeted fix features.\n- Prefer concise operator-facing findings over verbose transcripts.",
		readinessPolicy:
			"- Mark unsupported surfaces as unsupported.\n- Capture prerequisites, services, and commands that affect validation confidence.\n- Note when browser or user-surface checks still require manual coverage.\n- Prefer a cheap real probe over a static guess when the repo already offers one.",
		revisionPolicy:
			"- Preserve completed work.\n- Keep the remaining plan serial by default.\n- Revise only unfinished milestones, unfinished features, and unfinished validation.\n- Translate validator findings into the smallest targeted fix features that close specific assertions.",
		proposerPolicy:
			"- This surface is maintainer-only.\n- Propose one coherent QuestProfilePatch at a time.\n- Keep changes on profile-owned surfaces only.\n- Output valid JSON only and do not mutate files.",
	};
}

function baseHarnessPolicy() {
	return {
		computationalGuides: {
			enabled: true,
			linterConfigs: ["Use the repo-native check or lint/typecheck entrypoint before promotion."],
			preCommitHooks: [
				"Preserve canonical Quest artifacts; do not add side-channel state.",
				"Archive regressions and trace evidence instead of hiding them behind summaries.",
			],
			structuralTests: [
				"Run the cheapest repo-native proof path after changing validation or automation surfaces.",
				"Prefer focused smoke checks before expensive end-to-end runs.",
			],
			archConstraints: [
				"Keep optimization changes constrained to profile-owned surfaces.",
				"Keep Quest artifacts repo-local and inspectable.",
				"Keep runtime behavior Pi-native instead of building parallel wrappers when Pi already exposes the primitive.",
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
				testRunners: ["repo-native test suite", "focused smoke or validation command for the changed surface"],
				driftDetectors: ["Quest artifact drift", "workflow guidance drift", "trace health drift"],
			},
			inferential: {
				enabled: true,
				codeReviewAgents: ["validator-code-review"],
				qualityJudges: ["targeted validator pass", "operator review for risky or low-signal edits"],
				runtimeMonitors: ["quest-headless JSON artifact validation", "trace and failure-tag drift review"],
			},
		},
		fitnessFunctions: {
			enabled: true,
			performanceRequirements: [{ metric: "quest_completion", threshold: 0.0, unit: "maximize" }],
			observabilityRequirements: [
				{ standard: "quest-headless-output", required: true },
				{ standard: "quest-artifact-state", required: true },
			],
			architectureConstraints: [
				"Quest traces remain Pi-native JSONL-derived artifacts.",
				"Quest state remains repo-local under .pi/quests/.",
			],
		},
	};
}

export function defaultQuestProfile(projectId: string, target: QuestTrialTarget = "repo"): QuestProfile {
	return {
		id: `${target}-${projectId}`,
		projectId,
		target,
		title: target === "quest-core" ? "Quest Core Profile" : "Repo Quest Profile",
		updatedAt: Date.now(),
		promptSurfaces: basePromptSurfaces(),
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
		harnessPolicy: baseHarnessPolicy(),
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
