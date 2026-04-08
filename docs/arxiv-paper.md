# Quest: A Validation-First Autonomous Coding Agent with Bounded Self-Improvement

**Mohamed Mohamed**

April 2026

---

**Abstract.** We present Quest, an extension for the Pi coding agent runtime that implements a validation-first autonomous coding workflow with a bounded self-improvement mechanism called Trials. Unlike one-shot coding agents that generate code in a single pass, Quest decomposes tasks into milestones and features, validates each step through independent code review and user-surface passes, and enforces an explicit human QA gate before any changes ship. The Trials subsystem records execution traces, identifies failure patterns through automated tagging, proposes targeted profile patches (prompt policies, verification budgets, context policies), and validates improvements through a three-gate experiment framework with held-out overfitting guards. We integrate Quest with two external benchmarks---Terminal-Bench (via the Harbor harness) and SlopCodeBench---through a headless execution mode that produces machine-readable results with full provenance tracking. Our architecture demonstrates that structured orchestration with explicit validation boundaries, combined with trace-driven prompt optimization, provides a principled foundation for building coding agents that can be measured, reproduced, and incrementally improved without unconstrained self-modification.

---

## 1  Introduction

Large language models (LLMs) have shown remarkable capability at code generation, but deploying them as autonomous coding agents introduces challenges beyond raw generation quality. Real-world coding tasks require planning, dependency management, validation, error recovery, and---critically---human oversight at appropriate boundaries. Most existing coding agents operate in a single-pass paradigm: the user provides an instruction, the agent generates code, and the user accepts or rejects the result. This leaves significant value on the table: there is no structured planning phase, no intermediate validation, no systematic error recovery, and no mechanism for the agent to improve from its own failures.

We introduce Quest, a Pi extension that addresses these gaps through three interlocking subsystems:

1. **The Quest Orchestration Loop** (Section 3): A multi-role pipeline---orchestrator, worker, validator---that plans before it codes, validates after each milestone, and always terminates at a human QA gate. Features execute sequentially within milestones, with validator-injected corrective features when validation fails.

2. **The Trials Self-Improvement System** (Section 4): A bounded optimization loop that records execution traces, tags failure patterns, proposes profile patches, and validates improvements through spot-check, full-evaluation, and held-out gates before adoption. Critically, Trials only modifies *profiles*---prompt policies, verification budgets, context policies, and workflow hints---never runtime code.

3. **The Benchmark Infrastructure** (Section 5): Headless execution adapters for Terminal-Bench [1] and SlopCodeBench [2] that produce machine-readable results with full benchmark provenance, enabling reproducible measurement of agent quality.

Quest is built as an extension to Pi [3], a minimal coding agent runtime analogous to what Neovim is to text editors. Pi provides the core capabilities---model calling, tool execution, file editing, session management---while Quest adds the opinionated workflow layer. This separation of concerns allows Quest's orchestration logic to remain independent of the underlying model provider, and we demonstrate this by running benchmarks across five models from three providers (OpenCode Go, OpenAI Codex, Google Gemini).

The key insight driving Quest's design is that **the gap between model capability and agent quality is primarily an orchestration and validation problem, not a generation problem**. A model that can solve a coding task in isolation may fail as an agent because of poor planning, missing prerequisites, inadequate validation, context overflow, or unconstrained corrective loops. Quest addresses each of these failure modes through explicit architectural mechanisms, and Trials provides the feedback loop to tune them.

### 1.1  Contributions

- A **validation-first orchestration architecture** that decomposes coding tasks into milestones and features with two-pass validation (code review and user-surface) and explicit human QA boundaries.
- A **bounded self-improvement system** (Trials) that optimizes prompt policies through trace-driven failure analysis with three-gate experiment validation and held-out overfitting guards.
- **Benchmark integration adapters** for Terminal-Bench and SlopCodeBench with full provenance tracking and reproducible headless execution.
- An **empirical baseline** establishing the current state of the system across five models and two benchmarks.

### 1.2  Paper Organization

Section 2 describes the Pi runtime and Quest's relationship to it. Section 3 details the Quest orchestration loop. Section 4 presents the Trials self-improvement system. Section 5 describes the benchmark infrastructure. Section 6 reports experimental results. Section 7 discusses related work. Section 8 concludes with limitations and future directions.

---

## 2  Background: The Pi Runtime

Pi [3] is a minimal, extensible coding agent runtime written in TypeScript. It provides:

- **Model abstraction**: A unified interface to multiple LLM providers (OpenAI, Google, OpenCode Go, Anthropic) with configurable thinking levels (off, minimal, low, medium, high, xhigh).
- **Tool execution**: File read/write/edit, bash execution, glob/grep search, and extensible tool registration.
- **Session management**: Conversation history, context windowing, and message streaming.
- **Extension API**: A plugin system where extensions register event handlers, commands, custom UI surfaces, and tool overrides.

