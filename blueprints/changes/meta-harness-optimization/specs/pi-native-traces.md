# Pi-Native Traces Specification

## Purpose

Define how Quest works with raw Pi session traces.

## Requirements

### Requirement: Parse Pi session format

The system SHALL parse Pi session JSONL files.

#### Scenario: Load community trace

- GIVEN a Pi session JSONL file
- WHEN the system loads the file
- THEN it parses all entry types (session, message, tool_call, tool_result, model_change, thinking_level_change)
- AND it extracts model changes, thinking levels, tool calls

### Requirement: Derive trace metadata

The system SHALL derive metadata from Pi sessions.

#### Scenario: Extract model choice

- GIVEN a Pi session with model_change entries
- WHEN the system derives metadata
- THEN it extracts the final model provider and model ID
- AND it extracts the final thinking level

#### Scenario: Calculate duration

- GIVEN a Pi session with timestamps
- WHEN the system derives metadata
- THEN it calculates total duration from first to last entry timestamp

### Requirement: Derive failure signals

The system SHALL derive failure signals from Pi sessions.

#### Scenario: Detect tool errors

- GIVEN a Pi session with tool_result entries
- WHEN the system derives failure signals
- THEN it identifies tool results with `isError: true`
- AND it tags the session with tool failures

#### Scenario: Detect user frustration

- GIVEN a Pi session with user messages
- WHEN the system derives failure signals
- THEN it identifies frustration patterns ("that didn't work", "try again", "wrong", "nope")
- AND it tags the session with `repeated_corrective_loop`

#### Scenario: Detect success signals

- GIVEN a Pi session ending with user gratitude
- WHEN the system derives success signals
- THEN it identifies success patterns ("thanks", "works", "perfect", "great")
- AND it marks the session as `ok: true`

#### Scenario: Detect tool-heavy sessions

- GIVEN a Pi session with many tool calls
- WHEN the system derives failure signals
- THEN it counts tool call entries
- AND it tags `tool_heavy` if count exceeds threshold

### Requirement: No silent fallbacks

The system SHALL fail loudly on parse errors.

#### Scenario: Invalid JSONL

- GIVEN a malformed Pi session file
- WHEN the system tries to parse it
- THEN it throws an error with file name and line number
- AND it does not silently skip or synthesize data