# Harness Engineering & Frontier Trials: The Complete Guide

*For the pi-quests project — A deep dive into the theory, research, and implementation of autonomous harness engineering.*

---

## Table of Contents

1. [The Problem: Why Harnesses Matter](#1-the-problem-why-harnesses-matter)
2. [Part I: Harness Engineering (Martin Fowler)](#part-i-harness-engineering-martin-fowler)
   - 2.1 The Harness Defined
   - 2.2 Feedforward vs Feedback
   - 2.3 Computational vs Inferential
   - 2.4 The Steering Loop
   - 2.5 Three Regulation Categories
   - 2.6 Harnessability & Ambient Affordances
   - 2.7 Harness Templates
3. [Part II: Meta-Harness Optimization (Stanford Research)](#part-ii-meta-harness-optimization-stanford-research)
   - 3.1 The Core Insight
   - 3.2 The Feedback Compression Problem
   - 3.3 Architecture: Proposer + Filesystem + Evaluator
   - 3.4 Why Code-Space Search Works
   - 3.5 Key Results
   - 3.6 Qualitative Proposer Behavior
4. [Part III: Quest's Implementation](#part-iii-quests-implementation)
   - 4.1 Architecture: Pi → Quest → Trials
   - 4.2 Harness Engineering in Quest
   - 4.3 Frontier Trials in Quest
   - 4.4 Model Ensemble & Routing
   - 4.5 Community Traces
5. [Part IV: Key Primitives & Concepts](#part-iv-key-primitives--concepts)
6. [Part V: PR State & Gap Analysis](#part-v-pr-state--gap-analysis)
7. [Further Reading](#further-reading)

---

## 1. The Problem: Why Harnesses Matter

### The 6x Performance Gap

Changing the harness around a fixed LLM can produce a **6x performance gap** on the same benchmark. The harness — the code that determines what to store, retrieve, and show to the model — often matters as much as the model itself.

### The Trust Gap

When you hand code to an LLM agent, you face fundamental challenges:

```
┌─────────────────────────────────────────────────────────────────┐
│                        THE TRUST GAP                            │
│                                                                 │
│   LLMs are:                  Humans bring:                      │
│   ───────────               ─────────────                       │
│   • Non-deterministic       • Experience & intuition            │
│   • No context awareness    • Aesthetic sense ("this is wrong") │
│   • Token predictors        • Organizational memory             │
│   • No accountability       • Social responsibility             │
│   • No "disgust" at bad code • Small-step thinking space        │
│                                                                 │
│   Result: Code looks good but has hidden problems               │
│   Traditional fix: More human review → bottleneck               │
│   Harness engineering fix: Structured guides + sensors          │
└─────────────────────────────────────────────────────────────────┘
```

### The Manual Iteration Problem

Harness engineering is currently manual:
- Practitioners inspect failures
- Adjust heuristics by hand
- Iterate on a small number of designs
- Can't scale to the full space of possible harness configurations

**Meta-Harness asks**: Can this process itself be automated?

---

## Part I: Harness Engineering (Martin Fowler)

*Source: [Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html) by Birgitta Böckeler, Thoughtworks, April 2026.*

### 2.1 The Harness Defined

A **harness** is everything except the model itself. It's the structure that guides and validates agent behavior.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     THE THREE LAYERS                                │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │              USER HARNESS (YOU BUILD)                        │   │
│   │   - AGENTS.md, Skills, Rules, Documentation                 │   │
│   │   - Custom linters, structural tests                        │   │
│   │   - Review agents, quality judges                           │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              ↑ feedforward + feedback              │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │           BUILDER HARNESS (AGENT BUILDER PROVIDES)          │   │
│   │   - System prompts, orchestration, code retrieval           │   │
│   │   - Tool definitions, session management                    │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              ↑                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                          MODEL                              │   │
│   │                    (the LLM itself)                         │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Key insight**: A well-built outer harness serves two goals:
1. Increases the probability that the agent gets it right the first time
2. Provides a feedback loop that self-corrects issues before they reach human eyes

### 2.2 Feedforward vs Feedback

**Feedforward (Guides)** — Anticipate problems and prevent them:
- Run BEFORE the agent acts
- Increase probability of good first attempt
- Examples: AGENTS.md, Skills, Rules, Documentation, LSP, MCP servers

**Feedback (Sensors)** — Detect problems and enable self-correction:
- Run AFTER the agent acts
- Enable the agent to fix its own mistakes
- Examples: Linters, tests, code review agents, static analysis

```
FEEDFORWARD                          FEEDBACK
     ↓                                    ↓
┌─────────────┐                   ┌─────────────┐
│  AGENTS.md  │                   │   Linter    │
│   Skills    │      ──────►      │   Tests     │
│   Rules     │    AGENT ACTS     │   Review    │
│   Docs      │                   │   Agents    │
└─────────────┘                   └─────────────┘
   Prevents                           Detects +
   problems                           self-corrects
```

**Critical insight**: You need BOTH. Feedforward-only = agent encodes rules but never learns if they worked. Feedback-only = agent keeps repeating the same mistakes.

### 2.3 Computational vs Inferential

**Computational** — Fast, deterministic, CPU-based:
- Linters, type checkers, tests, structural analysis
- Run in milliseconds to seconds
- Reliable, repeatable results
- Cheap enough to run on every change
- Use for: style, formatting, architecture, basic correctness

**Inferential** — Slow, non-deterministic, GPU-based:
- LLM code review, quality judges, semantic analysis
- Run in seconds to minutes
- More expensive, probabilistic results
- Use for: code quality assessment, nuanced feedback, complex reasoning

| Control Type | Speed | Cost | Reliability | Use Case |
|--------------|-------|------|-------------|----------|
| Computational | ms-sec | $ | High | Style, structure, basic tests |
| Inferential | sec-min | $$$ | Medium | Quality, nuance, complex review |

### 2.4 The Steering Loop

The human's job is to **steer** the agent by iterating on the harness:

```
┌─────────────────────────────────────────────────────────────────┐
│                      THE STEERING LOOP                          │
│                                                                 │
│   ┌──────────────┐                                            │
│   │   Observe    │◄────────────┐                               │
│   │   failures   │             │                               │
│   └──────┬───────┘             │                               │
│          │                     │                               │
│          ▼                     │                               │
│   ┌──────────────┐             │                               │
│   │   Improve    │─────────────┤                               │
│   │   harness    │             │                               │
│   └──────┬───────┘             │                               │
│          │                     │                               │
│          ▼                     │                               │
│   ┌──────────────┐             │                               │
│   │   Deploy     │─────────────┘                               │
│   │   to agent   │                                               │
│   └──────┬───────┘                                               │
│          │                                                       │
│          ▼                                                       │
│      Agent runs                                                  │
│          │                                                       │
│          └──────────────────────────────────────────────────────┘
```

**Key insight**: Use AI to improve the harness! Agents can:
- Write structural tests from observed patterns
- Generate draft rules from failure analysis
- Scaffold custom linters
- Create how-to guides from codebase archaeology

### 2.5 Three Regulation Categories

#### A. Maintainability Harness (Easiest)
Regulates internal code quality:
- Computational sensors catch: duplicate code, cyclomatic complexity, missing test coverage, architectural drift, style violations
- Inferential sensors catch: semantically duplicate code, redundant tests, brute-force fixes, over-engineered solutions
- **Limitation**: Neither catches misdiagnosis, overengineering, misunderstood instructions

#### B. Architecture Fitness Harness
Regulates architectural characteristics:
- Defines: performance requirements, observability standards, module boundaries
- **Fitness Functions**: Executable specifications of architectural characteristics
- Examples: performance tests, logging standards, API quality checks

#### C. Behaviour Harness (Hardest)
Regulates functional correctness:
- Feedforward: functional specifications, test plans
- Feedback: test suites, manual testing (still primary!)
- **Problem**: We put too much faith in AI-generated tests
- **Emerging solution**: Approved Fixtures pattern

### 2.6 Harnessability & Ambient Affordances

**Harnessability** — Not every codebase is equally amenable to harnessing:
- Strongly typed languages → type-checking as a sensor
- Clearly definable module boundaries → architectural constraint rules
- Frameworks like Spring → abstract away details, increase agent success

**Ambient Affordances** — Structural properties of the environment that make it legible, navigable, and tractable to agents:
- Greenfield: Can bake harnessability in from day one
- Legacy: The harness is most needed where it is hardest to build

### 2.7 Harness Templates

Common project topologies can become "harness templates":

```
┌─────────────────────────────────────────────────────────────────┐
│                    HARNESS TEMPLATES                            │
│                                                                 │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│   │  Data       │  │   CRUD      │  │  Event      │           │
│   │  Dashboard  │  │   Service   │  │  Processor  │           │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘           │
│          │               │               │                    │
│          ▼               ▼               ▼                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              BOILERPLATE HARNESS                         │   │
│   │  • Structure definition    • Tech stack conventions    │   │
│   │  • Guide documents         • Sensor configurations    │   │
│   │  • Validation rules        • Fitness functions         │   │
│   └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Ashby's Law of Requisite Variety**: A regulator must have at least as much variety as the system it governs. Defining topologies is a variety-reduction move, making comprehensive harnesses more achievable.

---

## Part II: Meta-Harness Optimization (Stanford Research)

*Source: [Meta-Harness: End-to-End Optimization of Model Harnesses](https://arxiv.org/abs/2603.28052) by Yoonho Lee, Roshen Nair, Qizheng Zhang, Kangwook Lee, Omar Khattab, Chelsea Finn (Stanford, MIT, KRAFTON), March 2026.*

### 3.1 The Core Insight

Harness engineering is currently manual. Meta-Harness automates it through an **outer-loop search** over harness code:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    META-HARNESS SEARCH LOOP                         │
│                                                                     │
│   (1) Proposer reads filesystem                                     │
│       of all prior candidates'                                      │
│       source code, scores, and    ┌─────────────────────────────┐   │
│       execution traces            │   FILESYSTEM                │   │
│                                   │   ┌───────────────────────┐  │   │
│   (2) Proposes new harness ──────►│   │ Candidate 1: code     │  │   │
│                                   │   │ Candidate 1: scores   │  │   │
│   (3) Evaluates on tasks ────────►│   │ Candidate 1: traces   │  │   │
│                                   │   │ Candidate 2: code     │  │   │
│   (4) Logs results back ─────────►│   │ Candidate 2: scores   │  │   │
│                                   │   │ Candidate 2: traces   │  │   │
│                                   │   │ ...                   │  │   │
│                                   │   └───────────────────────┘  │   │
│                                   └─────────────────────────────┘   │
│                                                                     │
│   Repeat for N iterations, return Pareto frontier                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 The Feedback Compression Problem

This is the paper's central contribution. Prior text optimizers compress feedback too aggressively:

| Method | History | Log Content | MTok/iter |
|--------|---------|-------------|-----------|
| OPRO | Window | past (solution, score) pairs | 0.002 |
| TextGrad | Last | textual feedback on current artifact | 0.015 |
| AlphaEvolve | Window | program database + eval. scores | 0.022 |
| GEPA | Summary | reflective feedback from rollout traces | 0.008 |
| Feedback Descent | Summary | comparison + textual feedback | 0.012 |
| TTT-Discover | Window | prev. solution fragment | 0.026 |
| **Meta-Harness** | **Full** | **all logs and scores** | **10.0** |

**Key finding**: Access to raw execution traces is the most important component. Ablation study:
- Scores-only: 34.6 median, 41.3 best accuracy
- Scores + Summary: 34.9 median, 38.7 best accuracy (summaries may even hurt!)
- **Meta-Harness (full)**: 50.0 median, 56.7 best accuracy

**Why summaries fail**: Harnesses act over long horizons. A single choice about what to store, when to retrieve it, or how to present it can affect behavior many reasoning steps later. Compressed feedback removes the information needed to trace downstream failures to earlier harness decisions.

### 3.3 Architecture: Proposer + Filesystem + Evaluator

#### The Proposer
- A **coding agent** (Claude Code with Opus-4.6), not a raw LLM
- Reads a median of **82 files per iteration**
- References **20+ prior candidates per step**
- Uses standard tools (grep, cat) rather than ingesting everything as a single prompt
- Can inspect up to **10,000,000 tokens** of diagnostic information per evaluation

#### The Filesystem
- Stores for every candidate: source code, evaluation scores, execution traces
- Traces include: prompts, tool calls, model outputs, state updates
- Proposer queries selectively via terminal tools

#### The Evaluator
- Tests harness on actual tasks
- Uses held-out test cases
- Measures: accuracy, token usage, latency
- Returns Pareto frontier (not single scalar)

### 3.4 Why Code-Space Search Works

1. **Richer feedback** — Uses source code, scores, AND execution traces
2. **Outer-loop optimization** — Not optimizing the LLM, optimizing the harness around it
3. **Automatic discovery** — Finds configurations humans wouldn't try
4. **Cross-task generalization** — Harnesses discovered for one task work on others
5. **Natural regularization** — Coding models propose coherent algorithms, not brittle hard-coded solutions
6. **Causal reasoning** — Proposer can infer WHY a harness failed, not just THAT it failed

### 3.5 Key Results

| Task | Result |
|------|--------|
| **Online text classification** | +7.7 points over ACE, 4x fewer context tokens |
| **Text optimization speed** | Matches best prior optimizers in 0.1x evaluations |
| **Math reasoning (200 IMO problems)** | +4.7 points average across 5 held-out models |
| **TerminalBench-2 (Opus 4.6)** | 76.4% pass rate, #2 among all Opus agents |
| **TerminalBench-2 (Haiku 4.5)** | 37.6% pass rate, #1 among all Haiku agents |
| **OOD generalization** | Best average accuracy on 9 unseen datasets |

### 3.6 Qualitative Proposer Behavior

The search trajectory reveals the proposer learning from its own regressions:

```
Iteration 1-2: Combined structural fixes + prompt edits → both regressed
    ↓
Iteration 3: Explicitly hypothesized confounded edits
    "The regressions were confounded by the shared prompt intervention"
    ↓
Iteration 4: Isolated structural changes from prompt rewrite
    ↓
Iteration 5+: Pivoted toward safer additive modifications → best candidate
```

This provides qualitative evidence that filesystem access enables the proposer to:
- Form causal hypotheses about failures
- Isolate confounded changes
- Shift toward safer design patterns after repeated regressions

---

## Part III: Quest's Implementation

### 4.1 Architecture: Pi → Quest → Trials

```
┌─────────────────────────────────────────────────────────────────────┐
│                         QUEST ARCHITECTURE                          │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                      PI (Base Runtime)                       │   │
│   │   • Session management    • Tool execution                  │   │
│   │   • LLM client           • Message loop                     │   │
│   │   • TUI display          • Extension system                 │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                  ↑                                  │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │              QUEST (Extension Layer)                         │   │
│   │   • Planning-first workflow   • Validation gates            │   │
│   │   • Role-based prompts       • Human QA boundary            │   │
│   │   • Feature/milestone tracking                             │   │
│   │   • Proposal lifecycle       • Abort/resume semantics       │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                  ↑                                  │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │              TRIALS (Meta-Harness Layer)                     │   │
│   │   • Trace capture           • Failure tagging               │   │
│   │   • Candidate proposal     • Experiment framework          │   │
│   │   • Profile patches        • Community traces              │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                  ↑                                  │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │           BENCHMARK INTEGRATION                              │   │
│   │   • Terminal-Bench (Harbor)  • SlopCodeBench               │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Harness Engineering in Quest

Quest implements Martin Fowler's harness categories:

#### A. Maintainability Harness
```typescript
// QuestProfile.harnessPolicy.computationalGuides
{
  linterConfigs: [],        // ESLint, Prettier configs
  preCommitHooks: [],       // Git hooks
  structuralTests: [],       // ArchUnit-style tests
  archConstraints: [],      // Module boundary rules
}

// QuestProfile.harnessPolicy.sensors.computational
{
  linters: [],              // Running linters
  typeCheckers: [],         // TypeScript, Java type checks
  testRunners: [],          // Test execution
  driftDetectors: [],      // Architecture drift detection
}
```

#### B. Architecture Fitness Harness
```typescript
// QuestProfile.harnessPolicy.fitnessFunctions
{
  performanceRequirements: [
    { metric: "latency", threshold: 100, unit: "ms" }
  ],
  observabilityRequirements: [
    { standard: "opentelemetry", required: true }
  ],
  architectureConstraints: []
}
```

#### C. Inferential Guides & Sensors
```typescript
// QuestProfile.harnessPolicy.inferentialGuides
{
  agentsMdPath: "",         // AGENTS.md location
  skillsDir: "",            // Skills directory
  codeReviewAgents: []      // LLM-based reviewers
}

// QuestProfile.harnessPolicy.sensors.inferential
{
  codeReviewAgents: [],     // AI code reviewers
  qualityJudges: [],        // LLM-as-judge
  runtimeMonitors: []       // Runtime observation
}
```

### 4.3 Meta-Harness in Quest (Trials)

Quest implements the Stanford Meta-Harness concept:

#### Trace Capture
```typescript
// Every quest run produces a QuestTraceBundle
{
  id: string,
  kind: "feature" | "validator" | "planning" | "replan",
  questId: string,
  role: "orchestrator" | "worker" | "validator",
  events: WorkerEventRecord[],
  failureTags: QuestFailureTag[],
  // ... execution metadata
}
```

#### Failure Tagging (Automated)
```typescript
// Derived from trace analysis
type QuestFailureTag =
  | "prerequisite_miss"           // Missing prerequisites
  | "weak_validation"             // Insufficient validation
  | "repeated_corrective_loop"    // Stuck in retry
  | "model_mismatch_suspected"    // Wrong model for task
  | "tool_heavy"                  // Too many tool calls
  | "validator_failure"           // Validator errors
  | "worker_failure";             // Worker errors
```

#### Candidate Proposal (Agentic)
```typescript
// QuestProfile.promptSurfaces.proposerPolicy
// The proposer reads:
// - All candidate profiles
// - All scores and traces
// - Community trace statistics
// And proposes a QuestProfilePatch:
// - promptSurfaces modifications
// - modelPolicy changes
// - verificationBudget adjustments
// - contextPolicy tweaks
// - workflowHintPolicy updates
```

#### Experiment Framework
```typescript
// Three-gate validation
interface QuestExperiment {
  id: string,
  baselineProfileId: string,     // Current best
  candidates: QuestExperimentCandidate[],
  searchSet: string[],            // Cases to optimize on
  holdOutSet: string[],           // Cases to validate generalization
}
```

### 4.4 Model Ensemble & Routing

Quest can use multiple models intelligently. Currently configured for single-model GLM-5.1 operation:

```typescript
{
  enabled: true,
  families: [
    { provider: "zai", model: "glm-5.1", role: "worker", ... },
  ],
  defaultWorker: "zai/glm-5.1",
  defaultValidator: "zai/glm-5.1",
  routingRules: []
}
```

### 4.5 Community Traces

Quest learns from other agents' traces:

```
┌─────────────────────────────────────────────────────────────────────┐
│                  COMMUNITY TRACES (768 valid Pi sessions)          │
│                                                                     │
│   badlogicgames/pi-mono                     626 sessions          │
│   badlogicgames/pi-diff-review                6 sessions          │
│   0xSero/pi-sessions                         95 sessions          │
│   LarsEckart/approvaltests-java-sessions     14 sessions          │
│   championswimmer/pi-coding-sessions         25 sessions          │
│   cfahlgren1/agent-sessions-list (Pi)          2 sessions         │
│   non-session / non-Pi files excluded          9 files            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part IV: Key Primitives & Concepts

### Quest Primitives

| Primitive | Definition |
|-----------|------------|
| **Quest** | A long-running autonomous coding task |
| **Plan** | The task breakdown with milestones and features |
| **Profile** | Configuration: prompts, tools, models, verification |
| **Trial** | An evaluation run that produces traces |
| **Experiment** | A comparison of candidate profiles |
| **Trace** | Recording of all events during execution |
| **Failure Tag** | Automated categorization of what went wrong |
| **Candidate** | A proposed profile modification |
| **Patch** | The delta between profiles |

### Quest Lifecycle

```
planning → proposal_ready → running → completed
                ↑              |
                └──── paused ←─┘ (can resume)
                ↓
              aborted (can resume as paused)
```

### Role System

| Role | Responsibility |
|------|----------------|
| **Orchestrator** | Breaks down into milestones/features |
| **Worker** | Implements features, writes code |
| **Validator** | Reviews code, runs tests, checks quality |
| **Trial** | Runs benchmark search/hold-out evaluations |
| **Proposer** | Analyzes failures, proposes improvements |

### Validation Surfaces

| Surface | What it validates |
|---------|------------------|
| **orchestrator** | Task decomposition, milestone planning |
| **worker** | Code implementation, feature completion |
| **validator-code-review** | Code quality, test coverage |
| **validator-user-surface** | UI/UX, functional behavior |
| **readiness-probe** | Prerequisites, environment |
| **plan-revision** | Remaining plan accuracy |
| **proposer** | Profile improvement suggestions |

---

## Part V: PR State & Gap Analysis

### Current PR State

```
┌─────────────────────────────────────────────────────────────────────┐
│                    QUEST IMPLEMENTATION STATUS                      │
│                                                                     │
│   COMPONENT                    STATUS           COVERAGE            │
│   ─────────                    ──────           ────────            │
│                                                                     │
│   HARNESS ENGINEERING                                                │
│   ├─ Computational Guides     ✅ Implemented   Populated defaults     │
│   ├─ Inferential Guides       ✅ Implemented   Populated defaults     │
│   ├─ Computational Sensors    ⚠️  Partial      Enabled, needs depth   │
│   ├─ Inferential Sensors      ⚠️  Partial      Enabled, needs depth   │
│   ├─ Fitness Functions        ✅ Implemented   Defined and enforced   │
│   ├─ Maintainability Harness  ✅ Implemented   Full                 │
│   ├─ Architecture Fitness     ✅ Implemented   Full                 │
│   └─ Behaviour Harness        ⚠️  Partial      Framework only       │
│                                                                     │
│   FRONTIER TRIALS                                                     │
│   ├─ Trace Capture            ✅ Implemented   Full                 │
│   ├─ Failure Tagging          ✅ Implemented   10 tags              │
│   ├─ Candidate Proposal       ✅ Implemented   Proposer role        │
│   ├─ Search/Hold-out Loop     ✅ Implemented   Frontier runtime     │
│   ├─ Filesystem History       ✅ Implemented   .pi/quests/trials/   │
│   ├─ Pareto Frontier          ✅ Implemented   Multi-objective      │
│   ├─ Community Traces         ✅ Implemented   768 valid sessions   │
│   └─ Auto-Optimization        ✅ Implemented   Baseline + iterations│
│                                                                     │
│   BENCHMARKS                                                         │
│   ├─ Terminal-Bench           ✅ Implemented   Harbor harness       │
│   ├─ SlopCodeBench            ✅ Implemented   Headless runner      │
│   └─ Custom Benchmarks        ✅ Implemented   Local evals          │
│                                                                     │
│   EXTENSION                                                          │
│   ├─ Pi Integration           ✅ Implemented   @mariozechner/pi-*   │
│   ├─ Quest Commands           ✅ Implemented   /quest, /quests      │
│   ├─ Trials Commands          ✅ Implemented   /quest trials        │
│   ├─ Widget Rendering         ✅ Implemented   TUI display          │
│   └─ Headless Mode            ✅ Implemented   quest-headless       │
│                                                                     │
│   CODE QUALITY                                                       │
│   ├─ Typecheck                ✅ Passing       tsc --noEmit         │
│   ├─ Tests                    ✅ Passing       20/20                │
│   ├─ Shared Utilities         ✅ Refactored    utils.ts             │
│   └─ Dead Code Removed        ✅ Cleaned       7 files removed      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Gap Analysis

#### Gaps vs Martin Fowler's Vision

| Gap | Priority | Description |
|-----|----------|-------------|
| **Harness Templates** | Medium | Pre-built harness bundles for common project topologies (CRUD service, API, dashboard) |
| **Behaviour Harness** | High | AI-generated test quality is still a problem; need approved fixtures pattern |
| **Harness Coverage Evaluation** | Medium | No way to measure "harness coverage" analogous to code coverage |
| **Continuous Drift Sensors** | Low | No sensors running continuously against codebase (dead code, dependency scanners) |
| **Runtime Feedback** | Low | No agents monitoring runtime SLOs, log anomalies |

#### Gaps vs Meta-Harness Paper

| Gap | Priority | Description |
|-----|----------|-------------|
| **Harness Sensors Are Thin** | High | The frontier loop is automated and the sensor arrays are populated, but the repo-specific checks and always-pass regression coverage are still shallow |
| **Benchmark Readiness Probe** | Medium | Preflight already supports a real Harbor smoke task; remaining work is better task-specific smoke defaults for expensive benchmark surfaces |
| **Artifact Quality Controls** | Medium | Candidate traces exist, but richer per-task summaries and failure surfacing would improve proposer leverage |
| **OOD Generalization Testing** | Low | No explicit out-of-distribution validation of discovered harnesses |
| **Search Space Definition** | Medium | No explicit definition of what dimensions the proposer can search over |
| **Interface Validation** | Low | No validation that proposed harnesses conform to expected interface |

#### Gaps vs Production Readiness

| Gap | Priority | Description |
|-----|----------|-------------|
| **Community Trace Ingestion** | Low | Community stats are live, tag-aware, and wired into the proposer prompt; remaining work is better automatic eval mining from traces |
| **Benchmark Baseline** | High | The sample baseline still needs one uninterrupted successful run |
| **Profile Versioning** | Low | No explicit versioning of profiles for rollback |
| **Harness Template Library** | Low | No pre-built harness templates for common project types |

### What's Working Well

1. **Clean architecture** — Pi native → Quest extension → frontier Trials
2. **Harness Engineering foundations** — All three regulation categories implemented
3. **Meta-Harness pattern** — Filesystem-visible proposer loop, held-out gating, Pareto promotion
4. **Community traces** — 768 valid Pi sessions from 6 sources across HuggingFace
5. **Benchmark integration** — Terminal-Bench and SlopCodeBench via headless mode
6. **Code quality** — Typecheck passes, 20/20 tests, shared utilities, dead code removed

### What Needs Work

1. **Harness sensors** — The arrays are now populated, but they still need deeper repo-specific checks and a stronger always-pass regression subset
2. **Behaviour harness** — AI-generated test quality problem not solved
3. **Harness templates** — No pre-built harness bundles
4. **Benchmark readiness** — Harbor preflight needs better smoke-task defaults for benchmark-specific surfaces like QEMU helpers
5. **Benchmark baselines** — Need the first uninterrupted sample baseline to measure improvement against

---

## Further Reading

### Primary Sources
1. **Martin Fowler** — [Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html) (April 2026)
2. **Stanford Meta-Harness** — [End-to-End Optimization of Model Harnesses](https://arxiv.org/abs/2603.28052) (March 2026)
3. **OpenAI** — [Harness Engineering: Leveraging Codex in an Agent-First World](https://openai.com/index/harness-engineering/)
4. **Anthropic** — [Effective Harnesses for Long-Running Agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Related Work
5. **Stripe** — [Minions: Stripe's One-Shot End-to-End Coding Agents](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
6. **KRAFTON AI** — [Terminus-KIRA: Boosting Frontier Model Performance on Terminal-Bench](https://github.com/krafton-ai/kira)
7. **OpenEvolve** — [Open-Source Evolutionary Coding Agent](https://github.com/algorithmicsuperintelligence/openevolve)
8. **GEPA** — [Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457)

### Concepts
9. **Ashby's Law of Requisite Variety** — A regulator must have at least as much variety as the system it governs
10. **Fitness Functions** — Executable specifications of architectural characteristics
11. **Context Engineering** — Making guides and sensors available to the agent
12. **Ambient Affordances** — Environmental properties that make codebases harnessable

---

*Last updated: 2026-04-08*
*Part of the pi-quests project*
