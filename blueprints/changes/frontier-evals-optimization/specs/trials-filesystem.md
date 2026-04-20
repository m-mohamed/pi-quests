# Frontier Trials Filesystem Specification

## Purpose

Define the canonical filesystem layout for frontier optimization in Quest.

## Requirements

### Requirement: Canonical optimization root

The system SHALL use `.pi/quests/trials/` as the live optimization root.

#### Scenario: Resolve runtime storage

- GIVEN Trials is preparing or running optimization
- WHEN it reads or writes optimization state
- THEN it uses `.pi/quests/trials/`
- AND it treats `.pi/quests/lab` and `.pi/quests/meta-harness` as migration inputs only

### Requirement: Candidate directory structure

The system SHALL archive each evaluated candidate with a consistent layout.

#### Scenario: Create candidate

- GIVEN the system evaluates a new candidate
- WHEN it writes the candidate directory
- THEN it creates:
  - `profile.json`
  - `profile.patch.json`
  - `scores.json`
  - `hold-out.json`
  - `summary.json`
  - `evals/<split>/<task-id>/...`
- AND it uses sequential numbering (`000`, `001`, `002`, ...)

### Requirement: Search and hold-out artifacts

The system SHALL materialize explicit task splits on disk.

#### Scenario: Prepare eval split

- GIVEN an eval dataset manifest
- WHEN Trials prepares the eval
- THEN it writes `search-set.json`
- AND it writes `hold-out-set.json`
- AND those files contain explicit task lists with no overlap

### Requirement: Frontier state

The system SHALL persist frontier membership and leader selection.

#### Scenario: Recompute frontier

- GIVEN at least one accepted candidate
- WHEN Trials recomputes the frontier
- THEN it writes `frontier.json`
- AND it records the leader candidate ID
- AND it records the ordered list of frontier candidate IDs

### Requirement: Current profile tracking

The system SHALL track the promoted leader profile separately from archived candidates.

#### Scenario: Promote leader

- GIVEN a frontier leader exists
- WHEN Trials promotes that leader
- THEN `.pi/quests/trials/current/profile.json` contains the promoted profile
- AND it matches the archived `profile.json` for the leader candidate

### Requirement: Search/hold-out isolation

The system SHALL never leak hold-out tasks into optimization scoring.

#### Scenario: Score a candidate

- GIVEN search and hold-out splits exist
- WHEN Trials evaluates a candidate
- THEN only the search split contributes to domination and leader selection
- AND hold-out scores are used only as a non-regression gate
- AND candidates that regress on hold-out are rejected