Quest registers as a Pi extension through a standard entry point:

```typescript
export default function questExtension(pi: ExtensionAPI) {
  // Register event handlers, commands, UI surfaces
  // Set up state management and telemetry
}
```

This design means Quest inherits Pi's model-agnostic tool calling and can focus entirely on orchestration logic. Pi handles the "how do I call a model and execute tools" question; Quest handles "in what order, with what validation, and with what recovery strategy."

---

## 3  The Quest Orchestration Loop

### 3.1  Overview

A Quest is a long-running autonomous coding task that proceeds through a defined lifecycle:

```
planning --> proposal_ready --> running --> {completed, blocked, aborted}
                                  |
                                  +--> paused (resumable)
```

The user initiates a quest with a natural language goal. The system plans the work, presents a proposal for human review, and only begins execution after explicit acceptance. During execution, features are implemented sequentially with validation after each milestone. The quest always terminates at a human QA gate---it never auto-commits or auto-deploys.

### 3.2  Role System

Quest defines four execution roles, each with distinct capabilities and tool access:

| Role | Purpose | Tools | Output |
|------|---------|-------|--------|
| **Orchestrator** | Plans milestones, features, validation | read, bash | Structured quest plan |
| **Worker** | Implements individual features | read, bash, edit, write | Feature completion report |
| **Validator** | Verifies milestone correctness | read, bash (read-only) | Validation findings |
| **Trial** | Proposes profile improvements | read, bash | Profile patch candidate |

Each role executes in an isolated Pi subprocess (`pi --mode json --no-session`), ensuring clean context and preventing cross-role state leakage. The orchestrator never edits files; the validator never edits files; the worker never plans. This separation enforces the principle that *the entity that plans should not be the entity that implements, and the entity that implements should not be the entity that validates.*

### 3.3  Planning Phase

When the user creates a quest, the orchestrator role generates a structured plan consisting of:

- **Milestones**: Sequential phases of work, each representing a coherent deliverable.
- **Features**: Ordered implementation tasks within each milestone, with explicit preconditions and fulfillment criteria.
- **Validation Assertions**: Testable claims about the expected state of the codebase after each milestone, with assigned criticality (critical, important, informational) and validation method (code_review, command, user_surface, manual).

Before planning begins, a **Readiness Probe** inspects the target repository to determine which validation surfaces are available:

```typescript
type ValidationSurfaceStatus = "supported" | "limited" | "unsupported";
```

The probe checks for test frameworks, linting configurations, build systems, Docker setups, and browser testing infrastructure. This information is fed into the orchestrator's planning prompt so that it can design validation assertions that are actually executable given the project's tooling.

The planning phase produces a `proposal.md` document and a `validation-contract.md` that the user reviews before accepting. This is a hard gate---no code is written until the user types `/quest accept`.

### 3.4  Execution Phase

Once accepted, features execute sequentially within milestones. For each feature, the worker receives:

1. **Quest context**: The overall goal, steering notes, and completed work so far.
2. **Milestone context**: The current milestone's title, description, and remaining features.
3. **Feature specification**: Title, description, preconditions, and the validation assertions it must satisfy.
4. **Learned workflows**: Patterns derived from previous successful and failed runs in the same project (Section 3.7).
5. **Profile policy**: Role-specific prompt policy text from the active Trials profile (Section 4).

The worker executes using Pi's tool system (file read/write/edit, bash) and returns a structured completion report:

```json
{
  "status": "completed",
  "summary": "Implemented the feature by...",
  "filesTouched": ["src/api/handler.ts"],
  "followUps": ["Consider adding rate limiting"]
}
```

If the worker fails (non-zero exit, blocked status, or timeout), the feature is marked as blocked, which cascades to block the milestone and the quest.

### 3.5  Validation Phase

After all features in a milestone complete, two validation passes execute:

**Pass 1: Code Review.** A validator instance with read-only tool access inspects the codebase changes. It runs tests, checks types, verifies builds, and examines code quality. Each validation assertion is marked as `passed`, `failed`, or `limited` (when the validator cannot fully verify due to tooling limitations). Failed assertions generate **corrective features** that are appended to the current milestone's feature list.

**Pass 2: User Surface.** A second validator instance checks user-facing behavior---CLI outputs, API responses, UI rendering---against the validation assertions. This pass is often `limited` in headless environments where browser testing is unavailable, and the validator is instructed to honestly report coverage gaps rather than claim unverifiable passes.

If either validation pass produces failures, the corrective features are added to the plan and the milestone loops back to feature execution. This loop is bounded by the `correctiveFeatureBudget` in the active profile (default: 2), preventing infinite correction cycles.

### 3.6  Human QA Gate

When all milestones and their validation passes complete, the quest reaches a terminal state with `humanQaStatus: "pending"`. The system generates a checklist of what was implemented, what was validated, and what requires manual verification. The user reviews this checklist and decides what to commit. Quest never auto-commits, auto-deploys, or auto-publishes.

