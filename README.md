# Pi Quests

`@m-mohamed/pi-quests` is a standalone Pi package that adds validation-first quest orchestration on top of Pi core.

Pi core stays upstream. Quest is your package. That means:

- Pi core dependencies still come from the upstream Pi packages such as `@mariozechner/pi-coding-agent`
- Quest itself is published under your own package identity: `@m-mohamed/pi-quests`
- the package is loaded the Pi-native way through the `pi` manifest and a TypeScript extension entrypoint at `./src/index.ts`

## Preview

![Quest Control](https://raw.githubusercontent.com/m-mohamed/pi-quests/main/docs/quest-control.png)

## Installation

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

## Runtime Model

Quest is proposal-first and validation-first:

1. `/quest new` creates a repo-local quest under `.pi/quests/<quest-id>/`
2. the orchestrator runs a dry-run validation readiness probe before proposal approval
3. proposal artifacts are written to disk for review
4. `/quest accept` starts execution
5. workers run one feature at a time in isolated `pi --mode json --no-session` subprocesses
6. validators run milestone checks and can append corrective features before work continues
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

Quest artifacts are the source of truth. `pi.appendEntry()` is only used for session-local UI state such as quest mode and the last-opened Quest Control tab.

## Quest Control

`/quest` opens Quest Control in interactive mode and prints a summary in print/RPC mode.

Quest Control uses Pi’s native custom UI surface through `ctx.ui.custom()` and shows:

- quest summary, status, and role models
- current milestone and feature progress
- validation readiness and assertion counts
- worker and validator run state
- latest run details and handoff information

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
```

Maintainer-only manual harnesses also live under `scripts/`, but they are not part of the publish gate.

Targeted against Pi `0.64.x`.
