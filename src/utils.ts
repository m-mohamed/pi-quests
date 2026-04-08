export function compact(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

export function truncate(text: string | undefined, max: number): string {
	if (!text) return "";
	const c = compact(text);
	if (c.length <= max) return c;
	return `${c.slice(0, max - 1)}…`;
}