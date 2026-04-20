# Pi Quests

`@m-mohamed/pi-quests` is a standalone Pi package for large, multi-feature coding work with structured Quest orchestration.

Describe the goal, collaborate on the plan, and let Quest manage the work through bounded features, fresh workers, fresh validators, and repo-local state.

Pi core stays upstream. Quest is your package. That means:

- Pi core dependencies still come from the upstream Pi packages such as `@mariozechner/pi-coding-agent`
- Quest itself is published under your own package identity: `@m-mohamed/pi-quests`
- the package is loaded the Pi-native way through the `pi` manifest and a TypeScript extension entrypoint at `./src/index.ts`

## Preview

![Quest Control](https://raw.githubusercontent.com/m-mohamed/pi-quests/main/docs/quest-control.png)

## Installation

Pi Quests now targets the current Pi package line: `@mariozechner/pi-*` `0.66.1+`.

Install from a local checkout:

```bash
pi install /Users/mohamedmohamed/research/pi-quests
```

Install from git:

```bash
pi install git+https://github.com/m-mohamed/pi-quests.git
```

Install from npm once published:

```bash
pi install npm:@m-mohamed/pi-quests
```

Install it project-locally so the repo auto-loads Quest for everyone using that checkout:

```bash
pi install -l /Users/mohamedmohamed/research/pi-quests
```

Or declare it directly in `.pi/settings.json`:

```json
{
  "packages": ["npm:@m-mohamed/pi-quests"]
}
```

## Quickstart

```bash
/quest new Build a validator-first bug bash workflow
/quest
/quest accept
```

Typical flow:

1. create a quest with `/quest new <goal>`
2. review the generated proposal and validation contract on disk
3. start execution with `/quest accept`
4. monitor progress in Quest Control with `/quest`
5. finish with the explicit human QA handoff before shipping anything

## What A Quest Is

A Quest is the structured way to take on substantial repo work in Pi.

Instead of pushing everything through one long session, Quest turns the goal into an explicit contract, breaks the work into bounded features, runs implementation with fresh workers, runs checks with fresh validators, and keeps the state on disk so progress stays inspectable.

You still steer the work. Quest handles decomposition, execution, validation, and handoff.

## Supervising A Quest

Quest is serial by default: it runs one bounded feature worker at a time and then spends validator budget at milestone boundaries. That keeps repo state inspectable, keeps handoffs readable, and avoids turning long-running coding work into parallel merge noise.

Useful operator interventions:

- Use `/quest pause` when prerequisites changed, the validation contract is wrong, or the current run is burning time on setup instead of repo progress.
- Use `/quest resume` after you have clarified the contract, changed role models, or updated the repo state Quest should continue from.
- Use `/quest abort` when the goal changed enough that the current proposal is no longer the right contract.
- Re-scope before `/quest accept` by refining the proposal. After execution starts, pause, update the repo-local contract files, and resume only if the same quest still applies.

Conservative planning heuristic:

- Expect roughly one worker run per feature.
- Expect up to two validator passes per milestone.
- Reserve extra budget only for corrective replanning when validation finds real drift.

## Commands

- `/quest new <goal>`
- `/quest`
- `/quest enter`
- `/quest exit`
- `/quest accept`
- `/quest pause`
- `/quest resume`
- `/quest abort`
- `/quest model <orchestrator|worker|validator> <provider/model[:thinking]>`
- `/quests`

## Headless Runs

For repeatable non-interactive runs, use the headless entrypoint:

```bash
quest-headless run \
  --instruction "Implement the assigned feature" \
  --cwd "$(pwd)"
```

The headless runner writes a machine-readable contract under `.pi/quests/<quest-id>/headless-run.json`.

Read [docs/quest-architecture.md](docs/quest-architecture.md) for the runtime model.
Read [docs/tutorial.md](docs/tutorial.md) for the public Quest walkthrough.

## Quest Architecture

Quest is a structured execution loop for substantial coding work:

1. `/quest new` creates a repo-local quest under `.pi/quests/<quest-id>/`
2. the orchestrator runs a dry-run validation readiness probe before proposal approval
3. the orchestrator defines the validation contract before the feature list, then writes both to disk for review
4. `/quest accept` starts execution
5. workers run one bounded feature at a time in isolated `pi --mode json --no-session` subprocesses
6. fresh validators run milestone checks and surface issues; the orchestrator turns those into targeted fix features before work continues
7. completion always ends with an explicit human QA checklist and a limited-coverage summary

Quest never auto-commits, auto-deploys, or auto-ships.

## Stored Artifacts

Quest state is stored in the working repository under `.pi/quests/<quest-id>/`:

- `quest.json`
- `proposal.md`
- `validation-readiness.json`
- `validation-contract.md`
- `validation-state.json`
- `features.json`
- `services.yaml`
- `skills/*.md`

Shared learned workflow guidance is stored under `.pi/quests/shared-skills/`.
Quest skill directories are auto-discovered as Pi skills on startup and `/reload`.

Quest artifacts are the source of truth. `pi.appendEntry()` is only used for session-local UI state such as quest mode.

## Quest Control

`/quest` opens Quest Control in interactive mode and prints a summary in print/RPC mode.

Quest Control uses Pi’s native custom UI surface through `ctx.ui.custom()` with Pi TUI components (`SelectList`, `Markdown`, `Box`, `DynamicBorder`) and the injected Pi keybinding manager, and shows:

- quest summary, status, and role models
- current milestone and feature progress
- validation readiness and assertion counts
- worker and validator run state
- latest run details and handoff information
- live context-pressure snapshots from Pi’s `before_provider_request` hook
- a single native widget panel above the editor instead of a separate text/actions sidecar

Native shortcuts:

- `ctrl+alt+q` opens Quest Control
- `ctrl+alt+l` opens the project quest picker

Quest also uses Pi’s native `tool_result` hook to add focused follow-up hints when bash output spills to a file or a read result is truncated, instead of relying only on prompt wording.
For agent `bash` tool calls, Quest also uses Pi’s native `tool_call` mutation path to inject active quest context directly into the shell command, rather than maintaining a separate wrapper runtime.
During live Quest runs, Quest also sets Pi’s native working message and hidden-thinking label so the active role and phase are visible in the core runtime chrome.

## Package Shape

This package follows the Pi package conventions used by the docs, examples, and the current community ecosystem:

- `package.json` includes the `pi-package` keyword
- `pi.extensions` points directly at `./src/index.ts`
- Pi core libraries are `peerDependencies`
- Quest logic lives in the extension, not in Pi core

That is the Pi-native pattern for add-on packages like `pi-tools`, `pi-cmux`, `pi-show-diffs`, and similar third-party Pi packages.

## Development

Useful local commands:

```bash
npm run typecheck
npm run test
npm run check
npm run pack:check
node --import tsx scripts/evals.ts --suite offline-core
```

Maintainer-only optimization, eval, and trace-mining workflows also live in this repo, but they are intentionally outside the main package story. They are documented under `docs/internal/`.

## Release Workflow

Use `docs/quest-architecture.md` before publishing or announcing a new release.

Quest is publish-ready when the package gate is green and the core docs are current, even if npm publication is intentionally deferred.

## Blueprints

This repo now keeps its forward plan in a Quest-native planning workspace:

- project context: `blueprints/project.md`
- current capability docs: `blueprints/capabilities/`
- active roadmap changes: `blueprints/changes/`

The active roadmap change is:

- `blueprints/changes/frontier-evals-optimization/`
