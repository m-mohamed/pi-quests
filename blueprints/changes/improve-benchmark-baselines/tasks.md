# Tasks: Improve benchmark baselines

## 1. Baseline review

- [ ] 1.1 Extract the latest Harbor sample trace bundle findings into a benchmark review note
- [ ] 1.2 Extract the latest official SlopCodeBench failure shape into a benchmark review note
- [ ] 1.3 Freeze the current before-state in `docs/baseline-results.md`

## 2. Trials integration

- [ ] 2.1 Add benchmark-specific failure tags for the observed Harbor and SlopCodeBench failure modes
- [ ] 2.2 Add replay generation helpers keyed by Harbor task id and SlopCodeBench checkpoint lineage
- [ ] 2.3 Add experiment-report output that compares official benchmark before/after context

## 3. Stable reruns

- [ ] 3.1 Run one Harbor sample task repeatedly with a fixed profile/model until outcomes are stable
- [ ] 3.2 Run one official SlopCodeBench problem/checkpoint repeatedly with a fixed profile/model until outcomes are stable
- [ ] 3.3 Promote only stable reruns into the benchmark-improvement loop

## 4. Improvement loop

- [ ] 4.1 Tune Quest profiles against the benchmark replay slices
- [ ] 4.2 Reject candidates that fail held-out or core Quest-native suites
- [ ] 4.3 Record accepted changes and benchmark deltas for the next public baseline
