# Changelog

## [Unreleased]

### Added

- Added Trials as a first-class evals-and-traces improvement subsystem around the normal `/quest` runtime.
- Added repo-local trial artifacts under `.pi/quests/trials/` for profiles, datasets, traces, experiments, baselines, and reports.
- Added `/quest trials`, `/quest trials run`, `/quest trials stop`, `/quest trials replay`, `/quest trials target`, and `/quest trials profile`.
- Added structured Trials tools for bounded profile updates, trace replay capture, experiment recording, score updates, and candidate application.
- Added `quest-headless` plus benchmark provenance on traces and replay cases for Terminal-Bench and SlopCodeBench flows.
- Added `benchmarks/harbor/` and `benchmarks/slopcodebench/` integration workspaces, plus benchmark methodology and reproducibility docs.
- Added helper benchmark scripts for local substrate smoke, Harbor sample/full runs, and SlopCodeBench checkpoint smoke.
- Added a Quest-native planning workspace with capability docs plus roadmap changes for public-release preparation and benchmark-baseline improvement.
- Added a verified benchmark baseline document and a release checklist for tagging or announcing new Quest baselines.

### Changed

- Tightened the standalone package metadata for public npm publishing.
- Documented local, git, npm, and project-local Pi installation flows.
- Added a package/gallery preview image and a public quickstart path.
- Aligned maintainer eval/smoke harnesses with the current `/quest` command surface and repo-local `.pi/quests` storage model.

### Fixed

- Added release-gating CI around `npm run check`.
- Added offline-core and benchmark-adapter coverage for Lab profile defaults, benchmark trace tagging, replay dataset materialization, and repo-local Lab state persistence.

## 0.8.0

- split quest control from project quest listing, keeping `/quest` and `/quests` as separate surfaces
- formalized proposal-first execution with `/quest accept`
- added session-scoped quest mode via Pi's documented `input` event and persisted mode state
- expanded smoke and scenario coverage for the new Quest Control and quest list surfaces

## 0.7.0

- added real `/quest abort` semantics with persisted active-run metadata and resumable operator interruptions
- tightened `accept`, `resume`, and `pause` command boundaries around the current quest lifecycle
- added scenario evals against fixture repos plus a Pi child-stream compatibility check
- added a repo-local typecheck gate and `verify:full` for slower release validation

## 0.6.0

- added deterministic regression and capability eval suites for quest orchestration
- made `verify` gate on regression evals before smoke validation
- documented an eval-first development loop for improving the extension safely
- exported prompt builders so prompt and validator behavior can be regression-tested directly

## 0.5.0

- finalized the quest-only command and storage surface
- removed the old compatibility surface from the extension and state layer
- kept passive quest reads read-only so status checks do not create empty quest state directories
- aligned the source repo and deployed extension path on `pi-quests`

## 0.3.0

- moved the extension to a dedicated source-of-truth repo
- kept human QA as an explicit final handoff after automated validation
- tightened prune reporting so retained metadata is explicit
- expanded smoke coverage for Pi compatibility and QA approval persistence
- documented the repo-backed deploy path and final non-goals

## 0.2.0

- formalized the quest proposal lifecycle around review and validation
- added first-class validation contracts to quest proposals
- added streamed child worker telemetry for richer Quest Control status
- added project-scoped private learned workflows
- added remaining-plan revision support for steering and validator blocks
- added package metadata, tests, and a repeatable smoke script
