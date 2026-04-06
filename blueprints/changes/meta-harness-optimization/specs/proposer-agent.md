# Proposer Agent Specification

## Purpose

Define how the proposer agent reads traces and proposes patches.

## Requirements

### Requirement: Read all prior candidates

The proposer SHALL have access to the full candidate history.

#### Scenario: Query filesystem

- GIVEN the proposer agent starts
- WHEN it reads the meta-harness filesystem
- THEN it can list all candidate directories
- AND it can read any candidate's `profile.patch.json`
- AND it can read any candidate's `scores.json`
- AND it can read any candidate's traces via `grep`/`cat`

### Requirement: Counterfactual diagnosis

The proposer SHALL trace failures to specific profile decisions.

#### Scenario: Diagnose failure

- GIVEN candidate N failed on task X with failure tag T
- WHEN the proposer reads `traces/candidates/N/traces/task-X/`
- THEN it identifies the specific failure mode
- AND it traces back to profile decisions that may have caused it
- AND it proposes targeted fixes for T

### Requirement: Propose bounded patches

The proposer SHALL propose changes only to profile-owned surfaces.

#### Scenario: Generate patch

- GIVEN the proposer identifies improvement opportunities
- WHEN it generates a patch
- THEN it modifies only: prompt surfaces, budgets, policies, workflow hints
- AND it does NOT modify runtime code
- AND it includes rationale citing specific trace evidence

### Requirement: No mutation

The proposer SHALL NOT mutate files or execute code.

#### Scenario: Proposer constraints

- GIVEN the proposer is running
- WHEN it attempts to use tools
- THEN `read` is ALLOWED
- AND `bash` with `grep`/`cat`/`head`/`ls` is ALLOWED (read-only)
- AND `edit`/`write` is FORBIDDEN
- AND `bash` with mutation is FORBIDDEN

### Requirement: Output format

The proposer SHALL output `QuestProfilePatch`.

#### Scenario: Proposer output

- GIVEN the proposer finishes diagnosis
- WHEN it outputs its proposal
- THEN it produces: `profile.patch.json` with rationale
- AND it produces: list of addressed failure tags
- AND it produces: list of source candidate IDs

### Requirement: Cite evidence

The proposer SHALL cite specific evidence from traces.

#### Scenario: Evidence citation

- GIVEN the proposer proposes a patch
- WHEN it outputs rationale
- THEN it cites specific trace files
- AND it cites specific line numbers or message IDs
- AND it cites specific scores that would improve