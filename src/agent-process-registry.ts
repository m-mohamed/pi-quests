type AbortHandler = () => Promise<void>;

const activeAgentRuns = new Map<number, AbortHandler>();
let nextSyntheticPid = 1_000_000_000;

export function registerAgentRun(abort: AbortHandler): number {
	const pid = nextSyntheticPid++;
	activeAgentRuns.set(pid, abort);
	return pid;
}

export function unregisterAgentRun(pid: number | undefined): void {
	if (typeof pid !== "number") return;
	activeAgentRuns.delete(pid);
}

export function hasRegisteredAgentRun(pid: number): boolean {
	return activeAgentRuns.has(pid);
}

export async function abortRegisteredAgentRun(pid: number): Promise<boolean> {
	const abort = activeAgentRuns.get(pid);
	if (!abort) return false;
	activeAgentRuns.delete(pid);
	await abort().catch(() => {});
	return true;
}
