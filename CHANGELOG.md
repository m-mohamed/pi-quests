# Changelog

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
