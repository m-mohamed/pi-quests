import { spawn } from "node:child_process";
import { resolveHarborRuntime } from "./harbor-runtime.js";

export interface HarborIntegrityEvidence {
	harborVersion?: string;
	harborPath?: string;
	pythonPath?: string;
	trialExecuteAgentSource: string;
	trialRunVerificationSource: string;
	verifierVerifySource: string;
}

export interface HarborIntegrityIssue {
	code: string;
	detail: string;
}

export interface HarborIntegrityReport {
	ok: boolean;
	summary: string;
	harborVersion?: string;
	harborPath?: string;
	pythonPath?: string;
	issues: HarborIntegrityIssue[];
	evidence: {
		sharedPhaseEnvironment: boolean;
		restoresOnlyTestsDir: boolean;
		executesVerifierInsideSharedEnvironment: boolean;
	};
}

let harborIntegrityPromise: Promise<HarborIntegrityReport> | null = null;

function joinIssueDetails(issues: HarborIntegrityIssue[]): string {
	return issues.map((issue) => `${issue.code}: ${issue.detail}`).join(" ");
}

export function evaluateHarborIntegrity(evidence: HarborIntegrityEvidence): HarborIntegrityReport {
	const sharedPhaseEnvironment =
		evidence.trialExecuteAgentSource.includes("environment=self._environment")
		&& evidence.verifierVerifySource.includes("self._environment");
	const restoresOnlyTestsDir =
		evidence.verifierVerifySource.includes("source_dir=self._task.paths.tests_dir")
		&& evidence.verifierVerifySource.includes('target_dir="/tests"');
	const executesVerifierInsideSharedEnvironment =
		evidence.verifierVerifySource.includes("self._environment.exec(")
		&& evidence.verifierVerifySource.includes("test_script_path");
	const issues: HarborIntegrityIssue[] = [];
	if (sharedPhaseEnvironment) {
		issues.push({
			code: "shared_phase_environment",
			detail: "Harbor reuses the same mutable environment across the agent and verifier phases.",
		});
	}
	if (sharedPhaseEnvironment && restoresOnlyTestsDir && executesVerifierInsideSharedEnvironment) {
		issues.push({
			code: "mutable_system_state_survives_verification",
			detail:
				"Harbor restores /tests and then runs the verifier inside the already-mutated environment, so PATH-critical tools or system binaries can survive into scoring.",
		});
	}
	const versionLabel = evidence.harborVersion ? `Harbor ${evidence.harborVersion}` : "Harbor";
	return {
		ok: issues.length === 0,
		summary: issues.length === 0
			? `${versionLabel} passed the local benchmark integrity probe.`
			: `${versionLabel} failed the local benchmark integrity probe. ${joinIssueDetails(issues)}`,
		harborVersion: evidence.harborVersion,
		harborPath: evidence.harborPath,
		pythonPath: evidence.pythonPath,
		issues,
		evidence: {
			sharedPhaseEnvironment,
			restoresOnlyTestsDir,
			executesVerifierInsideSharedEnvironment,
		},
	};
}

export async function inspectHarborInstallation(): Promise<HarborIntegrityReport> {
	if (harborIntegrityPromise) return harborIntegrityPromise;
	harborIntegrityPromise = (async () => {
		try {
			const { harborPath, pythonPath } = await resolveHarborRuntime();
			const script = `
import inspect
import json
from importlib.metadata import version
from harbor.trial.trial import Trial
from harbor.verifier.verifier import Verifier

def safe_source(obj):
    try:
        return inspect.getsource(obj)
    except Exception:
        return ""

print(json.dumps({
    "harborVersion": version("harbor"),
    "trialExecuteAgentSource": safe_source(Trial._execute_agent),
    "trialRunVerificationSource": safe_source(Trial._run_verification),
    "verifierVerifySource": safe_source(Verifier.verify),
}))
`;
			const stdout = await new Promise<string>((resolvePromise, reject) => {
				const proc = spawn(pythonPath, ["-c", script], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let output = "";
				let stderr = "";
				proc.stdout.on("data", (chunk) => {
					output += String(chunk);
				});
				proc.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				proc.on("close", (code) => {
					if ((code ?? 1) === 0) {
						resolvePromise(output);
						return;
					}
					reject(new Error(stderr || `Harbor integrity probe exited with code ${code ?? 1}.`));
				});
				proc.on("error", reject);
			});
			const payload = JSON.parse(stdout) as {
				harborVersion?: string;
				trialExecuteAgentSource?: string;
				trialRunVerificationSource?: string;
				verifierVerifySource?: string;
			};
			return evaluateHarborIntegrity({
				harborVersion: payload.harborVersion,
				harborPath,
				pythonPath,
				trialExecuteAgentSource: payload.trialExecuteAgentSource ?? "",
				trialRunVerificationSource: payload.trialRunVerificationSource ?? "",
				verifierVerifySource: payload.verifierVerifySource ?? "",
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				summary: `Harbor integrity probe failed closed. ${detail}`,
				issues: [{ code: "integrity_probe_failed", detail }],
				evidence: {
					sharedPhaseEnvironment: false,
					restoresOnlyTestsDir: false,
					executesVerifierInsideSharedEnvironment: false,
				},
			};
		}
	})();
	return harborIntegrityPromise;
}
