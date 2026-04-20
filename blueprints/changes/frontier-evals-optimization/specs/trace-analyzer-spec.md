# Community Trace Analyzer Specification

> Status: Implemented in `src/trace-analyzer.ts`
> Canonical output: `.pi/quests/evals/community-stats.json`
> Canonical input: `.pi/quests/evals/community-traces/`

## Purpose

The analyzer turns raw Pi session `.jsonl` files into filesystem-readable community statistics for the frontier eval optimizer loop.
It exists so the `proposer` role can reason over real community failure patterns instead of fabricated summaries.

## Verified corpus facts

Verified on 2026-04-07:

- Total `.jsonl` files on disk: `777`
- Valid Pi session files: `768`
- Canonical per-source valid Pi session counts:
  - `badlogicgames/pi-mono`: `626`
  - `badlogicgames/pi-diff-review`: `6`
  - `0xSero/pi-sessions`: `95`
  - `LarsEckart/approvaltests-java-sessions`: `14`
  - `championswimmer/pi-coding-sessions`: `25`
  - `cfahlgren1/agent-sessions-list/sessions/pi`: `2`

Non-session and non-Pi files remain on disk but are excluded from canonical community stats.

## Pi-native type requirements

The analyzer depends on the real Pi wire shape:

- session/message events may omit `id`, `parentId`, or `version`
- `thinking_level_change` uses `thinkingLevel`
- tool-call `arguments` can be structured objects
- `session_info` uses `name`
- compaction payloads use the real Pi fields (`summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter`, `details`, `fromHook`)
- unknown events must still parse without collapsing the session

## File-discovery rules

1. Discover `.jsonl` files recursively under `.pi/quests/evals/community-traces/`.
2. Read the first non-empty line.
3. Parse the first record as JSON.
4. Count the file as a canonical Pi session only if the first record is `type: "session"`.
5. Exclude manifests and non-Pi comparison files from per-source stats.
6. Fail loudly if the community trace root is missing when a command explicitly requires community analysis.

## Aggregates written to `community-stats.json`

The analyzer writes:

- corpus totals:
  - `totalFiles`
  - `totalSessions`
  - `parsedSessions`
  - `failedSessions`
  - `failedPaths`
- usage and cost totals:
  - input/output/cache tokens
  - total cost
  - average duration, tool calls, errors, and messages
- global distributions:
  - models
  - providers
  - failure tags
  - top tool names
  - duration buckets
- per-source breakdown in `sources`

## Failure-tag derivation

The analyzer derives community failure tags from the raw session timeline, including:

- `operator_abort`
- `tool_heavy`
- `context_overflow`
- `repeated_corrective_loop`
- `prerequisite_miss`
- `weak_validation`
- `blocked_milestone`
- `worker_failure`
- `model_mismatch_suspected`

These are heuristic tags derived from message content, tool behavior, errors, and compactions. They remain Pi-native because they are computed from the original JSONL event stream rather than a translated intermediate format.

## Integration points

The analyzer is integrated into the frontier runtime:

- `/quest evals analyze-community` forces regeneration of canonical stats
- `/quest evals run` ensures community stats exist before proposer iterations
- the `proposer` role reads `.pi/quests/evals/community-stats.json` alongside:
  - `.pi/quests/evals/search-set.json`
  - `.pi/quests/evals/hold-out-set.json`
  - `.pi/quests/evals/frontier.json`
  - `.pi/quests/evals/candidates/`

## Non-goals

This analyzer does not:

- convert Pi traces into a separate compatibility format
- synthesize session files when the corpus is missing
- infer Quest-specific validator/worker role boundaries from generic Pi sessions
- act as a separate optimization runtime outside `.pi/quests/evals/`
