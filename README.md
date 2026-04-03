# Pi Quests

Private personal Pi extension for validation-first quest planning and execution.

Canonical source repo:

- `/Users/mohamedmohamed/research/pi-quests`

Live deployed extension path:

- `~/.pi/agent/extensions/pi-quests -> /Users/mohamedmohamed/research/pi-quests`

## What It Does

- `/enter-quest` enters quest mode for conversational planning and steering
- `/exit-quest` leaves quest mode and restores normal Pi input handling
- `/quest` opens Quest Control for the active quest
- `/quests` lists and selects quests for the current repo
- `/quest new <goal>` is the explicit non-interactive quest creation path
- planning stays in the main Pi session
- the approved quest proposal now includes:
  - quest summary
  - milestones
  - features
  - a first-class validation contract
  - explicit role/model assignments from quest state
 - `/quest accept` and `/quest resume` execute one milestone at a time
 - `/quest abort` explicitly interrupts an active worker, validator, or replan run
 - `/quest approve` records the final human QA acknowledgment after validation passes
- worker and validator runs happen in isolated `pi --mode json --no-session` subprocesses
- Quest Control now streams child worker telemetry into the widget/status surface
- `/quest steer <instruction>` queues a remaining-plan revision instead of silently changing scope
- `/quest model` and `/quest role-model <role>` keep model choice explicit
- `/quest prune` prunes old quest runtime logs
- `/quest pause` is only a checkpoint hold for idle or already-paused quests

## Lifecycle

1. `/enter-quest` enables conversational quest mode in the current Pi session.
2. Plain-text input creates or refines the active quest proposal.
3. The proposal is stored privately and marked `ready`.
4. `/quest accept` is the approval boundary.
5. `/quest resume` continues milestone-by-milestone.
6. `/quest abort` is the active interruption path while a child run is in flight.
7. Completion means the quest has been validated and is ready for human QA.
8. `/quest approve` is the explicit human QA acknowledgment step.

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

Passive inspection stays read-only:

- `/quest`, `/quests`, and other read paths do not create `~/.pi/agent/quests/` state until a quest or learned workflow is actually written
- quest storage is created only when a quest starts persisting state or when learned workflows are saved

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
- `evals/README.md`
- `LICENSE`
- `tests/`
- `scripts/evals.ts`
- `scripts/smoke.ts`

Local verification:

```bash
bun test
tsc -p tsconfig.typecheck.json
bun run evals
bun run evals:regression
bun run evals:capability
bun run evals:scenario
bun run scripts/smoke.ts
bun run verify
bun run verify:full
```

## Eval-First Development

Quest improvements should be driven by evals, not intuition.

The repo now carries three eval layers:

- regression evals: release-gating checks for quest invariants that must not regress
- capability evals: prompt/orchestration checks for validation-first quest behavior
- scenario evals: slower end-to-end checks against fixture repos and live Pi subprocesses

The current eval harness is intentionally Pi-native:

- code-graded and deterministic
- separate from live model judging
- separate from human QA
- narrow enough to run on every local iteration

Human interactive review still matters for:

- proposal-review quality in the TUI
- Quest Control ergonomics
- live worker and validator behavior
- final QA judgment before `/quest approve`

Interactive verification checklist:

- `/reload`
- `/enter-quest`
- `/exit-quest`
- `/quest`
- `/quests`
- `/quest model`
- `/quest role-model worker`
- `/quest role-model validator`
- `/quest approve`
- create a quest, review the proposal, then `/quest accept`
- verify Quest Control updates live while a worker or validator is running

## Compatibility

Targeted against Pi `0.64.x`.

Compatibility matrix:

| Surface | Contract |
|---------|----------|
| Pi version | `0.64.x` |
| Extension hooks | `registerCommand`, `pi.on(...)`, `ctx.ui.setStatus`, `ctx.ui.setWidget` |
| Worker streams | `message_update`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `turn_end`, `agent_end` |

The smoke script checks the installed `pi --version`, and the scenario suite now includes a compatibility eval that fails if the child JSON event stream no longer exposes the event types quests depend on.
