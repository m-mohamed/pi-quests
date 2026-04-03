declare module "@mariozechner/pi-tui" {
	export class Text {
		constructor(text: string, x?: number, y?: number);
		render(width: number): string[];
	}

	export const Key: {
		escape: string;
		tab: string;
		right: string;
		left: string;
		down: string;
		up: string;
		shift(key: string): string;
	};

	export function matchesKey(data: string, key: string): boolean;
}
