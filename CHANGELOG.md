# Changelog

## 0.8.0

- split the quest UX into `/enter-quest`, `/quest`, `/quests`, and `/exit-quest`
- removed implicit quest creation from `/quest` and replaced `/quest start` with `/quest accept`
- added session-scoped quest mode via Pi's documented `input` event and persisted mode state
- expanded smoke and scenario coverage for the new Quest Control and quest list surfaces

## 0.7.0

- added real `/quest abort` semantics with persisted active-run metadata and resumable operator interruptions
- tightened `start`, `resume`, `pause`, and `approve` command boundaries
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
- added `/quest approve` to close the explicit human QA lifecycle
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
