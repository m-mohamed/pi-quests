import type { QuestActiveRun, QuestFeature, QuestInterruption, QuestMilestone, QuestState } from "./types.js";

function findMilestone(quest: QuestState, milestoneId?: string): QuestMilestone | undefined {
	if (!milestoneId) return undefined;
	return quest.plan?.milestones.find((milestone) => milestone.id === milestoneId);
}

function findFeature(quest: QuestState, featureId?: string): QuestFeature | undefined {
	if (!featureId) return undefined;
	return quest.plan?.features.find((feature) => feature.id === featureId);
}

function featureLabel(feature: QuestFeature | undefined, featureId?: string): string {
	if (feature?.title) return `feature "${feature.title}"`;
	if (featureId) return `feature ${featureId}`;
	return "feature";
}

function milestoneLabel(milestone: QuestMilestone | undefined, milestoneId?: string): string {
	if (milestone?.title) return `milestone "${milestone.title}"`;
	if (milestoneId) return `milestone ${milestoneId}`;
	return "milestone";
}

export function describeActiveRun(quest: QuestState, activeRun: QuestActiveRun): string {
	const milestone = findMilestone(quest, activeRun.milestoneId);
	const feature = findFeature(quest, activeRun.featureId);

	switch (activeRun.kind) {
		case "feature":
			return `${activeRun.role} ${featureLabel(feature, activeRun.featureId)}`;
		case "validator":
			return `${activeRun.role} ${milestoneLabel(milestone, activeRun.milestoneId)}`;
		case "replan":
			return `${activeRun.role} remaining-plan revision`;
		default:
			return `${activeRun.role} run`;
	}
}

function describeInterruption(quest: QuestState, interruption: QuestInterruption): string {
	const milestone = findMilestone(quest, interruption.milestoneId);
	const feature = findFeature(quest, interruption.featureId);

	switch (interruption.kind) {
		case "feature":
			return `${interruption.role} ${featureLabel(feature, interruption.featureId)}`;
		case "validator":
			return `${interruption.role} ${milestoneLabel(milestone, interruption.milestoneId)}`;
		case "replan":
			return `${interruption.role} remaining-plan revision`;
		default:
			return `${interruption.role} run`;
	}
}

export function prepareQuestForResume(quest: QuestState): boolean {
	if (quest.status !== "aborted") return false;

	const interruption = quest.lastInterruption;
	if (interruption?.featureId) {
		const feature = findFeature(quest, interruption.featureId);
		if (feature && (feature.status === "blocked" || feature.status === "running")) {
			feature.status = "pending";
			feature.lastError = undefined;
		}
	}

	if (interruption?.milestoneId) {
		const milestone = findMilestone(quest, interruption.milestoneId);
		if (milestone && (milestone.status === "blocked" || milestone.status === "running")) {
			milestone.status = "pending";
		}
	}

	quest.status = "paused";
	quest.activeRun = undefined;
	quest.lastError = undefined;
	quest.lastSummary = interruption
		? `Resuming unfinished work after ${describeInterruption(quest, interruption)} was aborted.`
		: "Resuming unfinished work after an operator abort.";
	return true;
}

export function markQuestAborted(quest: QuestState, interruptedAt = Date.now()): string | null {
	const activeRun = quest.activeRun;
	if (!activeRun) return null;

	const feature = findFeature(quest, activeRun.featureId);
	const milestone = findMilestone(quest, activeRun.milestoneId);
	const descriptor = describeActiveRun(quest, activeRun);
	const summary = `Operator aborted ${descriptor}.`;

	activeRun.abortRequestedAt ??= interruptedAt;

	if (activeRun.kind === "feature" && feature && feature.status !== "completed") {
		feature.status = "blocked";
		feature.lastError = summary;
	}

	if (milestone && milestone.status !== "completed") {
		milestone.status = "blocked";
	}

	quest.status = "aborted";
	quest.shipReadiness = "not_ready";
	quest.lastError = summary;
	quest.lastSummary = `${summary} Use /quest resume to continue the remaining work.`;
	quest.lastInterruption = {
		reason: "operator_abort",
		role: activeRun.role,
		kind: activeRun.kind,
		featureId: activeRun.featureId,
		milestoneId: activeRun.milestoneId,
		pid: activeRun.pid,
		startedAt: activeRun.startedAt,
		interruptedAt,
		summary,
	};
	quest.activeRun = undefined;
	return summary;
}

export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateQuestProcess(pid: number): Promise<{ terminated: boolean; signal: "SIGTERM" | "SIGKILL" | null }> {
	if (!processExists(pid)) return { terminated: false, signal: null };

	const targetPid = process.platform === "win32" ? pid : -pid;
	try {
		process.kill(targetPid, "SIGTERM");
	} catch {
		return { terminated: false, signal: null };
	}

	await sleep(200);
	if (!processExists(pid)) return { terminated: true, signal: "SIGTERM" };

	try {
		process.kill(targetPid, "SIGKILL");
	} catch {
		return { terminated: !processExists(pid), signal: "SIGTERM" };
	}

	await sleep(150);
	return { terminated: !processExists(pid), signal: "SIGKILL" };
}
