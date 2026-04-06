# Meta-Harness Filesystem Specification

## Purpose

Define the filesystem layout for meta-harness optimization.

## Requirements

### Requirement: Candidate directory structure

The system SHALL create candidate directories with consistent structure.

#### Scenario: Create candidate

- GIVEN the meta-harness creates a new candidate
- WHEN it writes the candidate directory
- THEN it creates: `profile.patch.json`, `scores.json`, `traces/`
- AND it uses sequential numbering (001, 002, ...)

### Requirement: Score file format

The system SHALL write scores in a queryable format.

#### Scenario: Write scores

- GIVEN a candidate evaluated on the search set
- WHEN the system writes `scores.json`
- THEN it includes: task_id, score, duration_ms, model_choice for each task
- AND it includes aggregate: mean_score, total_duration, tokens_used

### Requirement: Trace preservation

The system SHALL preserve execution traces per candidate.

#### Scenario: Store traces

- GIVEN a candidate evaluated on task X
- WHEN the system stores traces
- THEN it writes to `candidates/NNN/traces/task-X/`
- AND it includes: full execution log, model messages, tool results

### Requirement: Search/hold-out isolation

The system SHALL never leak hold-out tasks to optimization.

#### Scenario: Validate split

- GIVEN `search-set.json` and `hold-out-set.json`
- WHEN the system validates
- THEN there is no overlap between task IDs
- AND `hold-out-set.json` task IDs never appear in candidate optimization

#### Scenario: Hold-out validation only

- GIVEN a candidate is being evaluated
- WHEN scores are computed for optimization
- THEN only search-set tasks contribute to the score
- AND hold-out scores are computed for validation only
- AND candidates that regress on hold-out are rejected

### Requirement: Current profile tracking

The system SHALL track the active profile separately from candidates.

#### Scenario: Read current profile

- GIVEN meta-harness has run at least one optimization
- WHEN the system reads current profile
- THEN `current/profile.json` contains the active profile
- AND it matches one of the archived candidates' resulting profiles