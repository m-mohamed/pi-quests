declare module "node:crypto" {
	export function createHash(algorithm: string): {
		update(value: string): {
			digest(encoding: string): string;
		};
	};
	export function randomUUID(): string;
}

declare module "node:child_process" {
	interface StreamLike {
		on(event: "data", listener: (data: any) => void): void;
	}

	export interface ChildProcess {
		pid?: number;
		stdout: StreamLike;
		stderr: StreamLike;
		kill(signal?: string): boolean;
		unref(): void;
		on(event: "close", listener: (code: number | null, signal?: string | null) => void): void;
		on(event: "error", listener: (error: unknown) => void): void;
	}

	export function spawn(command: string, args?: string[], options?: Record<string, unknown>): ChildProcess;
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
}

declare module "node:fs/promises" {
	export function access(path: string): Promise<void>;
	export function cp(source: string, destination: string, options?: Record<string, unknown>): Promise<void>;
	export function mkdir(path: string, options?: Record<string, unknown>): Promise<void>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function readFile(path: string, encoding: string): Promise<string>;
	export function readdir(path: string, options?: Record<string, unknown>): Promise<any[]>;
	export function realpath(path: string): Promise<string>;
	export function rm(path: string, options?: Record<string, unknown>): Promise<void>;
	export function stat(path: string): Promise<{ mtimeMs: number }>;
	export function symlink(target: string, path: string, type?: string): Promise<void>;
	export function unlink(path: string): Promise<void>;
	export function writeFile(path: string, data: string, options?: Record<string, unknown> | string): Promise<void>;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function basename(path: string): string;
	export function dirname(path: string): string;
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
}

declare module "node:url" {
	export function fileURLToPath(url: string | { href?: string }): string;
}

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	execPath: string;
	exitCode?: number;
	pid: number;
	platform: string;
	kill(pid: number, signal?: string | number): void;
};

declare function setTimeout(handler: (...args: any[]) => void, timeout: number): unknown;
declare function clearTimeout(timeout: unknown): void;
declare function setInterval(handler: (...args: any[]) => void, timeout: number): unknown;
declare function clearInterval(timeout: unknown): void;

declare const console: {
	log(message?: unknown, ...optionalParams: unknown[]): void;
};

interface ImportMeta {
	url: string;
}
