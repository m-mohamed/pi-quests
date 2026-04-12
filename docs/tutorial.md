# Quest Tutorial

`pi-quests` is the structured way to take on substantial repo work in Pi.

This tutorial stays on the public Quest surface: create a quest, shape the plan, accept it, and inspect the repo-local artifacts that make the work inspectable.

## Install

```bash
pi install /Users/mohamedmohamed/research/pi-quests
```

## Start a quest

```bash
/quest new Build a validator-backed release checklist
```

That creates a repo-local quest under `.pi/quests/<quest-id>/` and starts the planning pass.

## Shape the plan

Use the planning turn to get three things right before execution:

1. The goal is unambiguous.
2. The validation contract says what success means.
3. The feature list is bounded and serial.

Quest persists that state on disk instead of burying it in one long trajectory.

## Review before execution

Open Quest Control:

```bash
/quest
```

At minimum, review:

- `proposal.md`
- `validation-contract.md`
- `features.json`
- `services.yaml`

If the plan is not ready, keep refining it. If it is ready, accept it.

## Run the quest

```bash
/quest accept
```

Quest then executes bounded features with fresh workers and checks milestones with fresh validators. Completion still ends with explicit human QA.

## Stay in control

Useful commands:

- `/quest`
- `/quests`
- `/quest pause`
- `/quest resume`
- `/quest abort`
- `/quest model <orchestrator|worker|validator> <provider/model[:thinking]>`

Operator guidance:

- Quest is serial by default. One bounded feature runs at a time, then Quest spends validator budget at milestone boundaries.
- Pause when the contract is wrong, the repo changed under the run, or the worker is spending effort on environment churn instead of the feature.
- Resume after you have clarified the contract, updated the repo, or changed the role models.
- Abort when the goal has changed enough that the current quest should not continue.
- Re-scope by refining the proposal before `/quest accept`, or by pausing, updating the repo-local contract files, and then resuming if the same quest still fits.

Conservative run budget:

- about one worker run per feature
- up to two validator passes per milestone
- extra replanning only when validation finds real drift

## Use the headless runner

For repeatable non-interactive runs:

```bash
quest-headless run \
  --instruction "Implement the assigned repo task" \
  --cwd "$(pwd)"
```

The result artifact is written under `.pi/quests/<quest-id>/headless-run.json`.

## Read the architecture note

For the runtime model and design boundary, read [`quest-architecture.md`](quest-architecture.md).
