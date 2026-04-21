import type { LiveRunSnapshot } from "@m-mohamed/pi-quests-core/types";

export function summarizeEvals(summary: string, optimizerLiveRun: LiveRunSnapshot | null): string {
	return `# Evals

${summary}

Active optimizer run:
${
		optimizerLiveRun
			? `${optimizerLiveRun.role}/${optimizerLiveRun.phase}${optimizerLiveRun.latestToolName ? ` · ${optimizerLiveRun.latestToolName}` : ""}${optimizerLiveRun.latestMessage ? ` · ${optimizerLiveRun.latestMessage.slice(0, 80)}` : ""}`
			: "idle"
	}`;
}
