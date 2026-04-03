# Quest Benchmark Methodology

Last reviewed: 2026-04-03

Quest benchmark work is split into three layers:

1. Quest-native evals
2. Trials replay datasets
3. External benchmark runs

## System under test

The benchmark target is the assembled system:

- Pi as the primitive runtime
- Quest as the long-running orchestration layer
- Trials as the evals-and-traces improvement loop
- benchmark-specific profile settings

## Terminal-Bench

Terminal-Bench runs go through Harbor, the official harness used by the Terminal-Bench team.

The Quest path is:

1. Harbor runs the installed Quest agent adapter
2. the adapter invokes `quest-headless`
3. Quest writes benchmark artifacts and trace bundles under `.pi/quests/`
4. Trials turn failed runs into replay cases

Quest also ships local Harbor dry-run and substrate checks for development. Official claims should use the real Harbor sample/full datasets, not dry-run output.

## SlopCodeBench

SlopCodeBench runs are checkpoint-oriented. Quest maintains two paths:

- local smoke fixtures for fast adapter development
- an official-run overlay for the upstream `slop-code run` CLI

The Quest path is:

1. a base specification is paired with one checkpoint
2. one checkpoint maps to one bounded headless Quest run
3. Quest records checkpoint-specific provenance on traces and replay cases
4. Trials use those replay cases to tune prompt, budget, and context policies

Only the upstream-runner overlay path should back public SlopCodeBench claims.

## Release posture

Quest is released methodology-first:

- the package and adapters are public
- reproducibility steps are public
- benchmark claims are published only after stable reruns exist

Quest does not claim leaderboard status until the exact run configuration, benchmark version, and scores are all recorded in the benchmark card.
