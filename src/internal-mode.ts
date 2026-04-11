export const QUESTS_INTERNAL_ENV = "PI_QUESTS_INTERNAL";

export function internalModeEnabled(): boolean {
	return process.env[QUESTS_INTERNAL_ENV] === "1";
}

export function assertInternalMode(surface: string): void {
	if (internalModeEnabled()) return;
	throw new Error(`${surface} is maintainer-only. Set ${QUESTS_INTERNAL_ENV}=1 to enable it in this repo.`);
}
