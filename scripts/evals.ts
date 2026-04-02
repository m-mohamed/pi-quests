import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { availableEvalSuites, runEvalSuite, type EvalSuiteId } from "../src/evals-core.js";

function parseArgs(argv: string[]): { suites: EvalSuiteId[]; jsonPath?: string } {
	const requestedSuites = new Set<EvalSuiteId>();
	let jsonPath: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--suite") {
			const value = argv[index + 1];
			if (!value) throw new Error("--suite requires a value");
			index += 1;
			if (value === "all") {
				for (const suite of availableEvalSuites()) requestedSuites.add(suite);
				continue;
			}
			if (!availableEvalSuites().includes(value as EvalSuiteId)) throw new Error(`Unknown suite: ${value}`);
			requestedSuites.add(value as EvalSuiteId);
			continue;
		}
		if (arg === "--json") {
			const value = argv[index + 1];
			if (!value) throw new Error("--json requires a file path");
			jsonPath = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return {
		suites: requestedSuites.size > 0 ? [...requestedSuites] : availableEvalSuites(),
		jsonPath,
	};
}

function printSuite(result: Awaited<ReturnType<typeof runEvalSuite>>) {
	console.log(`[${result.suite}] ${result.passed}/${result.passed + result.failed} passed (${result.score}/${result.maxScore})`);
	for (const item of result.results) {
		const status = item.passed ? "PASS" : "FAIL";
		console.log(`  ${status} ${item.id} - ${item.summary}`);
	}
}

async function maybeWriteJson(pathname: string | undefined, payload: unknown) {
	if (!pathname) return;
	const resolved = resolve(pathname);
	await mkdir(dirname(resolved), { recursive: true });
	await writeFile(`${resolved}`, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const results = [];

	for (const suite of args.suites) {
		const result = await runEvalSuite(suite);
		results.push(result);
		printSuite(result);
	}

	await maybeWriteJson(args.jsonPath, {
		generatedAt: new Date().toISOString(),
		suites: results,
	});

	const failed = results.some((result) => result.failed > 0);
	if (failed) process.exitCode = 1;
}

await main();
