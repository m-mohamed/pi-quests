# Community Trace Ingestion Specification

## Purpose

Define how Quest ingests and uses community Pi traces.

## Requirements

### Requirement: Symlink to community traces

The system SHALL reference community traces without duplication.

#### Scenario: Link community trace directories

- GIVEN community traces downloaded to `.pi/quests/trials/community-traces/`
- WHEN the system initializes meta-harness
- THEN it creates symlinks under `.pi/quests/meta-harness/traces/community/`
- AND it preserves original directory structure

### Requirement: Batch validation

The system SHALL validate all community traces before use.

#### Scenario: Validate batch

- GIVEN a directory of community trace files
- WHEN the system validates the batch
- THEN it attempts to parse each file
- AND it logs failures with file name and error
- AND it continues processing remaining files

### Requirement: Statistics aggregation

The system SHALL aggregate statistics from community traces.

#### Scenario: Generate statistics

- GIVEN validated community traces
- WHEN the system aggregates statistics
- THEN it produces: model usage counts, tool usage patterns, session durations
- AND it produces: failure tag frequency distributions
- AND it writes statistics to JSON for proposer access

### Requirement: No silent skipping

The system SHALL NOT silently skip missing trace directories.

#### Scenario: Missing community traces

- GIVEN meta-harness traces directory does not exist
- WHEN the system attempts to use community traces
- THEN it fails with clear error message
- AND it does not proceed with empty statistics