import { randomUUID } from "node:crypto";
import {
	defaultQuestProfile,
	normalizeQuestProfile,
} from "./profile-core.js";
import type {
	QuestExperimentCandidate,
	QuestFailureTag,
	QuestProfile,
	QuestProfilePatch,
	QuestPromptSurfaceId,
	QuestTrialTarget,
} from "./types.js";

function mergePromptSurfaces(profile: QuestProfile): QuestProfile["promptSurfaces"] {
	return {
		...profile.promptSurfaces,
		planningPolicy: `${profile.promptSurfaces.planningPolicy}\n- Prefer tagged eval cohorts and cheap real probes over anecdotal debugging when shaping benchmark work.`,
		workerPolicy: `${profile.promptSurfaces.workerPolicy}\n- For benchmark work, classify unseen tasks quickly by modality: media/binary, Git recovery, build/install, local service, data/science, archive/recovery, or precise text transform.\n- Re-open named benchmark outputs before finishing and confirm one final submission is actually ready.\n- After benchmark-facing changes, run the cheapest real Harbor smoke that exercises the edited surface before expensive sample runs.`,
		readinessPolicy: `${profile.promptSurfaces.readinessPolicy}\n- Prefer real cheap probes over static guesses when a benchmark-facing path changed.`,
		proposerPolicy:
			"- Read candidate profiles, summaries, and benchmark artifacts from .pi/quests/trials/candidates/.\n- Read community trace statistics from .pi/quests/trials/community-stats.json.\n- Treat tagged benchmark splits and mined community traces as the training data for harness engineering.\n- Optimize for search-set mean score first, then lower cost, then lower duration.\n- Use hold-out results only as a regression gate and generalization check, not as an overfitting target.\n- Use benchmark failure-category mixes to target concrete break modes, not just pass-rate deltas.\n- Prefer changes that improve weak behavioral tag cohorts, not one-off task ids.\n- Propose one coherent harness/profile change per candidate unless two surface edits are inseparable.\n- Protect already-passing cohorts; use new regressions as next-iteration input instead of accepting silent backslides.\n- Propose a QuestProfilePatch only on profile-owned surfaces.\n- Output valid JSON only: summary, rationale, generalizationNote, targetedTags, targetedCaseIds, promptSurfaceIds, patch.\n- Do not execute code and do not mutate files.",
	};
}

function withInternalDefaults(profile: QuestProfile): QuestProfile {
	return {
		...profile,
		promptSurfaces: mergePromptSurfaces(profile),
	};
}

export function defaultInternalQuestProfile(projectId: string, target: QuestTrialTarget = "repo"): QuestProfile {
	return withInternalDefaults(defaultQuestProfile(projectId, target));
}

export function normalizeInternalQuestProfile(
	profile: Partial<QuestProfile> | null | undefined,
	projectId: string,
	target: QuestTrialTarget = "repo",
): QuestProfile {
	return withInternalDefaults(normalizeQuestProfile(profile, projectId, target));
}

export function applyQuestProfilePatch(profile: QuestProfile, patch: QuestProfilePatch): QuestProfile {
	return normalizeInternalQuestProfile(
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
				proposer: patch.toolAllowlist?.proposer ?? profile.toolAllowlist.proposer,
			},
			modelPolicy: { ...profile.modelPolicy, ...patch.modelPolicy },
			verificationBudget: { ...profile.verificationBudget, ...patch.verificationBudget },
			contextPolicy: { ...profile.contextPolicy, ...patch.contextPolicy },
			traceGrading: { ...profile.traceGrading, ...patch.traceGrading },
			adoptedChanges: patch.adoptedChange ? [...profile.adoptedChanges, patch.adoptedChange] : profile.adoptedChanges,
			updatedAt: Date.now(),
		},
		profile.projectId,
		profile.target,
	);
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
