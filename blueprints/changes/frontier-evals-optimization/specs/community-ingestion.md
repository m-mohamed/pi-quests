# Community Trace Ingestion Specification

## Purpose

Define how Quest ingests raw community Pi traces into the frontier eval optimizer runtime.

## Requirements

### Requirement: Canonical community root

The system SHALL use `.pi/quests/evals/community-traces/` as the canonical community-trace root.

#### Scenario: Resolve community traces

- GIVEN community traces downloaded under `.pi/quests/evals/community-traces/`
- WHEN the system initializes eval community analysis
- THEN it reads that directory directly
- AND it does not depend on sibling roots or symlink indirection

### Requirement: Session-only filtering

The system SHALL count only valid Pi session files in canonical stats.

#### Scenario: Filter corpus

- GIVEN a mix of Pi session files, manifests, and non-Pi comparison files
- WHEN the analyzer scans the corpus
- THEN it parses the first record of each `.jsonl`
- AND it counts the file only if the first record is `type: "session"`
- AND it excludes non-session files from canonical per-source stats

### Requirement: Batch validation

The system SHALL validate the full corpus without collapsing the batch on a single bad file.

#### Scenario: Validate corpus

- GIVEN a directory of community trace files
- WHEN the analyzer processes the batch
- THEN it records parse failures with the file path
- AND it continues processing the remaining files

### Requirement: Statistics aggregation

The system SHALL aggregate statistics from community traces for proposer consumption.

#### Scenario: Generate statistics

- GIVEN validated Pi session files
- WHEN the system aggregates statistics
- THEN it writes totals, per-source counts, model/provider distributions, failure tags, and usage metrics
- AND it writes the output to `.pi/quests/evals/community-stats.json`

### Requirement: No silent missing-data fallback

The system SHALL fail loudly when a command requires community traces but the corpus is unavailable.

#### Scenario: Missing community traces

- GIVEN `.pi/quests/evals/community-traces/` does not exist
- WHEN the system attempts to run community analysis
- THEN it fails with a clear error message
- AND it does not proceed with empty statistics