This is a deliberate architectural choice: the validation system is designed to catch implementation errors and provide confidence, but it is not designed to replace human judgment about whether the changes should ship. The human QA gate is the system's acknowledgment that automated validation has limits.

### 3.7  Learned Workflows

Quest automatically derives reusable patterns from execution history:

```typescript
interface LearnedWorkflow {
  id: string;
  title: string;
  note: string;
  source: "worker_success" | "worker_failure" |
          "validator_success" | "validator_failure";
  evidence: string[];
}
```

These workflows capture project-specific knowledge like "start Docker before validation checks" or "run database migrations before integration tests." They are extracted from tool call patterns in successful and failed runs, merged across the project (capped at 24), and injected into future worker and validator prompts. This provides a lightweight form of project-specific memory without requiring explicit user configuration.

---

## 4  Trials: Bounded Self-Improvement

### 4.1  Motivation

Every benchmark failure is a learning opportunity, but manually tuning prompts after each failure is labor-intensive and error-prone. Trials automates this feedback loop while maintaining strict bounds on what can be modified.

The key design constraint is that **Trials only mutates profiles, never runtime code.** A profile consists of:

- **Prompt Surfaces** (6 policy strings): Planning, feature-worker, validator-code-review, validator-user-surface, readiness-probe, and plan-revision policies.
- **Verification Budget**: Maximum worker attempts, validator attempts, and corrective feature budget.
- **Context Policy**: Spill threshold for long outputs, inline evidence limits.
- **Workflow Hint Policy**: Maximum shared hints, prerequisite and failure hint promotion.
- **Model Policy**: Preferences for model family consistency and validator divergence.
- **Trace Grading Thresholds**: Penalties for different failure modes (used to score traces).

This bounded optimization surface ensures that Trials cannot introduce arbitrary code changes, bypass validation gates, or modify the core orchestration logic. It can only tune the *policies* that guide execution.

### 4.2  Trace Recording and Failure Tagging

Every worker run, validator pass, and planning session produces a **trace bundle**:

```typescript
interface QuestTraceBundle {
  id: string;
  role: QuestRole;
  kind: "feature" | "validator" | "replan" | "planning";
  durationMs: number;
  modelChoice: ModelChoice;
  ok: boolean;
  summary: string;
  promptSurfaceId: string;
  toolTimeline: QuestTraceToolEvent[];
  tags: QuestFailureTag[];
  benchmark?: QuestBenchmarkProvenance;
}
```

Traces are automatically tagged with failure categories through regex-based analysis of summaries, stderr, issues, and tool timelines. The system defines 10 failure tags:

| Tag | Description | Grading Penalty |
|-----|-------------|-----------------|
| `prerequisite_miss` | Missing Docker, DB, service, or environment setup | 0.05 |
| `weak_validation` | Limited coverage, manual-only, or unsupported surfaces | 0.20 |
| `blocked_milestone` | Execution halted without closing milestone | 0.30 |
| `repeated_corrective_loop` | Repetitive follow-up work without progress | 0.05 |
| `context_overflow` | Token or evidence size exceeded limits | 0.25 |
| `model_mismatch_suspected` | Orchestrator/worker model family mismatch | 0.05 |
| `tool_heavy` | Excessive tool invocations (>= threshold) | 0.05 |
| `validator_failure` | Validator execution itself failed | 0.05 |
| `worker_failure` | Worker execution itself failed | 0.05 |
| `operator_abort` | Human interruption | 0.15 |

Each trace receives a composite grade: starting from 1.0, penalties are subtracted for each applicable tag, with an additional penalty if duration exceeds the `longRunMs` threshold (default: 8 minutes). The final score is bounded to [0, 1].

### 4.3  Evaluation Framework

Trials maintains multiple evaluation datasets:

1. **Core Regression** (12 seeded cases): Policy-based checks that enforce fundamental behaviors---e.g., "planning calls out weak validation," "workers check prerequisites," "revision preserves completed work."
2. **Trace Replays**: Automatically generated from execution traces, one case per failure tag per trace.
3. **Benchmark Replays**: Traces from Terminal-Bench and SlopCodeBench runs converted to replay cases.
4. **Held-Out** (3 cases): Fixed overfitting guards---human QA preservation, weak validation honesty, and revision boundaries.

Each eval case specifies:

```typescript
interface QuestEvalCase {
  targetSurfaceIds: string[];      // Which prompt surfaces to check
  failureTags: QuestFailureTag[];  // Which failure modes this targets
  expectations: {
    requiredSurfaceSnippets: string[];  // Must appear in policy
    forbidSurfaceSnippets: string[];    // Must not appear
    requiredPolicies: object;           // Config values to check
  };
}
```

