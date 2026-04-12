import { inspectHarborInstallation } from "../../src/harbor-integrity.js";

async function main() {
	const report = await inspectHarborInstallation();
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = report.ok ? 0 : 1;
}

await main();
