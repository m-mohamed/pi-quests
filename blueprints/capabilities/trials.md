# Trials Capability

## Purpose

Define how Quest turns traces into profile improvements.

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

#### Scenario: Profile patch is applied

- GIVEN Trials identify an improving candidate
- WHEN the candidate passes spot checks and full suites
- THEN Trials update prompts, budgets, policies, and workflow hints
- AND it does NOT mutate arbitrary runtime code

### Pi-native trace ingestion

Trials accept both Quest trace bundles and raw Pi session files.

#### Scenario: Community trace is ingested

- GIVEN a raw Pi session JSONL file
- WHEN Trials parse the session
- THEN it derives model choice, duration, and failure signals
- AND it can use those signals for profile optimization

### Meta-harness filesystem

Trials maintain a filesystem of candidates for counterfactual reasoning.

#### Scenario: Proposer reads prior candidates

- GIVEN multiple candidates have been evaluated
- WHEN a proposer reads the meta-harness filesystem
- THEN it can access all prior profile patches
- AND it can read all prior scores and traces
- AND it can perform counterfactual diagnosis across candidates

### Overfitting guard

Trials reject candidates that improve narrow replays while regressing
held-out or core behavior.

#### Scenario: Hold-out regression blocks adoption

- GIVEN a candidate improves benchmark replay slice
- WHEN it regresses hold-out or core datasets
- THEN Trials reject the candidate
- AND preserves the baseline profile