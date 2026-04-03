from __future__ import annotations

import json
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

    async def install(self, environment: BaseEnvironment) -> None:
        package_dir = self._env("QUEST_PACKAGE_DIR")
        if not package_dir:
            raise RuntimeError("QUEST_PACKAGE_DIR is required so Harbor can run the mounted Quest bundle.")
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                'if [ -x "/usr/bin/node" ] || command -v node >/dev/null 2>&1; then '
                '  echo "Node.js already installed"; '
                "elif ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then"
                "  apk add --no-cache nodejs;"
                " elif command -v apt-get &>/dev/null; then"
                "  apt-get update && apt-get install -y nodejs;"
                " elif command -v yum &>/dev/null; then"
                "  yum install -y nodejs;"
                " else"
                '  echo "Warning: No known package manager found, assuming node is available" >&2;'
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_root(
            environment,
            command=(
                "for bin in node; do"
                '  BIN_PATH="$(which "$bin" 2>/dev/null || true)";'
                '  if [ -n "$BIN_PATH" ] && [ "$BIN_PATH" != "/usr/local/bin/$bin" ]; then'
                '    ln -sf "$BIN_PATH" "/usr/local/bin/$bin";'
                "  fi;"
                " done"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        package_dir = self._env("QUEST_PACKAGE_DIR", "/opt/quest-package")
        dataset = self._env("QUEST_HARBOR_DATASET", "unknown")
        run_mode = self._env("QUEST_HARBOR_RUN_MODE", "custom")
        task_id = self._env("HARBOR_TASK_ID", "unknown")
        model_flag = f"--model {shlex.quote(self.model_name)} " if self.model_name else ""
        command = (
            f"node {shlex.quote(str(PurePosixPath(package_dir) / 'dist' / 'quest-headless.js'))} run "
            f"--instruction {shlex.quote(instruction)} "
            "--cwd /workspace "
            "--benchmark terminal-bench "
            f"--dataset {shlex.quote(dataset)} "
            f"--task-id {shlex.quote(task_id)} "
            f"--run-mode {shlex.quote(run_mode)} "
            f"{model_flag}"
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
