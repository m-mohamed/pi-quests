# Design: Meta-Harness Optimization

## Architecture Decision 1: Pi-Native Trace Format

**Decision:** Use raw Pi session JSONL directly. Don't convert to QuestTraceBundle.

**Rationale:**
- Community traces are Pi sessions — conversion loses information
- Pi session format is stable and documented
- We can derive what we need on-demand

**Consequences:**
- Trials must accept both `QuestTraceBundle` and raw Pi session JSONL
- Derive failure tags from conversation patterns (user frustration, tool errors)
- No upfront conversion — lazy evaluation

---

## Architecture Decision 2: Meta-Harness Filesystem Layout

```
.pi/quests/meta-harness/
├── current/
│   └── profile.json              # Active profile
├── candidates/
│   ├── 001/
│   │   ├── profile.patch.json    # What changed
│   │   ├── scores.json           # Search set scores
│   │   ├── hold-out.json         # Hold-out scores (if run)
│   │   └── traces/               # Execution traces
│   │       ├── terminal-bench-task-1/
│   │       └── ...
│   ├── 002/
│   └── ...
├── search-set.json               # Task IDs for optimization
├── hold-out-set.json             # Task IDs for validation
└── traces/                       # Symlink to community + our traces
    ├── community/
    │   ├── badlogicgames/
    │   └── 0xsero/
    └── quest/
```

---

## Architecture Decision 3: Proposer as Quest Extension

**Decision:** Proposer is a Quest extension (`/quest propose-patch`), not a separate Pi session.

**Rationale:**
- Quest already has orchestrator/worker/validator pattern
- Proposer is just another phase with different prompts
- Can reuse Quest's trace capture, profile application, validation

**Consequences:**
- Add `proposer` to `QuestRole` enum
- Proposer reads filesystem via `read` tool
- Proposer outputs `QuestProfilePatch`
- Apply patch via existing `applyQuestProfilePatch()`

---

## Architecture Decision 4: Search/Hold-out Split

**Decision:** 70% search, 30% hold-out. Pareto frontier selection.

**Rationale:**
- Meta-Harness paper used held-out tasks for validation
- Prevents overfitting to search set
- Pareto allows multi-objective (accuracy vs cost)

**Consequences:**
- Split tasks before any optimization
- Never use hold-out for candidate selection
- Validate final Pareto frontier on hold-out

---

## Architecture Decision 5: Fail Loudly, Fail Early

**Decision:** No silent fallbacks. Validate before expensive runs.

**Rationale:**
- Hidden failures create debugging nightmares
- Silent fallbacks hide configuration errors
- Early validation saves time and money

**Consequences:**
- If trace directory missing, fail — don't silently skip
- If parse error on community trace, log and skip (batch mode)
- If no traces found, fail — can't proceed without data
- If hold-out regresses, reject candidate — no override

---

## Information Flow

```
Community Traces (.pi/quests/trials/community-traces/)
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                    META-HARNESS FILESYSTEM                   │
├─────────────────────────────────────────────────────────────┤
│  candidates/                                                │
│  ├── 001/                                                   │
│  │   ├── profile.patch.json                                 │
│  │   ├── scores.json                                        │
│  │   └── traces/                                            │
│  ├── 002/                                                   │
│  └── ...                                                    │
│  search-set.json                                            │
│  hold-out-set.json                                          │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                      PROPOSER AGENT                          │
│  - Reads prior candidates via grep/cat                      │
│  - Reads scores.json for each candidate                     │
│  - Reads selected traces for counterfactual diagnosis       │
│  - Proposes targeted QuestProfilePatch                      │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                     EVALUATION                               │
│  - Apply patch to current profile                           │
│  - Score on search set                                      │
│  - If search improves: validate on hold-out                 │
│  - If hold-out passes: archive as new candidate             │
└─────────────────────────────────────────────────────────────┘
```

---

## Failure Mode Handling

| Failure Mode | Response |
|--------------|----------|
| Missing trace data | Fail. Don't synthesize. |
| No candidates yet | Fail. Need baseline first. |
| Hold-out regression | Reject candidate. No override. |
| Community trace parse error | Log and skip. Don't halt batch. |
| No search-set.json | Fail. Must define before optimization. |
| Profile patch invalid | Fail. Malformed patch. |