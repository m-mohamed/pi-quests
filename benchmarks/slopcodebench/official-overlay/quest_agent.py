from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any, Literal

from pydantic import Field

from slop_code.agent_runner.agent import Agent
from slop_code.agent_runner.agent import AgentConfigBase
from slop_code.agent_runner.credentials import CredentialType
from slop_code.agent_runner.credentials import ProviderCredential
from slop_code.agent_runner.models import AgentCostLimits
from slop_code.agent_runner.models import AgentError
from slop_code.agent_runner.registry import register_agent
from slop_code.common.llms import APIPricing
from slop_code.common.llms import ModelDefinition
from slop_code.common.llms import ThinkingPreset
from slop_code.execution import Session


class QuestConfig(AgentConfigBase, agent_type="quest", register=True):
    type: Literal["quest"] = "quest"
    binary: str = "quest-headless"
    benchmark_dataset: str = "slopcodebench-official"
    run_mode: str = "full"
    timeout: int | None = 7200
    env: dict[str, str] = Field(default_factory=dict)


class QuestAgent(Agent):
    PROMPT_FILENAME = "prompt.txt"
    STDOUT_FILENAME = "stdout.json"
    STDERR_FILENAME = "stderr.log"
    RESULT_FILENAME = "quest-headless-result.json"

    def __init__(
        self,
        problem_name: str,
        verbose: bool,
        cost_limits: AgentCostLimits,
        pricing: APIPricing | None,
        credential: ProviderCredential | None,
        binary: str,
        benchmark_dataset: str,
        run_mode: str,
        timeout: int | None,
        model_spec: str,
        thinking: ThinkingPreset | None,
        env: dict[str, str],
    ) -> None:
        super().__init__(
            agent_name="quest",
            problem_name=problem_name,
            cost_limits=cost_limits,
            pricing=pricing,
            verbose=verbose,
        )
        self.credential = credential
        self.binary = binary
        self.benchmark_dataset = benchmark_dataset
        self.run_mode = run_mode
        self.timeout = timeout
        self.model_spec = model_spec
        self.thinking = thinking
        self.env = env
        self._session: Session | None = None
        self._checkpoint_index = 0
        self._last_prompt = ""
        self._last_stdout = ""
        self._last_stderr = ""
        self._last_payload: dict[str, Any] | None = None

    @classmethod
    def _from_config(
        cls,
        config: AgentConfigBase,
        model: ModelDefinition,
        credential: ProviderCredential,
        problem_name: str,
        verbose: bool,
        image: str | None,
        thinking_preset: ThinkingPreset | None = None,
        thinking_max_tokens: int | None = None,
    ) -> Agent:
        if not isinstance(config, QuestConfig):
            raise TypeError(f"Expected QuestConfig, got {type(config).__name__}")
        if thinking_max_tokens is not None:
            raise ValueError("QuestAgent does not support explicit max thinking tokens.")
        model_spec = f"{credential.provider}/{model.get_model_slug(credential.provider)}"
        return cls(
            problem_name=problem_name,
            verbose=verbose,
            cost_limits=config.cost_limits,
            pricing=model.pricing,
            credential=credential,
            binary=os.environ.get("SLOPCODEBENCH_QUEST_BIN", config.binary),
            benchmark_dataset=config.benchmark_dataset,
            run_mode=config.run_mode,
            timeout=config.timeout,
            model_spec=model_spec,
            thinking=thinking_preset,
            env=config.env,
        )

    @property
    def session(self) -> Session:
        if self._session is None:
            raise AgentError("QuestAgent has not been set up with a session.")
        return self._session

    def setup(self, session: Session) -> None:
        self._session = session

    def _command_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.update({key: str(value) for key, value in self.env.items()})
        if (
            self.credential is not None
            and self.credential.credential_type == CredentialType.ENV_VAR
        ):
            env[self.credential.destination_key] = self.credential.value
        return env

    def _command_parts(self, instruction_file: Path, checkpoint_id: str) -> list[str]:
        command = shlex.split(self.binary)
        command.extend(
            [
                "run",
                "--instruction-file",
                str(instruction_file),
                "--cwd",
                str(self.session.working_dir),
                "--benchmark",
                "slopcodebench",
                "--dataset",
                self.benchmark_dataset,
                "--task-id",
                self.problem_name,
                "--checkpoint-id",
                checkpoint_id,
                "--run-mode",
                self.run_mode,
                "--model",
                self.model_spec,
                "--json",
            ]
        )
        if self.thinking and self.thinking not in {"none", "disabled"}:
            command.extend(["--thinking", self.thinking])
        return command

    def run(self, task: str) -> None:
        self._checkpoint_index += 1
        checkpoint_id = f"checkpoint-{self._checkpoint_index}"
        prompt_path = self.session.working_dir / f".quest-{checkpoint_id}.txt"
        prompt_path.write_text(task)
        self._last_prompt = task
        self._last_payload = None
        try:
            completed = subprocess.run(
                self._command_parts(prompt_path, checkpoint_id),
                cwd=self.session.working_dir,
                env=self._command_env(),
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AgentError(f"QuestAgent timed out after {self.timeout}s") from exc
        finally:
            try:
                prompt_path.unlink(missing_ok=True)
            except OSError:
                pass

        self._last_stdout = completed.stdout
        self._last_stderr = completed.stderr
        self.usage.steps += 1

        payload_text = completed.stdout.strip()
        if payload_text:
            try:
                self._last_payload = json.loads(payload_text)
            except json.JSONDecodeError as exc:
                raise AgentError(f"QuestAgent emitted invalid JSON: {exc}") from exc

        if completed.returncode != 0:
            message = f"QuestAgent failed with exit code {completed.returncode}"
            if completed.stderr.strip():
                message = f"{message}\n{completed.stderr.strip()}"
            raise AgentError(message)

    def reset(self) -> None:
        self._last_prompt = ""
        self._last_stdout = ""
        self._last_stderr = ""
        self._last_payload = None

    def save_artifacts(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        if self._last_prompt:
            (path / self.PROMPT_FILENAME).write_text(self._last_prompt)
        (path / self.STDOUT_FILENAME).write_text(self._last_stdout)
        (path / self.STDERR_FILENAME).write_text(self._last_stderr)
        if self._last_payload is None:
            return
        (path / self.RESULT_FILENAME).write_text(
            json.dumps(self._last_payload, indent=2) + "\n"
        )
        result_file = (
            self._last_payload.get("data", {})
            .get("artifactPaths", {})
            .get("result")
        )
        if isinstance(result_file, str):
            source = Path(result_file)
            if source.exists():
                shutil.copy2(source, path / "quest-headless-output.json")

    def cleanup(self) -> None:
        self._session = None


register_agent("quest", QuestAgent)
