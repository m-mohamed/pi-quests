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
- `/quest trials`
- `/quest trials status`
- `/quest trials prepare-benchmark [--benchmark terminal-bench|slopcodebench] [--dataset <id>] [--repo <path>]`
- `/quest trials analyze-community [--force]`
- `/quest trials baseline [--benchmark ...] [--dataset <id>] [--repo <path>]`
- `/quest trials run [--iterations <n>] [--benchmark ...] [--dataset <id>] [--repo <path>]`
- `/quest trials stop`
- `/quest trials profile`
- `/quests`

## Headless Benchmarking

Quest now ships a machine-driven benchmark entrypoint:

```bash
quest-headless run \
  --instruction "Solve the assigned task" \
  --cwd "$(pwd)" \
  --json
```

The headless runner writes a machine-readable contract under `.pi/quests/<quest-id>/headless-run.json` and keeps benchmark provenance on Quest artifacts plus Harbor trial directories.

Local development substrate:

```bash
npm run benchmark:local
npm run benchmark:tbench:preflight
npm run benchmark:tbench:sample -- --dry-run
npm run benchmark:tbench:sample
```

Official benchmark run entrypoints:

```bash
npm run benchmark:tbench:preflight
npm run benchmark:tbench:sample
npm run benchmark:tbench:full
npm run benchmark:slop:official -- --problem <problem-id> --repo /path/to/slop-code-bench
```

Benchmark targets:

- **Terminal-Bench** via Harbor and the installed-agent adapter in `benchmarks/harbor/README.md`
- **SlopCodeBench** through the official-run overlay described in `benchmarks/slopcodebench/README.md`

Quest is released methodology-first: the package, adapters, and reproducibility docs are public before any benchmark-number claims are made.

Current verified benchmark state lives in `docs/baseline-results.md`.

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

## Trials

Trials are the benchmark-and-frontier improvement layer around the normal `/quest` runtime.

It keeps Quest execution and Quest optimization separate:

1. normal `/quest` runs stay focused on the current repo task
2. Trials ingest raw Pi community sessions from `.pi/quests/trials/community-traces/` and generate canonical aggregate stats in `.pi/quests/trials/community-stats.json`
3. `/quest trials prepare-benchmark` writes explicit search and hold-out work-item lists under `.pi/quests/trials/`
4. `/quest trials baseline` archives the current profile as candidate `000`
5. `/quest trials run` asks the `proposer` role to patch only trial-owned profile surfaces, then scores each candidate on the search split and validates it on hold-out
6. non-dominated candidates stay on the Pareto frontier, and the current frontier leader is promoted to `.pi/quests/trials/current/profile.json`

Trials do not mutate Quest runtime code during normal task execution, and they never auto-publish, auto-tag, or auto-release.

### Trials Commands

- `/quest trials` opens Trials Control in interactive mode and prints a summary in print/RPC mode
- `/quest trials status` prints the canonical benchmark/community/frontier status
- `/quest trials prepare-benchmark [--benchmark ...] [--dataset <id>] [--repo <path>]` writes the explicit search/hold-out split
- `/quest trials analyze-community [--force]` regenerates canonical Pi-native community stats
- `/quest trials baseline [--benchmark ...] [--dataset <id>] [--repo <path>]` archives candidate `000` for the active benchmark family
- `/quest trials run [--iterations <n>] [--benchmark ...] [--dataset <id>] [--repo <path>]` runs the frontier optimization loop for the active profile
- `/quest trials stop` stops the active trial run without changing the leader profile
- `/quest trials profile` prints the active profile, adopted changes, and latest score summary

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

Trials store their own improvement artifacts under `.pi/quests/trials/`:

- `state.json`
- `current/profile.json`
- `profiles/<profile-id>.json`
- `candidates/NNN/profile.json`
- `candidates/NNN/profile.patch.json`
- `candidates/NNN/scores.json`
- `candidates/NNN/hold-out.json`
- `candidates/NNN/summary.json`
- `candidates/NNN/traces/<task-name>/...`
- `search-set.json`
- `hold-out-set.json`
- `frontier.json`
- `community-traces/`
- `community-stats.json`

Trials are canonical on `.pi/quests/trials/`. Runtime code does not read any pre-frontier optimization roots.

Quest artifacts are the source of truth. `pi.appendEntry()` is only used for session-local UI state such as quest mode and the last-opened Quest Control tab.

## Quest Control

`/quest` opens Quest Control in interactive mode and prints a summary in print/RPC mode.

Quest Control uses Pi’s native custom UI surface through `ctx.ui.custom()` and shows:

- quest summary, status, and role models
- current milestone and feature progress
- validation readiness and assertion counts
- worker and validator run state
- latest run details and handoff information

Trials use the same native Pi custom UI surface and show:

- active profile and optimization target
- benchmark family and dataset
- search and hold-out split counts
- frontier leader and candidate count
- community ingestion status

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
npm run benchmark:local
```

Maintainer-only manual harnesses also live under `scripts/`, but they are not part of the publish gate.

## Release Workflow

Use these docs before tagging or announcing a new baseline:

- `docs/baseline-results.md`
- `docs/benchmark-card.md`
- `docs/reproducibility.md`

Quest is publish-ready when the package gate is green and the verified baseline
docs are current, even if npm publication is intentionally deferred.

## Blueprints

This repo now keeps its forward plan in a Quest-native planning workspace:

- project context: `blueprints/project.md`
- current capability docs: `blueprints/capabilities/`
- active roadmap changes: `blueprints/changes/`

The active roadmap change is:

- `blueprints/changes/meta-harness-optimization/`

Targeted against Pi `0.65.x`.
