from __future__ import annotations

import json
import os
import pathlib
import shlex
from pathlib import PurePosixPath

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


OUTPUT_FILE = PurePosixPath("/logs/agent/quest-headless-output.json")
STDERR_FILE = PurePosixPath("/logs/agent/quest-headless-stderr.log")
HOST_OUTPUT_FILE = "quest-headless-output.json"


class QuestInstalledAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "quest-installed"

    def version(self) -> str | None:
        return "quest-bench-v1"

    def _env(self, name: str, default: str | None = None) -> str | None:
        return self._extra_env.get(name, default)

    @staticmethod
    def _infer_task_id_from_trial_id(trial_id: str | None) -> str | None:
        if not trial_id or "__" not in trial_id:
            return None
        task_id = trial_id.split("__", 1)[0].strip()
        return task_id or None

    def _resolve_task_id(self) -> str:
        task_id = self._env("HARBOR_TASK_ID") or self._env("TASK_ID")
        if task_id:
            return task_id

        trial_id = (
            self._env("HARBOR_TRIAL_ID")
            or self._env("TRIAL_ID")
            or os.environ.get("HARBOR_TRIAL_ID")
            or os.environ.get("TRIAL_ID")
        )
        if not trial_id and self.logs_dir.name == "agent":
            trial_id = self.logs_dir.parent.name

        return self._infer_task_id_from_trial_id(trial_id) or "unknown"

    async def install(self, environment: BaseEnvironment) -> None:
        package_dir = self._env("QUEST_PACKAGE_DIR")
        if not package_dir:
            raise RuntimeError("QUEST_PACKAGE_DIR is required so Harbor can run the mounted Quest bundle.")
        node_runtime_dir = self._env("QUEST_NODE_RUNTIME_DIR", "/opt/quest-node-runtimes")
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "NEEDS_UPGRADE=false; "
                'if command -v node >/dev/null 2>&1; then '
                '  NODE_VER="$(node -e \"console.log(process.versions.major)\")"; '
                '  if [ "$NODE_VER" -lt 20 ] 2>/dev/null; then NEEDS_UPGRADE=true; fi; '
                "else NEEDS_UPGRADE=true; fi; "
                'if [ "$NEEDS_UPGRADE" = true ]; then '
                '  ARCH="$(uname -m)"; '
                '  case "$ARCH" in '
                f"    x86_64)  NODE_BIN={shlex.quote(str(PurePosixPath(node_runtime_dir) / 'node-linux-x64' / 'bin' / 'node'))} ;; "
                f"    aarch64|arm64) NODE_BIN={shlex.quote(str(PurePosixPath(node_runtime_dir) / 'node-linux-arm64' / 'bin' / 'node'))} ;; "
                "    *) echo \"Unsupported architecture: $ARCH\" >&2; exit 127 ;; "
                "  esac; "
                '  test -x "$NODE_BIN"; '
                '  ln -sf "$NODE_BIN" /usr/local/bin/node; '
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_root(
            environment,
            command=f"test -x {shlex.quote(str(PurePosixPath(package_dir) / 'node_modules' / '.bin' / 'pi'))}",
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"{shlex.quote(str(PurePosixPath(package_dir) / 'node_modules' / '.bin' / 'pi'))} --version >/dev/null && "
                f"node {shlex.quote(str(PurePosixPath(package_dir) / 'dist' / 'quest-headless.js'))} --help >/dev/null"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        package_dir = self._env("QUEST_PACKAGE_DIR", "/opt/quest-package")
        dataset = self._env("QUEST_HARBOR_DATASET", "unknown")
        run_mode = self._env("QUEST_HARBOR_RUN_MODE", "custom")
        profile_id = self._env("QUEST_HARBOR_PROFILE_ID")
        task_id = self._resolve_task_id()
        model_flag = f"--model {shlex.quote(self.model_name)} " if self.model_name else ""
        profile_flag = f"--profile {shlex.quote(profile_id)} " if profile_id else ""
        command = (
            f"node {shlex.quote(str(PurePosixPath(package_dir) / 'dist' / 'quest-headless.js'))} run "
            f"--instruction {shlex.quote(instruction)} "
            "--cwd /workspace "
            "--benchmark terminal-bench "
            f"--dataset {shlex.quote(dataset)} "
            f"--task-id {shlex.quote(task_id)} "
            f"--run-mode {shlex.quote(run_mode)} "
            f"{model_flag}"
            f"{profile_flag}"
            "--json "
            f"> {OUTPUT_FILE} 2> {STDERR_FILE}"
        )
        await self.exec_as_agent(environment, command=command)

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / HOST_OUTPUT_FILE
        if not output_file.exists():
            return
        raw_payload = output_file.read_text().strip()
        if not raw_payload:
            context.metadata = {
                **(context.metadata or {}),
                "quest_output_parse_error": "quest-headless output file was empty",
            }
            return
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError as error:
            context.metadata = {
                **(context.metadata or {}),
                "quest_output_parse_error": f"invalid quest-headless JSON: {error}",
            }
            return
        context.metadata = {
            **(context.metadata or {}),
            "quest_output": payload,
        }
