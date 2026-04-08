# Proposer Agent Specification

## Purpose

Define how the `proposer` role reads frontier artifacts and proposes bounded profile patches.

## Requirements

### Requirement: Read canonical Trials artifacts

The proposer SHALL have read access to the full frontier history under `.pi/quests/trials/`.

#### Scenario: Query optimization state

- GIVEN the proposer starts
- WHEN it reads the Trials filesystem
- THEN it can inspect:
  - `community-stats.json`
  - `search-set.json`
  - `hold-out-set.json`
  - `frontier.json`
  - `candidates/*/profile.patch.json`
  - `candidates/*/scores.json`
  - `candidates/*/hold-out.json`
  - `candidates/*/summary.json`
  - `candidates/*/traces/<task-name>/...`

### Requirement: Counterfactual diagnosis

The proposer SHALL trace benchmark failures back to profile-owned decisions.

#### Scenario: Diagnose a failed task

- GIVEN candidate `N` failed task `X`
- WHEN the proposer reads the candidate summary, scorecards, and archived traces
- THEN it identifies the failure mode
- AND it connects that failure to profile surfaces that can be patched safely

### Requirement: Bounded patch scope

The proposer SHALL modify only profile-owned surfaces.

#### Scenario: Generate patch

- GIVEN the proposer identifies an improvement opportunity
- WHEN it emits a patch
- THEN it changes only prompt surfaces, budgets, tool policies, or workflow guidance owned by `QuestProfile`
- AND it does not modify runtime code

### Requirement: Read-only execution

The proposer SHALL remain read-only with respect to the repository and Trials artifacts.

#### Scenario: Tool constraints

- GIVEN the proposer is running
- WHEN it uses tools
- THEN read-oriented tools are allowed
- AND mutating edits are forbidden
- AND benchmark execution remains the responsibility of the evaluation loop, not the proposer

### Requirement: Structured candidate output

The proposer SHALL output a candidate patch with rationale and targeting metadata.

#### Scenario: Proposal result

- GIVEN the proposer finishes diagnosis
- WHEN it returns a result
- THEN it includes:
  - a `QuestProfilePatch`
  - a summary
  - rationale
  - targeted failure tags
  - targeted prompt surfaces
  - a generalization note
