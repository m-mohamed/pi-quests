# Changelog

## [Unreleased]

- tightened the standalone package metadata for public npm publishing
- documented local, git, npm, and project-local Pi installation flows
- added a package/gallery preview image and a public quickstart path
- aligned maintainer eval/smoke harnesses with the current `/quest` command surface and repo-local `.pi/quests` storage model
- added release-gating CI around `npm run check`

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
