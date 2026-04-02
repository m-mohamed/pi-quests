# Pi Quests

Private personal Pi extension for validation-first quest planning and execution.

Canonical source repo:

- `/Users/mohamedmohamed/research/pi-quests`

Live deployed extension path:

- `~/.pi/agent/extensions/pi-quests -> /Users/mohamedmohamed/research/pi-quests`

## What It Does

- `/quest <goal>` starts quest planning in the current repo
- `/mission <goal>` remains available as a compatibility alias, but `quest` is now the canonical surface
- planning stays in the main Pi session
- the approved quest proposal now includes:
  - quest summary
  - milestones
  - features
  - a first-class validation contract
  - explicit role/model assignments from quest state
- `/quest start` and `/quest resume` execute one milestone at a time
- `/quest approve` records the final human QA acknowledgment after validation passes
- worker and validator runs happen in isolated `pi --mode json --no-session` subprocesses
- Quest Control now streams child worker telemetry into the widget/status surface
- `/quest steer <instruction>` queues a remaining-plan revision instead of silently changing scope
- `/quest model` and `/quest role-model <role>` keep model choice explicit
- `/quest prune` prunes old quest runtime logs

## Lifecycle

1. `/quest <goal>` creates a quest proposal in the current Pi session.
2. Pi collaborates on the proposal and emits machine-readable JSON.
3. The proposal is stored privately and marked `ready`.
4. `/quest start` is the approval boundary.
5. `/quest resume` continues milestone-by-milestone.
6. Completion means the quest has been validated and is ready for human QA.
7. `/quest approve` is the explicit human QA acknowledgment step.

Quest completion does not mean "safe to ship blindly."

## Design

This extension is intentionally:

- private
- auto-discovered from `~/.pi/agent/extensions/`
- hot-reloadable with `/reload`
- modeled on Pi's extension surface instead of modifying Pi core
- explicit about models, reasoning, and validation confidence

This extension intentionally does not:

- write quest state into the repos you work on
- auto-route models with hidden heuristics
- depend on Pi packages, presets, or keybinding overrides
- use raw `agent.subscribe(...)` inside the extension
- aim for Factory parity, remote background agents, or package publication in the current tranche

## State

Private quest state lives under:

- `~/.pi/agent/quests/<project-id>/<quest-id>/quest.json`
- `~/.pi/agent/quests/<project-id>/<quest-id>/events.jsonl`
- `~/.pi/agent/quests/<project-id>/<quest-id>/workers/*.json`

Project-scoped learned workflows live under:

- `~/.pi/agent/quests/projects/<project-id>/workflows/learned-workflows.json`

Learned workflows are private by default and never written into the target repo automatically.

Legacy compatibility:

- old `~/.pi/agent/missions/.../mission.json` state is still read automatically
- old `/mission` and `/missions` commands forward to the new quest surface
- new writes go to the canonical `~/.pi/agent/quests/` root

## Validation Contract

Each proposal stores a validation contract that maps:

- milestone -> expected user-visible or system behavior
- feature -> validation criteria
- criterion -> proof strategy and confidence

If the contract is weak, the quest says so explicitly. Weak validation lowers confidence even when a quest completes.

## Model Policy

- one quest-level default `provider/model/thinking`
- optional overrides for `orchestrator`, `worker`, and `validator`
- no hidden routing

Working defaults:

- Codex lane: `gpt-5.4` default, `gpt-5.4-mini` fast, `high` normal, `xhigh` only when chosen
- OpenCode Go lane: `glm-5`, `kimi-k2.5`, `minimax-m2.7`, up to `high`

## Development

The extension is structured like a small standalone project even though the deployed copy lives under `~/.pi/agent/extensions/`.

Included support files:

- `CHANGELOG.md`
- `LICENSE`
- `tests/`
- `scripts/smoke.ts`

Local verification:

```bash
bun test
bun run scripts/smoke.ts
bun run verify
```

Interactive verification checklist:

- `/reload`
- `/quest status`
- `/quest model`
- `/quest role-model worker`
- `/quest role-model validator`
- `/quest approve`
- create a quest, review the proposal, then `/quest start`
- verify Quest Control updates live while a worker or validator is running

## Compatibility

Targeted against Pi `0.64.x`.

The smoke script checks the installed `pi --version` and fails if it is not on the `0.64.x` line, so compatibility drift is visible immediately.
