# Design: Prepare public baseline release

## Approach

Treat release readiness as documentation and process hardening, not as a code
feature.

1. Record the latest verified state.
   - package gate
   - Harbor sample baseline
   - official SlopCodeBench baseline

2. Make the release bar explicit.
   - checklist for package state
   - checklist for benchmark claims
   - checklist for public docs

3. Keep future work in Blueprints.
   - capability docs describe the current intended system
   - change proposals describe the next deltas

## Non-goals

- publishing to npm in this change
- making unverified performance claims
- turning the repo into a marketing site
