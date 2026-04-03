# Release Readiness Capability

## Purpose

Define the minimum standard for calling the Quest package release-ready.

## Current Commitments

### Repeatable package gate

The package exposes a repeatable local gate for release readiness.

#### Scenario: Maintainer validates the package

- GIVEN a maintainer prepares a release candidate
- WHEN they run the local package gate
- THEN typechecking, tests, and tarball validation pass

### Clean release artifacts

The package excludes generated workspace and benchmark residue from release
artifacts.

#### Scenario: Maintainer validates the tarball

- GIVEN a maintainer runs `npm pack --dry-run`
- WHEN the tarball manifest is inspected
- THEN generated `.pi` state and benchmark residue are excluded

### Verified public docs

The public release docs stay aligned with the verified benchmark state.

#### Scenario: Maintainer prepares a public announcement

- GIVEN a maintainer updates the public docs
- WHEN they reference benchmark or release state
- THEN the README, benchmark card, reproducibility guide, and results docs
  reflect only verified information
