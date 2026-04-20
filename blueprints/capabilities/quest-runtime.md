# Quest Runtime Capability

## Purpose

Define how Quest plans, executes, validates, and completes long-running coding
work inside a Pi session or headless run.

## Current Commitments

### Proposal-first lifecycle

The system requires a quest proposal before execution begins.

#### Scenario: New quest starts in planning

- GIVEN an operator creates a new quest
- WHEN the quest is initialized
- THEN repo-local quest artifacts are created
- AND execution remains blocked until the proposal is accepted

### Validation-first execution

The system keeps execution gated by explicit validation state.

#### Scenario: Milestone validation blocks unsafe progress

- GIVEN a milestone completes
- WHEN validators detect failed or incomplete critical assertions
- THEN the quest remains blocked or corrective
- AND the next milestone does not start automatically

### Headless eval contract

The system supports a machine-readable headless run contract.

#### Scenario: Headless run emits eval-safe output

- GIVEN Quest runs through `quest-headless`
- WHEN the run reaches a terminal or blocked outcome
- THEN the system writes machine-readable result artifacts
- AND preserves eval provenance and trace references

### Human QA handoff

The system ends with an explicit human QA boundary.

#### Scenario: Quest finishes automated work

- GIVEN all automated work and validation complete
- WHEN the run reaches completion
- THEN the output includes a human QA handoff
- AND the system does not auto-ship or auto-release
