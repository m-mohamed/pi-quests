# Tasks: Meta-Harness Optimization

## Phase 0: Foundation & Baseline

### 0.1 Establish current baseline
- [ ] Document all model tests in `docs/baseline-results.md` (minimax-m2.5, glm-5, kimi-k2.5, minimax-m2.7, gpt-5.4)
- [ ] Verify working models produce real tokens (minimax-m2.5, glm-5, kimi-k2.5)
- [ ] Document failure pattern: all models play wrong chess move (`e2e8` vs expected `g2g4`/`e2e4`)

### 0.2 Create search/hold-out split
- [ ] Define Terminal-Bench task split: 70% search, 30% hold-out
- [ ] Write `search-set.json` and `hold-out-set.json` to meta-harness directory
- [ ] Validate: no overlap between sets

### 0.3 Pi-native trace capture
- [ ] Add `PiSessionTrace` type to `types.ts` (distinct from `QuestTraceBundle`)
- [ ] Create `parsePiSession()` in `src/pi-session-parser.ts`
- [ ] Derive: `modelChoice`, `durationMs`, `ok` from session entries
- [ ] Derive failure tags from conversation patterns (user frustration, tool errors)

### 0.4 Validate foundation
- [ ] Can parse community trace without error
- [ ] Can derive failure tags from trace
- [ ] Can write candidate to filesystem
- [ ] Hold-out tasks never used in search

---

## Phase 1: Community Trace Integration

### 1.1 Ingest community traces
- [ ] Symlink `.pi/quests/meta-harness/traces/community/badlogicgames/` to pi-mono directory
- [ ] Symlink `.pi/quests/meta-harness/traces/community/0xsero/` to pi-sessions directory
- [ ] Count and validate: 627 + 96 sessions

### 1.2 Build trace statistics
- [ ] Aggregate: models used, token costs, session durations
- [ ] Identify: most common failure patterns
- [ ] Document: what failure tags we can derive

### 1.3 Fail loudly
- [ ] If trace directory missing, fail — don't silently skip
- [ ] If parse error on any trace, log and continue (batch mode)
- [ ] If no traces found, fail — can't proceed without data

---

## Phase 2: Proposer Agent

### 2.1 Create proposer role
- [ ] Add `"proposer"` to `QuestRole` enum
- [ ] Create `proposerPolicy` prompt surface in default profile
- [ ] Create `proposerAttempt` in verification budget

### 2.2 Create proposer skill document
- [ ] Define: objectives, filesystem layout, CLI commands
- [ ] Define: what artifacts to produce (`QuestProfilePatch`)
- [ ] Define: what is forbidden (no code execution, no mutation)

### 2.3 Wire proposer to meta-harness filesystem
- [ ] Proposer reads `candidates/*/profile.patch.json`
- [ ] Proposer reads `candidates/*/scores.json`
- [ ] Proposer reads selected `candidates/*/traces/` via grep/cat
- [ ] Proposer outputs: patch, rationale, addressed tags

### 2.4 Validate proposer
- [ ] Proposer can read all prior candidates
- [ ] Proposer outputs valid `QuestProfilePatch`
- [ ] Patch can be applied without error

---

## Phase 3: Evaluation Pipeline

### 3.1 Score calculation
- [ ] Implement `scoreProfileOnSearchSet()`
- [ ] Implement `scoreProfileOnHoldOut()` (validation only)
- [ ] Calculate: accuracy, cost, duration metrics

### 3.2 Pareto frontier
- [ ] Implement `computeParetoFrontier()`
- [ ] Candidates that dominate on any objective
- [ ] Reject dominated candidates

### 3.3 Improvement detection
- [ ] Compare new candidate vs current profile
- [ ] Require: search set improvement AND hold-out non-regression
- [ ] Archive: only Pareto-optimal candidates

### 3.4 Validate pipeline
- [ ] Can score profile on search set
- [ ] Can validate on hold-out set
- [ ] Can compute Pareto frontier from candidates
- [ ] No hold-out data leaks into optimization

---

## Phase 4: First Optimization Run

### 4.1 Initialize baseline
- [ ] Run search set with current profile
- [ ] Archive as candidate 000
- [ ] Document baseline scores

### 4.2 Run 5 iterations
- [ ] Iteration 1: Proposer reads candidate 000, proposes patch
- [ ] Apply patch, score on search set
- [ ] If search improves: validate on hold-out
- [ ] If hold-out passes: archive as new candidate
- [ ] Repeat for iterations 2-5

### 4.3 Document results
- [ ] Before/after scores
- [ ] Which patches failed and why
- [ ] What failure patterns were addressed

### 4.4 Validate outcome
- [ ] Pareto frontier computed correctly
- [ ] No hold-out regression in accepted patches
- [ ] Can reproduce results from archived candidates

---

## Phase 5: Community Trace Integration

### 5.1 Use community traces for failure tag derivation
- [ ] Aggregate failure patterns from badlogicgames traces
- [ ] Aggregate failure patterns from 0xsero traces
- [ ] Derive: common failure tags, model choices, tool patterns

### 5.2 Feed community patterns into proposer
- [ ] Proposer can read community trace statistics
- [ ] Proposer can cite community patterns in rationale

### 5.3 Validate integration
- [ ] Community patterns visible to proposer
- [ ] Patches reference community failure modes
- [ ] Optimization benefits from community data

---

## Phase 6: Documentation & Release

### 6.1 Update docs
- [ ] Update `docs/baseline-results.md` with final scores
- [ ] Document meta-harness filesystem in `docs/`
- [ ] Document proposer workflow in `docs/`

### 6.2 Clean up
- [ ] Remove `improve-benchmark-baselines` change (DONE)
- [ ] Remove `prepare-public-baseline-release` change (DONE)
- [ ] Remove `release-readiness.md` capability (DONE)
- [ ] Simplify `trials.md` capability

### 6.3 Validate readiness
- [ ] All phases pass
- [ ] No hold-out data leak
- [ ] Can reproduce optimization from scratch