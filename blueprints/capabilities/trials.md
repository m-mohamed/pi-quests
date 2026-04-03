# Trials Capability

## Purpose

Define how Trials turn Quest traces and evals into bounded, replayable
improvements.

## Current Commitments

### Trace capture and replay

Trials persist Quest traces that can be replayed into eval datasets.

#### Scenario: Interesting run becomes replay data

- GIVEN a quest run ends with a notable failure or weak validation signal
- WHEN Trials ingest the run
- THEN it persists a trace bundle
- AND it can materialize replay cases from that trace

### Bounded profile optimization

Trials limit changes to explicit profile-owned surfaces.

#### Scenario: Lab applies a winning candidate

- GIVEN Trials identify an improving candidate
- WHEN the candidate passes spot checks, full suites, and held-out checks
- THEN Trials may update prompts, budgets, policies, and workflow hints
- AND it does not mutate arbitrary runtime code as part of normal optimization

### Overfitting guard

Trials reject candidates that improve narrow replays while regressing
held-out or core behavior.

#### Scenario: Benchmark-only improvement regresses the core suite

- GIVEN a candidate improves a benchmark replay slice
- WHEN it regresses core regression or held-out datasets
- THEN Trials reject the candidate
- AND preserves the baseline profile
