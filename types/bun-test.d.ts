declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function beforeEach(fn: () => void | Promise<void>): void;
	export function afterEach(fn: () => void | Promise<void>): void;
	export function expect<T>(value: T): {
		toBe(expected: unknown): void;
		toContain(expected: unknown): void;
		toHaveLength(expected: number): void;
		toBeGreaterThan(expected: number): void;
		toBeUndefined(): void;
		toEqual(expected: unknown): void;
		not: {
			toBeNull(): void;
		};
	};
}

declare const Bun: {
	file(path: string): {
		text(): Promise<string>;
		exists(): Promise<boolean>;
	};
};