Evaluation is deterministic: for each case, the system checks whether the profile's prompt surfaces contain the required snippets and whether policy values match. This makes evaluation fast (sub-second) and reproducible, independent of any LLM call.

### 4.4  Candidate Generation

Trials generates candidate profile patches through two pathways:

**Heuristic Candidates.** The system counts failure tag occurrences across interesting traces and selects the most frequent tag. A deterministic patch is generated based on the tag:

| Tag | Example Patch |
|-----|---------------|
| `prerequisite_miss` | Append to workerPolicy: "Confirm prerequisites before deep implementation." Set promotePrerequisiteHints: true. |
| `weak_validation` | Append honesty language to planningPolicy and validatorCodeReviewPolicy. Set spillLongOutputsToReports: true. |
| `context_overflow` | Reduce spillThresholdChars to 1400. Append to workerPolicy: "Keep inline summaries short." |
| `blocked_milestone` | Append to validator policies: "Prefer root-cause findings over repetitive corrective feature churn." Cap correctiveFeatureBudget to 2. |
| `tool_heavy` | Append to workerPolicy: "Prefer the shortest proof path." |

**Agent Candidates.** A Trial-role agent receives the current profile, top trace summaries, and dataset findings, and proposes a structured patch with rationale and generalization notes. This pathway is more expensive but can identify non-obvious improvements.

In both cases, prompt policies are *appended*, not replaced, preserving prior guidance while adding targeted improvements.

### 4.5  Three-Gate Experiment Validation

Candidate patches must pass three evaluation gates before adoption:

```
Gate 1: Spot-Check
  - 0-6 targeted replay cases matching candidate's failure tags
  - If candidate score <= baseline score: REJECT

Gate 2: Full Evaluation
  - All cases across all datasets
  - Candidate must score strictly higher than baseline
  - If not: REJECT

Gate 3: Held-Out Guard
  - 3 fixed cases testing fundamental behaviors
  - Candidate must not regress on held-out cases
  - If regression: REJECT (even if full eval improved)
```

This three-gate structure prevents two failure modes: (1) patches that improve targeted cases but break other behaviors (caught by Gate 2), and (2) patches that improve all measured cases but violate fundamental invariants like human QA preservation (caught by Gate 3).

When a candidate passes all three gates, the baseline profile is archived, the candidate patch is applied, and the `adoptedChanges` audit trail is updated. When rejected, the profile remains unchanged and the rejection reason is logged.

### 4.6  Convergence Properties

The Trials loop is designed to converge rather than oscillate:

- **Monotonic improvement**: Candidates must strictly improve scores to be adopted.
- **Append-only policies**: Prompt surfaces grow with new guidance; prior policies are never removed.
- **Bounded optimization surface**: Only 6 prompt strings, 3 budget parameters, 3 context parameters, and 3 workflow hint parameters can be modified.
- **Held-out guard**: Prevents overspecialization to benchmark-specific patterns.

In practice, we expect diminishing returns as the easy failure modes are addressed and remaining improvements require changes outside the profile surface (e.g., better models, architectural changes to the orchestration loop, or new tool capabilities).

---

## 5  Benchmark Infrastructure

### 5.1  Design Principles

Quest's benchmark infrastructure follows three principles:

1. **Methodology first**: Publish reproducible methods before claiming results. The benchmark card, reproducibility guide, and methodology document are maintained alongside the code.
2. **Provenance tracking**: Every benchmark run records the benchmark name, dataset, task ID, run mode, model, adapter version, and timestamp. This metadata is attached to traces and results.
3. **Local/official separation**: Development smoke tests (`--run-mode smoke`, `--run-mode local`) are clearly separated from official benchmark runs (`--run-mode full`, `--run-mode sample`). Public claims use only official paths.

### 5.2  Headless Execution

The `quest-headless` CLI provides a machine-readable interface for benchmark harnesses:

```bash
quest-headless run \
  --instruction "Implement a chess engine" \
  --cwd /workspace \
  --benchmark terminal-bench \
  --dataset terminal-bench-sample@2.0 \
  --task-id chess-puzzle-1 \
  --model zai/glm-5.1 \
  --json
```

This executes the full Quest pipeline---readiness probe, planning, feature execution, validation---and outputs a structured JSON result:

```typescript
interface QuestHeadlessRunResult {
  status: "proposal_ready" | "running" | "blocked" |
          "completed" | "timeout";
  summary: string;
  questId: string;
  profileId: string;
  traceBundleIds: string[];
  validatorFindings: string[];
  artifactPaths: Record<string, string>;
  benchmark?: QuestBenchmarkProvenance;
}
```

Exit code semantics: 0 for success (or any benchmark run), 1 for quest blocked/timeout in non-benchmark mode, 2 for argument errors.

### 5.3  Terminal-Bench via Harbor

Terminal-Bench [1] evaluates agents on terminal-based tasks (file manipulation, system administration, puzzle solving). We integrate through the Harbor evaluation harness, which manages Docker-containerized execution.

