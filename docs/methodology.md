# Quest Benchmark Methodology

Last reviewed: 2026-04-03

Quest benchmark work is split into three layers:

1. Quest-native evals
2. Trials frontier optimization
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
4. Trials archive benchmark scorecards, traces, and candidate summaries under `.pi/quests/trials/candidates/`

Quest also ships local Harbor dry-run and substrate checks for development. Official claims should use the real Harbor sample/full datasets, not dry-run output.

## SlopCodeBench

SlopCodeBench runs are checkpoint-oriented. Quest uses the official upstream `slop-code run` overlay for benchmark claims and frontier optimization.

The Quest path is:

1. a base specification is paired with one checkpoint
2. one checkpoint maps to one bounded headless Quest run
3. Quest records checkpoint-specific provenance on candidate traces and scorecards
4. Trials use the resulting frontier artifacts to tune prompt, budget, and context policies

Only the upstream-runner overlay path should back public SlopCodeBench claims.

## Release posture

Quest is released methodology-first:

- the package and adapters are public
- reproducibility steps are public
- benchmark claims are published only after stable reruns exist

Quest does not claim leaderboard status until the exact run configuration, benchmark version, and scores are all recorded in the benchmark card.
