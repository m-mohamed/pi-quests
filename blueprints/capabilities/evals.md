# Evals Capability

## Purpose

Define how Quest is evaluated on local substrate checks and external
long-horizon eval suites.

## Current Commitments

### Distinct local and external eval paths

Quest distinguishes local smoke workflows from external eval runs.

#### Scenario: Operator runs a local smoke command

- GIVEN an operator runs a local eval smoke script
- WHEN the script completes
- THEN the results are treated as development substrate only
- AND they are not presented as public leaderboard claims

### FrontierSWE Docker eval adapter

Quest provides a native Docker adapter for supported external eval suites.

#### Scenario: Operator runs a FrontierSWE eval command

- GIVEN an operator runs a FrontierSWE eval
- WHEN Quest completes the run
- THEN the adapter preserves machine-readable Quest artifacts
- AND the verifier result reflects the task-local Docker test environment

### Eval provenance

Quest attaches eval provenance to Quest outputs and trace bundles.

#### Scenario: Eval run writes artifacts

- GIVEN an eval-backed Quest run completes
- WHEN the result artifacts are written
- THEN they record eval family, dataset, run mode, model, and adapter version
- AND they preserve references to Quest trace bundles

### Search/hold-out isolation

Eval tasks are split into search and hold-out sets.

#### Scenario: Task sets are isolated

- GIVEN eval task IDs
- WHEN the optimizer initializes the frontier split
- THEN 70% of tasks are in search-set.json
- AND 30% of tasks are in hold-out-set.json
- AND there is no overlap between sets

#### Scenario: Hold-out is never used for optimization

- GIVEN a candidate is being evaluated
- WHEN scores are computed for optimization
- THEN only search-set tasks contribute to the score
- AND hold-out scores are computed for validation only
- AND candidates that regress on hold-out are rejected