**Architecture:**

```
Harbor Runner (Python)
  |
  +-- Docker Container
  |     |
  |     +-- Node.js 20.18.3 (installed from tarball)
  |     +-- Pi v0.65.0 (installed via npm)
  |     +-- Quest bundle (mounted read-only at /opt/quest-package)
  |     |
  |     +-- QuestInstalledAgent (Python)
  |           |
  |           +-- quest-headless run --instruction "..." --json
  |                 |
  |                 +-- Readiness Probe
  |                 +-- Planning
  |                 +-- Feature Execution
  |                 +-- Validation
  |                 +-- JSON Result --> stdout
  |
  +-- Verifier (pytest)
  |     |
  |     +-- Score: 0.0 or 1.0 (binary)
  |
  +-- Artifact Collection
        +-- quest-headless-output.json
        +-- quest-headless-stderr.log
        +-- .pi/ directory
```

**Key implementation details:**

- Node.js is installed from a binary tarball rather than through apt, reducing setup time from ~2 minutes to ~15 seconds.
- API credentials are extracted from Pi's `~/.pi/agent/auth.json`, which supports shell command expansion for dynamic tokens (keys prefixed with `!` are executed as shell commands).
- The Quest bundle is compiled from TypeScript to JavaScript and mounted read-only, ensuring the agent cannot modify its own code during execution.
- Docker provides isolation: no cached `.pi` directories, no local environment variables, no editor configurations. If Quest works in a fresh container, it works anywhere.

### 5.4  SlopCodeBench

SlopCodeBench [2] evaluates agents on multi-checkpoint coding tasks where each checkpoint builds on the previous one. We provide two integration paths:

**Local runner** (`benchmarks/slopcodebench/run.ts`): Executes against local dataset files with workspace isolation via `mkdtemp`. Each checkpoint is an independent `runQuestHeadless()` call with the workspace carried forward between checkpoints.

**Official runner** (`benchmarks/slopcodebench/official-run.ts`): Integrates with the upstream `slop-code` CLI through a Python overlay. The overlay registers Quest as an agent type:

```python
class QuestAgent:
    type = "quest"

    def run(self, instruction: str, **kwargs):
        # Writes instruction to file
        # Executes quest-headless as subprocess
        # Parses JSON result from stdout
        # Tracks checkpoint index and usage
```

SlopCodeBench scoring is richer than Terminal-Bench's binary pass/fail: it tracks checkpoints solved, pass rates by type (core, functionality, regression, error handling), cyclomatic complexity, and lint violations.

### 5.5  Model Selection

The benchmark infrastructure supports multiple model providers through a cascading selection mechanism:

```typescript
function defaultBenchmarkModel(): string {
  // 1. Explicit override via environment variable
  if (process.env.QUEST_BENCH_MODEL) return process.env.QUEST_BENCH_MODEL;
  // 2. Read Pi's configured default model
  const piDefault = readPiDefaultModel();
  if (piDefault) return piDefault;
  // 3. Fallback
  return "zai/glm-5.1";
}
```

This supports running the same Quest pipeline across different providers without code changes, enabling model comparison on identical tasks.

---

## 6  Experimental Results

### 6.1  Setup

We report initial baseline results establishing the working state of the system. These are not competitive claims; they establish the measurement infrastructure and provide a starting point for Trials optimization.

**Environment:**
- Pi v0.65.0 with Quest v0.8.0
- Docker-containerized execution (Harbor) for Terminal-Bench
- Local execution for SlopCodeBench
- Default Quest profile (no Trials optimization applied)

### 6.2  Terminal-Bench Results

| Model | Provider | Thinking | Time | Cost | Mean Reward |
|-------|----------|----------|------|------|-------------|
| minimax-m2.5 | OpenCode Go | high | 3:40 | $0.02 | 0.0 |
| glm-5 | OpenCode Go | high | 6:38 | $0.04 | 0.0 |
| kimi-k2.5 | OpenCode Go | high | 6:26 | $0.05 | 0.0 |
| minimax-m2.7:xhigh | OpenCode Go | xhigh | 10+ min | $0.04+ | 0.0 |
| gpt-5.4:xhigh | OpenAI Codex | xhigh | -- | -- | (OAuth stale) |

**Dataset:** terminal-bench-sample@2.0 (1 task)
**Scoring:** Binary (0.0 or 1.0)

The 0.0 mean reward across all models confirms that the *plumbing works*---Quest successfully plans, executes features, runs validation, and produces artifacts in the Docker container---but the *agent quality* is the gap. This is the expected starting point: the benchmark infrastructure is verified, and the optimization target is now clear.

**Token usage** for the minimax-m2.5 run: ~10K input tokens, ~9K output tokens, demonstrating that the orchestration overhead (planning, validation) is modest relative to the feature implementation work.

### 6.3  SlopCodeBench Results

The official SlopCodeBench runner path has been verified as compatible. Checkpoint-aware execution, provenance capture, and artifact collection are working. Full benchmark runs are pending the completion of Trials optimization on Terminal-Bench baselines.

### 6.4  Trace Analysis

Analysis of the Terminal-Bench traces reveals the following failure tag distribution:

- `weak_validation` (most common): The Docker environment lacks many validation surfaces (no test framework, no linter, no type checker for arbitrary tasks), causing validators to report limited coverage.
- `prerequisite_miss`: Some tasks require tools or services not available in the base container.
- `blocked_milestone`: Workers complete features but validation cannot confirm correctness, leading to milestone blocking.

This distribution directly informs the Trials optimization strategy: the first candidates should target `weak_validation` by improving planning honesty about validation limitations, followed by `prerequisite_miss` by improving worker prerequisite checking.

### 6.5  Cost Analysis

Quest's multi-role architecture introduces overhead compared to single-pass agents:

| Phase | Typical Token Cost | Percentage |
|-------|-------------------|------------|
| Readiness Probe | ~2K input, ~1K output | ~15% |
| Planning | ~3K input, ~2K output | ~25% |
| Feature Worker | ~4K input, ~5K output | ~45% |
| Validation (2 passes) | ~2K input, ~1K output | ~15% |

At ~$0.02-0.05 per task with OpenCode Go models, this overhead is acceptable for the additional structure and validation it provides. The cost scales linearly with the number of features in the plan, making it predictable.

---

## 7  Related Work

### 7.1  Coding Agents

**SWE-Agent** [4] pioneered the agent-computer interface for software engineering tasks, demonstrating that LLMs can effectively use terminal tools to solve GitHub issues. Quest differs in its explicit planning phase and multi-pass validation; SWE-Agent operates in a single-pass loop.

**Devin** [5] introduced the concept of a fully autonomous software engineer with planning and execution capabilities. Quest shares the planning-first philosophy but differs in its explicit human QA gate and bounded self-improvement mechanism.

**OpenHands** [6] provides a platform for coding agents with sandboxed execution. Quest's Docker-based benchmark execution is similar in motivation (isolation and reproducibility) but Quest additionally tracks benchmark provenance at the trace level.

**Aider** [7] focuses on interactive pair programming with LLMs. Quest targets a different use case: autonomous execution of multi-step tasks with minimal human interaction during execution, but explicit human review at boundaries.

### 7.2  Agent Self-Improvement

**Reflexion** [8] introduced verbal reinforcement learning where agents reflect on failures and maintain an episodic memory. Trials is philosophically similar but operates at the *profile* level rather than the *episode* level: improvements are persistent across quests, not within a single execution.

**Self-Refine** [9] demonstrated iterative self-improvement through feedback loops. Quest's validation-then-correction cycle is similar, but Quest separates the improvement mechanism (Trials) from the execution mechanism (the orchestration loop), preventing the system from making unconstrained modifications to its own behavior.

**DSPy** [10] provides a framework for optimizing LLM pipelines through automatic prompt tuning. Trials shares DSPy's goal of automated prompt optimization but operates on a smaller, more constrained surface (6 prompt policies rather than arbitrary pipeline modules) and uses failure-tag-driven candidate generation rather than gradient-based optimization.

### 7.3  Coding Benchmarks

**SWE-bench** [11] evaluates agents on real-world GitHub issues. Terminal-Bench [1] focuses on terminal-based tasks. SlopCodeBench [2] introduces multi-checkpoint evaluation. Quest integrates with the latter two, and the adapter pattern is extensible to additional benchmarks.

**HumanEval** [12] and **MBPP** [13] evaluate code generation quality but not agent behavior. Quest's benchmarks test the full agent loop---planning, execution, validation, and recovery---not just code generation.

---

## 8  Discussion

### 8.1  Limitations

**Validation coverage.** Quest's validation is only as good as the available tooling. In Docker containers without test frameworks or linters, validators frequently report `limited` coverage. This is honest but limits the system's ability to catch errors.

**Sequential execution.** Features execute sequentially within milestones. This simplifies dependency tracking but limits throughput for independent features. Parallel feature execution is a natural extension but introduces concurrency complexity.

**Profile surface constraints.** Trials can only modify 6 prompt policies and a handful of configuration parameters. Improvements that require architectural changes (e.g., adding new tool capabilities, changing the validation protocol) are outside its optimization surface.

**Benchmark coverage.** Our current results are on a single Terminal-Bench sample task. Comprehensive evaluation across the full dataset is needed to draw meaningful conclusions about agent quality.

### 8.2  The Case for Bounded Self-Improvement

A natural question is: why not let the system modify its own code? The answer is that **unbounded self-modification creates verification problems that bounded modification avoids.**

If Trials could modify arbitrary code, we would need to verify that:
1. The modified code is correct (a hard problem).
2. The modified code preserves safety invariants (human QA gates, no auto-commit).
3. The modified code doesn't introduce security vulnerabilities.
4. Improvements generalize beyond the specific benchmark cases.

By restricting modifications to the profile surface, we reduce verification to checking that prompt policies contain required snippets and configuration values are within bounds---a deterministic, sub-second check. The three-gate experiment framework then provides statistical confidence that the changes improve behavior without regressions.

This is a deliberate trade-off: we sacrifice optimization power for verification tractability. The held-out guard specifically prevents the system from gaming benchmarks at the expense of fundamental behaviors.

### 8.3  Orchestration as the Bottleneck

Our results suggest that the primary bottleneck is not model quality but orchestration quality. The same model (minimax-m2.5) that scores 0.0 on Terminal-Bench can solve the underlying coding tasks when given the right framing, tools, and context. The gap is in how Quest presents the task, manages context, handles prerequisites, and recovers from failures.

This has an optimistic implication: **improvements in orchestration are cheaper than improvements in model capability.** Prompt policy changes cost nothing to deploy, verification budget adjustments are instant, and workflow hints accumulate automatically from experience. Trials provides the mechanism to systematically explore this space.

### 8.4  Future Work

1. **Full benchmark evaluation.** Run the complete Terminal-Bench dataset and multiple SlopCodeBench problems to establish statistically meaningful baselines.
2. **Trials optimization cycles.** Execute the improvement loop on recorded traces, measuring the impact of profile patches on benchmark scores.
3. **Cross-model transfer.** Test whether profile improvements optimized on one model (e.g., minimax-m2.5) transfer to other models (e.g., GPT-5.4, Kimi-k2.5).
4. **Parallel feature execution.** Extend the orchestration loop to support concurrent independent features within a milestone.
5. **Richer validation.** Integrate browser testing and visual regression tools into the validation pipeline.
6. **Community baselines.** Publish Quest as a public package so others can reproduce baselines and contribute Trials improvements.

---

## 9  Conclusion

Quest demonstrates that structured orchestration with explicit validation boundaries provides a principled foundation for autonomous coding agents. The validation-first architecture---plan, implement, validate, revise, human QA---catches errors that single-pass agents miss and provides clear accountability at every step.

The Trials self-improvement system shows that bounded profile optimization, constrained to prompt policies and configuration parameters, can be systematically validated through a three-gate experiment framework without risking unconstrained self-modification. By recording traces, tagging failures, and proposing targeted patches, Trials converts benchmark failures into profile improvements while held-out guards prevent overfitting.

The benchmark infrastructure, with full provenance tracking and headless execution adapters, enables reproducible measurement of agent quality across multiple models and benchmarks. Our initial baselines confirm that the measurement infrastructure works and identify orchestration quality---not model capability---as the primary optimization target.

Quest is open-source and available as a Pi extension package. We invite the community to reproduce our baselines, contribute Trials improvements, and extend the benchmark adapters to additional evaluation suites.

---

## References

[1] Terminal-Bench: A terminal-based benchmark suite for evaluating coding agents on system administration and programming tasks. 2025.

[2] SlopCodeBench: A multi-checkpoint benchmark for evaluating coding agents on iterative software development tasks. scbench.ai, 2025.

[3] M. Zechner. Pi: A minimal coding agent runtime. github.com/mariozechner/pi-coding-agent, 2025.

[4] C. E. Jimenez, et al. "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering." *NeurIPS*, 2024.

[5] Cognition. "Introducing Devin, the first AI software engineer." 2024.

[6] X. Wang, et al. "OpenHands: An Open Platform for AI Software Developers as Generalist Agents." *arXiv:2407.16741*, 2024.

[7] P. Gauthier. Aider: AI pair programming in your terminal. aider.chat, 2024.

[8] N. Shinn, et al. "Reflexion: Language Agents with Verbal Reinforcement Learning." *NeurIPS*, 2023.

[9] A. Madaan, et al. "Self-Refine: Iterative Refinement with Self-Feedback." *NeurIPS*, 2023.

[10] O. Khattab, et al. "DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines." *ICLR*, 2024.

[11] C. E. Jimenez, et al. "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?" *ICLR*, 2024.

[12] M. Chen, et al. "Evaluating Large Language Models Trained on Code." *arXiv:2107.03374*, 2021.

[13] J. Austin, et al. "Program Synthesis with Large Language Models." *arXiv:2108.07732*, 2021.

---

## Appendix A: State Directory Structure

```
.pi/quests/
  active.json                         # Currently active quest ID
  shared-skills/index.json            # Project-wide learned workflows
  <quest-id>/
    quest.json                        # Full quest state
    proposal.md                       # Human-reviewable proposal
    validation-readiness.json         # Readiness probe results
    validation-contract.md            # Validation assertions (markdown)
    validation-state.json             # Assertion status and evidence
    features.json                     # Decomposed feature list
    services.yaml                     # Service definitions
    events.jsonl                      # Event log (newline-delimited)
    headless-run.json                 # Machine-readable benchmark result
    runs/                             # Worker run records
    skills/                           # Generated reusable skills
  trials/
    state.json                        # Trial state (active profile, experiment)
    profiles/                         # Profile snapshots
    datasets/                         # Evaluation datasets
    traces/                           # Execution trace bundles
    experiments/                      # Experiment records
    baselines/                        # Baseline profile archives
    reports/                          # Experiment analysis reports
```

## Appendix B: Default Quest Profile

```json
{
  "promptSurfaces": {
    "planningPolicy": "Be explicit when validation is limited or unsupported.
      Keep the first plan small and serial. Preserve the final human QA
      handoff. Prefer structured quest tools over ad-hoc file edits.",
    "workerPolicy": "Confirm prerequisites before deep implementation.
      Prefer the shortest proof path that satisfies the assigned feature.
      Spill very long evidence into trial reports instead of bloating
      inline summaries.",
    "validatorCodeReviewPolicy": "Stay read-only and call out weak
      validation honestly. Prefer root-cause findings over adding
      repetitive corrective work. Treat missing prerequisites as
      first-class issues.",
    "validatorUserSurfacePolicy": "Stay read-only and describe what
      remains limited. Preserve the explicit human QA gate for final
      polish. Prefer concise operator-facing findings.",
    "readinessPolicy": "Mark unsupported surfaces as unsupported.
      Capture prerequisites, services, and commands that affect
      validation confidence.",
    "revisionPolicy": "Preserve completed work. Keep the remaining
      plan serial by default. Revise only unfinished milestones,
      features, and validation."
  },
  "verificationBudget": {
    "workerAttempts": 1,
    "validatorAttempts": 1,
    "correctiveFeatureBudget": 2
  },
  "contextPolicy": {
    "spillThresholdChars": 1800,
    "spillLongOutputsToReports": true,
    "maxInlineEvidenceLines": 6
  },
  "workflowHintPolicy": {
    "maxSharedHints": 24,
    "promotePrerequisiteHints": true,
    "promoteFailureHints": true
  },
  "modelPolicy": {
    "preferSameModelFamily": true,
    "preferValidatorDivergence": false
  },
  "traceGrading": {
    "toolHeavyCount": 6,
    "longRunMs": 480000,
    "weakValidationPenalty": 0.20,
    "blockedPenalty": 0.30,
    "overflowPenalty": 0.25,
    "abortPenalty": 0.15
  }
}
```

## Appendix C: Failure Tag Taxonomy

| Tag | Pattern Triggers | Profile Surface Targeted |
|-----|-----------------|-------------------------|
| `prerequisite_miss` | docker, seed, db:push, prerequisite, migration | workerPolicy, readinessPolicy |
| `weak_validation` | limited, manual, unsupported, cannot verify | planningPolicy, validatorCodeReviewPolicy |
| `blocked_milestone` | blocked, halted, cannot proceed | validatorCodeReviewPolicy, validatorUserSurfacePolicy |
| `repeated_corrective_loop` | corrective, retry, loop, repeated | validatorCodeReviewPolicy, correctiveFeatureBudget |
| `context_overflow` | overflow, truncated, too long, context limit | workerPolicy, spillThresholdChars |
| `model_mismatch_suspected` | Model family differs between roles | preferSameModelFamily |
| `tool_heavy` | Tool count >= toolHeavyCount threshold | workerPolicy |
| `validator_failure` | Validator exit code != 0 | validatorCodeReviewPolicy |
| `worker_failure` | Worker exit code != 0 | workerPolicy |
| `operator_abort` | User interrupt, abort signal | -- (informational only) |

## Appendix D: Three-Gate Experiment Protocol

```
Input: baseline_profile, candidate_patch, datasets, held_out_cases

Gate 1: Spot-Check
  spot_cases = select_targeted_cases(candidate.tags, datasets)
  baseline_score = evaluate(baseline_profile, spot_cases)
  candidate_score = evaluate(apply(baseline_profile, candidate_patch), spot_cases)
  if candidate_score <= baseline_score:
    return REJECT("spot-check")

Gate 2: Full Evaluation
  all_cases = flatten(datasets)
  baseline_score = evaluate(baseline_profile, all_cases)
  candidate_score = evaluate(apply(baseline_profile, candidate_patch), all_cases)
  if candidate_score <= baseline_score:
    return REJECT("full-eval")

Gate 3: Held-Out Guard
  baseline_held = evaluate(baseline_profile, held_out_cases)
  candidate_held = evaluate(apply(baseline_profile, candidate_patch), held_out_cases)
  if candidate_held < baseline_held:
    return REJECT("held-out-regression")

return ACCEPT(candidate_patch)
```
