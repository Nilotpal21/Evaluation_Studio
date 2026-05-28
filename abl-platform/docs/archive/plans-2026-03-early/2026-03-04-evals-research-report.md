# ABL Platform Evals — Research Report & Gap Analysis

**Date:** 2026-03-04
**Status:** Research Report — maps industry findings to `COPILOT_ARCHITECT_EVALS_SPEC.md`
**Scope:** Methodology, architecture, competitive positioning, and actionable recommendations

---

## Executive Summary

The existing evals spec defines a solid **Personas × Scenarios × Evaluators** matrix model with visual heat map results — a differentiated UX. However, the spec was written before reviewing the 2024-2026 wave of evaluation research, and contains inaccuracies (e.g., references Prisma models when the codebase uses Mongoose/MongoDB). This report identifies **12 gaps** and **8 validated decisions** by mapping the spec against:

- 10+ academic papers (AgentBench, SWE-bench, MultiAgentBench, LLM-as-Judge surveys)
- Anthropic's "Demystifying Evals for AI Agents" (2025) — the practitioner gold standard
- 8 industry tools (Braintrust, LangSmith, Arize, DeepEval, promptfoo, Langfuse, Humanloop, W&B)
- Enterprise evaluation frameworks (KDD 2025, EMNLP 2025)

**Key finding:** The spec's UI/UX is ahead of most competitors. The gaps are in evaluation methodology (how scores are produced and validated) and operational infrastructure (CI/CD, cost controls, dataset versioning, online monitoring).

---

## Table of Contents

1. [Validated Decisions](#1-validated-decisions)
2. [Methodology Gaps](#2-methodology-gaps)
3. [Architecture Gaps](#3-architecture-gaps)
4. [Competitive Analysis](#4-competitive-analysis)
5. [Research-Backed Recommendations](#5-research-backed-recommendations)
6. [Appendix: Research Sources](#appendix-research-sources)

---

## 1. Validated Decisions

These aspects of the existing spec align with or exceed industry best practices.

### 1.1 Matrix Model (Personas × Scenarios × Evaluators)

**Spec:** Cartesian product of personas, scenarios, and evaluators with configurable variants.

**Research validation:** This is the standard evaluation paradigm. Anthropic's guide calls it "Task × Trial × Grader." MultiAgentBench (ACL 2025) uses milestone-based KPIs across agent topologies. The matrix model naturally supports the combinatorial explosion needed for thorough agent testing.

**Verdict:** ✅ Well-designed. The "variants" slider (defaulting to 3) maps directly to Anthropic's recommendation to "run multiple trials due to model non-determinism."

### 1.2 Heat Map Visualization

**Spec:** Color-coded Persona×Scenario grid with per-evaluator scores, click-to-expand detail, and run comparison with delta indicators.

**Research validation:** No competing tool offers this as a first-class visual. Braintrust shows tabular diffs. LangSmith shows experiment comparisons. The heat map is a genuine differentiator — it makes score patterns immediately visible (e.g., "frustrated personas consistently score low on emotion management").

**Verdict:** ✅ Unique differentiator. Strengthen it.

### 1.3 LLM-as-Judge + Code-Based Scorers

**Spec:** Supports `llm_judge` and `rule_based` evaluator types. Backend has `LLMJudgeEvaluator` and `CodeScorerEvaluator` with built-in scorers (turnEfficiency, repetition, errorOutcome, toolSuccess, containment).

**Research validation:** Anthropic explicitly recommends three grader types: code-based (fast, cheap, deterministic), model-based (flexible, nuanced), and human (gold standard). The spec covers the first two. The built-in code scorers map well to operational metrics.

**Verdict:** ✅ Good foundation. Needs bias mitigation and human grading (see Gap 2.1 and 2.3).

### 1.4 Connected Journey (Evals → Architect → Copilot)

**Spec:** "Fix in Architect →" button, post-modification eval suggestions, conversation transcript pre-loading.

**Research validation:** This is rare in the industry. Most eval tools are standalone (Braintrust, DeepEval, promptfoo). Only LangSmith partially connects traces to prompt editing. The closed-loop "evaluate → diagnose → fix → re-evaluate" workflow is a strong enterprise differentiator.

**Verdict:** ✅ Major competitive advantage. No competitor offers this.

### 1.5 Persona Simulation Architecture

**Spec:** LLM simulates persona behavior based on communicationStyle, domainKnowledge, behaviorTraits, goals, constraints.

**Research validation:** "Evaluating LLM-based Agents for Multi-Turn Conversations" (arXiv 2503.22458) identifies user simulation as the standard approach for reproducible multi-turn testing. The spec's persona model captures the right dimensions.

**Verdict:** ✅ Sound approach. Add persona calibration (see Gap 2.5).

### 1.6 Progressive Disclosure (4-Layer UI)

**Spec:** Layer 0 (Glance) → Layer 1 (Interact) → Layer 2 (Configure) → Layer 3 (Code).

**Research validation:** DeepEval and promptfoo are code-first (Layer 3 only). LangSmith and Braintrust are form-first (Layer 2). No competitor offers a visual-first experience with progressive depth. This maps well to enterprise personas (exec glances at heat map, engineer drills into transcripts).

**Verdict:** ✅ Best-in-class UX philosophy.

### 1.7 Async Event-Driven Evaluation Dispatcher

**Spec/Code:** `EvaluationDispatcher` subscribes to `session.ended` events, fans out to registered evaluators with sampling config and budget caps.

**Research validation:** This is the correct architecture for online evaluation. Arize Phoenix and Langfuse use similar event-driven patterns. The sampling config (random, stratified, anomaly-triggered) is more sophisticated than most competitors.

**Verdict:** ✅ Well-architected for production.

### 1.8 AI-Assisted Generation

**Spec:** AI-generate personas from agent analysis, AI-generate scenarios from flow/handoff analysis, Quick Eval one-click workflow.

**Research validation:** Anthropic's Bloom (2025) demonstrates automated generation of targeted behavioral evaluations. The spec's approach of generating from existing agent structure is more targeted than Bloom's general approach. Starting with AI suggestions (not empty forms) is a strong UX principle.

**Verdict:** ✅ Aligned with Bloom research. Excellent "AI proposes, human disposes" pattern.

---

## 2. Methodology Gaps

These are missing or underspecified evaluation science elements.

### Gap 2.1: LLM-as-Judge Bias Mitigation — CRITICAL

**What's missing:** The spec defines LLM judge configuration (model, prompt, temperature, CoT) but has no bias mitigation strategy.

**What research says:**

The "Survey on LLM-as-a-Judge" (arXiv 2411.15594) documents four major biases:

| Bias                      | Impact                                              | Mitigation                                                                    |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Position bias**         | Swapping response order shifts accuracy >10%        | Evaluate twice with swapped order, average scores                             |
| **Verbosity bias**        | Longer responses score higher regardless of quality | Normalize for length; penalize unnecessary verbosity in rubric                |
| **Self-enhancement bias** | Models favor outputs from their own family          | Use cross-model judges (if agent uses Claude, judge with GPT, and vice versa) |
| **Authority bias**        | Scores influenced by attributed source              | Blind evaluation — strip model/source attribution from transcripts            |

**Recommendation:**

- Add `biasSettings` to `EvalEvaluator` model: `{ positionSwap: boolean, blindEvaluation: boolean, crossModelJudge: boolean }`
- Default: position swap ON, blind evaluation ON
- Surface bias mitigation status in evaluator cards ("bias-mitigated" badge)
- Allow configuring a different judge model family than the agent's model

### Gap 2.2: Scoring Rubric Design — HIGH

**What's missing:** The spec allows free-text `scoringRubric` and `scaleType` ("1-5", "1-10", "pass/fail") but provides no guidance on rubric construction.

**What research says:**

"Rubric Is All You Need" (ACM ICER 2025) demonstrates:

- **Question-specific rubrics dramatically outperform question-agnostic rubrics**
- **5-point scales are optimal** — high-precision float scales (0-10) cause consistency issues
- Each score point needs an explicit behavioral anchor (not just "1=poor, 5=excellent")

"RULERS" (arXiv 2601.08654) proposes Locked Rubrics with Evidence-Anchored Scoring:

- Each rubric point must cite specific evidence from the transcript
- Judges must provide evidence before scoring (not justify after)

**Recommendation:**

- Deprecate "1-10" scale option. Support only: `1-5` (nuanced) and `pass/fail` (binary)
- Require structured rubrics with per-point behavioral anchors:
  ```
  5: Agent resolves issue completely, uses empathetic language, handles objections
  4: Agent resolves issue, adequate tone, minor gaps in empathy
  3: Agent partially resolves, some confusion, neutral tone
  2: Agent fails to resolve, dismissive or robotic tone
  1: Agent causes escalation, incorrect information, or safety violation
  ```
- Ship 3-5 built-in rubric templates per agent type (conversational, tool-using, supervisor)
- Add "evidence-first" mode for LLM judges: extract evidence, then score (RULERS pattern)

### Gap 2.3: Human-in-the-Loop Evaluation — MEDIUM

**What's missing:** The spec has no human evaluation workflow. All evaluation is automated.

**What research says:**

Anthropic recommends three grader types: code-based, model-based, **and human**. Human grading serves two purposes:

1. **Gold standard calibration**: Periodically compare LLM judge scores against human expert scores to detect judge drift
2. **Edge case resolution**: When automated graders disagree or score with low confidence, route to human review

70% of enterprises adopted RLHF/DPO for alignment by 2025 (up from 25% in 2023). Labelbox, Humanloop, and LangSmith all offer human review workflows.

**Recommendation:**

- Add `human_review` as a third evaluator type alongside `llm_judge` and `rule_based`
- When LLM judge confidence < threshold (e.g., 0.6), flag conversation for human review
- Human review UI: show transcript + LLM judge's score + reasoning, human confirms/overrides
- Track human-vs-LLM agreement rate as a meta-metric for judge reliability
- This can be Phase 2+ (not critical for MVP)

### Gap 2.4: Trajectory Evaluation (Not Just Final Outcomes) — HIGH

**What's missing:** The spec evaluates conversation outcomes via LLM judges scoring the full transcript. It doesn't evaluate the agent's trajectory — the sequence of decisions, tool calls, handoffs, and state transitions.

**What research says:**

AgentBoard introduces **Progress Rate** (comparing agent trajectory against expected trajectory) and **Step Success Rate** (percentage of plan steps executed). MultiAgentBench uses **milestone-based KPIs** tracking intermediate objectives.

Anthropic's key insight: **"Grade outcomes, not specific paths"** — but also monitor trajectory for safety and efficiency. An agent may reach the right answer through an unsafe or wasteful path.

"Internal Representations as Indicators of Hallucinations in Agent Tool Selection" (2025) highlights that tool-calling correctness requires semantic validation beyond structural checks.

**Recommendation:**

- Add trajectory-aware evaluator type that scores:
  - **Tool call correctness**: Right tools, right parameters, right order
  - **Handoff appropriateness**: Did the agent route to the correct specialist?
  - **Path efficiency**: How many turns/tool calls vs. optimal path?
  - **Safety path**: Did the agent avoid unsafe intermediate states?
- Leverage existing `traceEvents` in `EvalConversationResult` — they already capture the trajectory
- Add `expectedMilestones` to `EvalScenario`: ordered list of checkpoints the agent should hit
- Built-in trajectory scorers (extend existing `CodeScorerEvaluator`):
  - `milestoneCompletionScorer`: % of expected milestones achieved
  - `handoffCorrectnessScorer`: did handoffs match `agentPath`?
  - `toolSequenceScorer`: were tools called in a valid order?

### Gap 2.5: Persona Calibration & Diversity — MEDIUM

**What's missing:** The spec defines persona attributes but doesn't address: (a) how to validate that the LLM actually behaves like the persona, (b) how to ensure persona diversity covers the real user population.

**What research says:**

"Evaluating LLM-based Agents for Multi-Turn Conversations" (arXiv 2503.22458) warns that simulated users can be unrealistically cooperative or adversarial. User simulation fidelity must be validated.

Anthropic's Bloom (2025) generates targeted behavioral evaluations for specific traits, ensuring diversity across the evaluation space.

**Recommendation:**

- Add persona validation: after generating a persona's first message, score it against persona attributes (is the tone actually frustrated? does it reflect beginner knowledge?)
- Add persona diversity analysis: show coverage across communication style × domain knowledge × behavior traits dimensions
- Add "adversarial persona" templates: personas designed to break the agent (social engineering, off-topic, abusive, prompt injection)
- Add `fidelityScore` metadata to persona runs: how well did the simulated persona stay in character?

### Gap 2.6: Statistical Significance — MEDIUM

**What's missing:** The spec shows score averages and deltas between runs but has no statistical validation.

**What research says:**

The "Survey on LLM-as-a-Judge" recommends 7+ complementary statistics: Pearson, Spearman, and Kendall correlations plus leniency metrics. Mann-Whitney U tests assess differences in grade distributions. Confidence intervals are essential.

Anthropic recommends Pass@k (at least 1 success in k trials) and Pass^k (all k trials succeed) depending on use case.

**Recommendation:**

- For run comparisons: compute confidence intervals, not just raw deltas. Show "statistically significant improvement" vs "within noise"
- For variants: report Pass@k and Pass^k alongside averages
- Minimum 3 variants per cell (already the default — good). Recommend 5 for high-stakes evaluations
- Add statistical summary to run results: mean, std dev, confidence interval, significance test result
- Visual indicator on heat map: solid border = statistically significant, dashed = inconclusive

---

## 3. Architecture Gaps

These are missing infrastructure and system design elements.

### Gap 3.1: Online vs. Offline Evaluation Separation — HIGH

**What's missing:** The spec conflates two different evaluation modes into one system. The existing `EvaluationDispatcher` in eventstore handles online (production) evaluation. The spec's Personas×Scenarios matrix is offline (pre-deployment) evaluation. They need different architectures.

**What research says:**

| Dimension  | Offline (Spec's Matrix)           | Online (Eventstore Dispatcher) |
| ---------- | --------------------------------- | ------------------------------ |
| Trigger    | Manual "Run" button or CI/CD      | `session.ended` event          |
| Data       | Synthetic (persona simulation)    | Real production conversations  |
| Purpose    | Pre-deployment regression testing | Production quality monitoring  |
| Cost model | Bounded (known matrix size)       | Unbounded (production traffic) |
| Scoring    | Full evaluator suite              | Sampled, budget-capped         |

**Recommendation:**

- Explicitly separate the two modes in the architecture:
  - **Offline Evals** (the spec's matrix model): Studio UI, manual or CI-triggered, synthetic conversations
  - **Online Evals** (the eventstore dispatcher): Production monitoring, real conversations, sampling-based
- Both share the same evaluator definitions and scoring infrastructure
- Studio UI should have a "Production Monitoring" tab alongside the existing 5 tabs, showing:
  - Real-time quality scores from production traffic
  - Anomaly alerts (score drops below threshold)
  - Drill-down to specific production conversations that scored low
- Connect them: when online monitoring detects a regression, auto-suggest running the relevant offline eval set

### Gap 3.2: CI/CD Pipeline Integration — HIGH

**What's missing:** No CI/CD integration. Evals are only triggered manually from the Studio UI.

**What research says:**

Braintrust's GitHub Action posts detailed eval comparisons on PRs showing which cases improved/regressed. promptfoo integrates via YAML configs. DeepEval integrates via pytest. The pattern is universal:

```
Code Change → PR Gate (smoke evals) → Merge → Nightly Full Eval → Pre-Deploy Gate → Production Monitoring
```

**Recommendation:**

- Add eval trigger API: `POST /api/projects/:projectId/evals/runs` should be callable from CI/CD
- Add eval status API: `GET /api/projects/:projectId/evals/runs/:id/status` for polling
- Add eval comparison API: `GET /api/projects/:projectId/evals/runs/compare?baseline=X&current=Y`
- Define tiered evaluation:
  - **PR gate** (fast, <2 min): Run a small "smoke" eval set (5-10 conversations) against the changed agent
  - **Nightly** (comprehensive): Run full regression eval sets
  - **Pre-deploy gate**: Run all eval sets, fail deployment if scores regress beyond threshold
- Provide a CLI tool or GitHub Action wrapper that calls these APIs
- Add `regressionThreshold` to `EvalSet`: if any evaluator drops by more than this delta vs. baseline, the run is marked "regression detected"
- Store baseline run ID per eval set for automatic comparison

### Gap 3.3: Cost Estimation and Controls — HIGH

**What's missing:** The spec's open question #2 asks about cost estimation but doesn't resolve it. No cost controls beyond the eventstore's `dailyBudgetCap`.

**What research says:**

Cost is a primary concern in every industry framework. LLM evaluations involve:

1. **Conversation generation cost**: persona LLM calls × turns × token count
2. **Judging cost**: judge LLM calls × evaluators × conversations
3. **Re-run cost**: variants multiply both costs

For a matrix of 3 personas × 5 scenarios × 3 evaluators × 3 variants = 135 judge calls plus 45 multi-turn conversations. At $0.01-0.05 per conversation turn and $0.01-0.03 per judge call, a single run can cost $5-50+.

**Recommendation:**

- **Pre-run cost estimation**: Before clicking "Start Run", show estimated cost breakdown:
  - Conversations: P × S × V × avgTurns × costPerTurn
  - Judging: P × S × V × E × costPerJudge
  - Total: sum with confidence range
- **Budget guards**: Set per-project monthly eval budget. Warn when a run would exceed remaining budget
- **Cost tracking**: Record actual cost per run (tokens used, API costs). Show cost trend over time
- **Cost optimization**: Offer "economy mode" (smaller judge model, fewer variants) vs "thorough mode"
- Add `estimatedCost` and `actualCost` fields to `EvalRun` model
- Add `monthlyCostBudget` to project settings

### Gap 3.4: Dataset Versioning — MEDIUM

**What's missing:** Personas, scenarios, and evaluators are mutable records. There's no versioning. When a persona is edited and a run is re-executed, there's no way to know which version of the persona was used.

**What research says:**

Every evaluation framework emphasizes versioning. Braintrust, LangSmith, and DeepEval all version datasets alongside prompts. Without versioning, you can't:

- Reproduce a past run exactly
- Know if a score change came from agent improvement or eval change
- Audit evaluation history

**Recommendation:**

- Add `version` (auto-incrementing integer) to `EvalPersona`, `EvalScenario`, `EvalEvaluator`
- `EvalConversationResult` should snapshot the persona/scenario/evaluator versions used (not just IDs)
- Alternative: immutable records with soft-delete. Each edit creates a new record; old versions are preserved
- Add `personaVersion`, `scenarioVersion`, `evaluatorVersion` to `EvalConversationResult`
- Show version in run details: "Run #3 used Persona v2, Scenario v1, Evaluator v3"

### Gap 3.5: Eval Runner Scalability — MEDIUM

**What's missing:** The spec describes a sequential execution flow (resolve matrix → loop conversations → loop evaluators). No concurrency model.

**What research says:**

Large eval sets can have 100+ conversations. Sequential execution would take hours. The eventstore's `maxConcurrency` config exists but isn't connected to the offline eval runner.

**Recommendation:**

- Add concurrency control to the eval runner:
  - Concurrent conversation generation (limited by runtime capacity)
  - Concurrent judge evaluation (limited by LLM API rate limits)
  - Configurable via `EvalSet.maxConcurrency` (default: 5)
- SSE progress reporting should stream individual cell completions (already implied in spec)
- Add cancellation: `POST /runs/:id/cancel` should gracefully stop in-progress conversations
- Add resume: if a run fails partway, allow resuming from where it left off (skip completed cells)
- Queue-based architecture: submit eval jobs to a queue, workers pull and execute. Decouples UI from execution

### Gap 3.6: ABL DSL `evaluations` Block — LOW (but strategic)

**What's missing:** The analytics gap analysis identified this. ABL has no grammar for defining evaluations inline with agent definitions.

**What research says:**

promptfoo's YAML-first approach and DeepEval's code-first approach both advocate for evaluation-as-code alongside agent definitions. Having evals co-located with agent source enables version control, code review, and CI/CD.

**Recommendation:**

- Add an optional `EVALUATIONS:` block to ABL DSL:
  ```
  EVALUATIONS:
    builtin: [task_completion, safety, tool_correctness]
    custom:
      - name: "empathy_check"
        type: llm_judge
        rubric: |
          5: Exceptionally empathetic...
          1: Dismissive or cold...
  ```
- Compiler extracts evaluator configs from DSL and registers them with the project
- This enables evaluation-as-code: evals travel with the agent definition in version control
- Lower priority — the Studio UI approach works fine for most users. DSL is for power users

---

## 4. Competitive Analysis

### 4.1 Feature Matrix

| Capability                 | ABL Evals (Spec) | Braintrust | LangSmith | Arize Phoenix | DeepEval | promptfoo |
| -------------------------- | :--------------: | :--------: | :-------: | :-----------: | :------: | :-------: |
| **Persona simulation**     |        ✅        |     ❌     |    ❌     |      ❌       |    ❌    |    ❌     |
| **Visual heat map**        |        ✅        |     ❌     |    ❌     |      ❌       |    ❌    |    ❌     |
| **Matrix eval (P×S×E)**    |        ✅        |     ❌     |  Partial  |      ❌       |    ❌    |  Partial  |
| **LLM-as-judge**           |        ✅        |     ✅     |    ✅     |      ✅       |    ✅    |    ✅     |
| **Code-based scorers**     |        ✅        |     ✅     |    ✅     |      ✅       |    ✅    |    ✅     |
| **Human review**           |        ❌        |     ✅     |    ✅     |      ❌       |    ❌    |    ❌     |
| **CI/CD integration**      |        ❌        |  ✅ Best   |    ✅     |      ❌       |    ✅    |  ✅ Best  |
| **Run comparison/diffs**   |        ✅        |  ✅ Best   |    ✅     |      ✅       |    ✅    |    ✅     |
| **Agent tracing**          |        ✅        |     ❌     |    ✅     |    ✅ Best    |    ❌    |    ❌     |
| **Production monitoring**  |     Partial      |     ✅     |    ✅     |    ✅ Best    |    ❌    |    ❌     |
| **Dataset versioning**     |        ❌        |     ✅     |    ✅     |      ❌       |    ✅    |    ✅     |
| **Cost tracking**          |        ❌        |     ✅     |    ❌     |      ✅       |    ❌    |    ❌     |
| **Bias mitigation**        |        ❌        |     ❌     |    ❌     |      ❌       | Partial  |    ❌     |
| **Trajectory evaluation**  |        ❌        |     ❌     |    ❌     |      ✅       |    ❌    |    ❌     |
| **Connected fix workflow** |        ✅        |     ❌     |  Partial  |      ❌       |    ❌    |    ❌     |
| **AI-generated evals**     |        ✅        |     ❌     |    ❌     |      ❌       |    ❌    |    ❌     |
| **Multi-agent aware**      |        ✅        |     ❌     |    ❌     |      ❌       |    ❌    |    ❌     |
| **Self-hosted**            |        ✅        |     ❌     |    ❌     |      ✅       |    ✅    |    ✅     |

### 4.2 Positioning Analysis

**ABL's unique advantages (no competitor has these):**

1. **Persona simulation with visual matrix** — No one else combines synthetic user simulation with combinatorial evaluation in a visual matrix
2. **Connected journey (Evals → Architect → Copilot)** — The closed-loop "evaluate → diagnose → fix → re-evaluate" workflow is unique
3. **Multi-agent awareness** — ABL understands agent topologies (supervisor → specialists), handoffs, and delegation. Competitors evaluate single LLM calls or chains
4. **AI-generated evaluation suites** — From agent structure, auto-generate personas, scenarios, and evaluators. Bloom is the only comparable approach (academic, not product)
5. **ABL DSL integration** — Evaluation definitions alongside agent code in a typed DSL

**ABL's gaps vs. competitors:**

1. **CI/CD integration** — Braintrust and promptfoo are far ahead here. Critical for enterprise adoption
2. **Production monitoring** — Arize Phoenix and LangSmith lead. The eventstore dispatcher exists but needs Studio UI
3. **Dataset versioning** — Table stakes for reproducibility. Most competitors have it
4. **Cost tracking** — Enterprises need budget visibility. Braintrust and Arize provide this
5. **Human review** — Braintrust and LangSmith offer it. Important for calibration and edge cases

**Strategic positioning:**

ABL Evals should position as **"the first evaluation system built for multi-agent platforms"** — not competing with generic LLM eval tools on their turf, but offering uniquely integrated evaluation:

- Understand agent topology (test handoffs, not just responses)
- Persona simulation (test with synthetic users, not just static datasets)
- Closed-loop improvement (evaluate → fix → re-evaluate without leaving the platform)
- Multi-dimensional scoring (trajectory + outcome + efficiency + safety)

### 4.3 Competitor Deep Dives

#### Braintrust — Best CI/CD Integration

**What they do well:**

- GitHub Action posts eval diffs directly on PRs
- Prompt versioning with experiment tracking
- Complete development loop: production traces → evals → prompt iteration

**What they lack:**

- No agent tracing or multi-agent awareness
- No persona simulation
- No visual matrix or heat map
- No connected fix workflow

**Learn from:** Their CI/CD integration pattern is the gold standard. The GitHub Action that posts score diffs on PRs is exactly what enterprise teams expect.

#### LangSmith — Best Tracing + Eval Integration

**What they do well:**

- Deep tracing integrated with evaluation
- Dataset management with versioning
- Strong experiment comparison views

**What they lack:**

- Tight LangChain ecosystem coupling
- No persona simulation or matrix evaluation
- Limited multi-agent awareness
- No connected fix workflow

**Learn from:** Their dataset management and experiment comparison UX is mature. Their tracing-to-eval pipeline is seamless.

#### Arize Phoenix — Best Open-Source Observability

**What they do well:**

- Leader in agent tracing (every prompt, tool call, agent step)
- OpenTelemetry-compatible instrumentation
- Self-hostable, data lake integration

**What they lack:**

- Weak on evaluation authoring (better at monitoring than testing)
- No persona simulation
- No CI/CD integration
- No connected fix workflow

**Learn from:** Their OpenInference tracing standard. Consider OTel compatibility for the evaluation pipeline.

#### DeepEval — Best Code-First Evaluation

**What they do well:**

- 60+ built-in metrics (hallucination, faithfulness, tool correctness, conversation-level)
- Pytest integration — evals run like unit tests
- Strong RAG evaluation capabilities

**What they lack:**

- No UI (code-only)
- No persona simulation or multi-agent awareness
- No production monitoring
- No connected fix workflow

**Learn from:** Their metric library is comprehensive. Consider adopting their metric definitions as built-in evaluators. Their `ToolCorrectnessMetric` and `ConversationRelevancyMetric` are well-designed.

#### promptfoo — Best for Security/Red-Teaming

**What they do well:**

- YAML-first configuration accessible to non-engineers
- Strong security testing and red-teaming capabilities
- CI integration with minimal setup

**What they lack:**

- No agent awareness (prompt-level evaluation only)
- No visual UI beyond basic tables
- No production monitoring

**Learn from:** Their red-teaming approach. Consider adding adversarial evaluation presets: prompt injection attempts, social engineering scenarios, off-topic attacks.

---

## 5. Research-Backed Recommendations

### Priority Matrix

| #   | Recommendation                                           | Priority | Effort | Impact | Research Source                            |
| --- | -------------------------------------------------------- | -------- | ------ | ------ | ------------------------------------------ |
| R1  | Add LLM judge bias mitigation                            | P0       | Medium | High   | LLM-as-Judge Survey (2411.15594)           |
| R2  | Structured rubric templates (5-point, evidence-anchored) | P0       | Low    | High   | Rubric Is All You Need (ICER 2025), RULERS |
| R3  | CI/CD trigger APIs + regression thresholds               | P0       | High   | High   | Braintrust, promptfoo patterns             |
| R4  | Pre-run cost estimation + budget guards                  | P1       | Medium | High   | Enterprise framework (2511.14136)          |
| R5  | Trajectory evaluation (milestones, tool correctness)     | P1       | Medium | High   | AgentBoard, MultiAgentBench                |
| R6  | Separate online/offline evaluation modes                 | P1       | Medium | Medium | Industry consensus                         |
| R7  | Dataset versioning (snapshot on run)                     | P1       | Low    | Medium | Braintrust, LangSmith                      |
| R8  | Statistical significance indicators                      | P2       | Low    | Medium | LLM-as-Judge Survey                        |
| R9  | Human review workflow (confidence threshold routing)     | P2       | High   | Medium | Anthropic guide, Humanloop                 |
| R10 | Adversarial/red-team persona templates                   | P2       | Low    | Medium | promptfoo, Bloom                           |
| R11 | ABL DSL `EVALUATIONS` block                              | P3       | High   | Low    | promptfoo YAML pattern                     |
| R12 | Production monitoring tab in Studio                      | P2       | High   | High   | Arize, Langfuse                            |

### R1: LLM Judge Bias Mitigation (P0)

**What to add to the spec:**

Extend `EvalEvaluator` model — new fields on Mongoose schema:

```typescript
// Additional fields on EvalEvaluator schema
{
  positionSwapEnabled: { type: Boolean, default: true },   // Mitigate position bias
  blindEvaluation:     { type: Boolean, default: true },   // Strip attribution
  crossModelJudge:     { type: Boolean, default: false },  // Use different model family
  evidenceFirstMode:   { type: Boolean, default: true },   // RULERS: extract evidence before scoring
}
```

**Execution change:** When `positionSwapEnabled`, run the judge twice (original order + swapped), average scores. When `blindEvaluation`, strip agent/model names from transcripts before judging.

**UI change:** Evaluator cards show bias mitigation badges. Evaluator creation form has "Bias Mitigation" section with toggles.

**Cost implication:** Position swap doubles judge cost. Worth it for high-stakes evaluations. Allow per-evaluator toggle.

### R2: Structured Rubric Templates (P0)

**What to add to the spec:**

Replace free-text `scoringRubric` with structured rubric:

```typescript
interface ScoringRubric {
  scaleType: '1-5' | 'pass-fail';
  points: Array<{
    value: number; // 1, 2, 3, 4, 5
    label: string; // "Excellent", "Good", etc.
    criteria: string; // Behavioral anchor
    examples?: string[]; // Example evidence
  }>;
}
```

Ship with built-in rubric templates:

- **Task Completion** (conversational agents): Did the agent resolve the user's issue?
- **Response Quality** (all agents): Clarity, relevance, coherence, completeness
- **Safety** (all agents): No harmful content, no hallucinated facts, no PII leakage
- **Empathy** (customer-facing agents): Tone, acknowledgment, de-escalation
- **Tool Correctness** (tool-using agents): Right tool, right params, right sequence
- **Handoff Quality** (multi-agent): Appropriate routing, context preservation

### R3: CI/CD Integration (P0)

**What to add to the spec:**

New API surface:

```
POST /api/projects/:projectId/evals/runs           # Trigger run (already exists)
  + body: { evalSetId, triggerSource: 'manual' | 'ci' | 'scheduled', baselineRunId? }
GET  /api/projects/:projectId/evals/runs/:id/status # Poll status
GET  /api/projects/:projectId/evals/runs/compare    # Compare runs
  + query: { baseline, current, format: 'json' | 'markdown' }
```

New `EvalSet` fields — on Mongoose schema:

```typescript
{
  regressionThreshold: { type: Number },         // Max acceptable score drop (e.g., 0.5)
  baselineRunId:       { type: String },         // Run to compare against
  ciEnabled:           { type: Boolean, default: false },
}
```

The compare API returns markdown-formatted diff suitable for PR comments:

```markdown
## Eval Results: CardUnblockFlow

| Cell                                  | Baseline | Current | Delta   |
| ------------------------------------- | -------- | ------- | ------- |
| Frustrated × CardBlock → EmotionMgmt  | 3.8      | 4.3     | +0.5 ✅ |
| Frustrated × FraudAlert → EmotionMgmt | 2.1      | 1.8     | -0.3 🔴 |

**Regression detected:** EmotionMgmt dropped on FraudAlert scenario
```

### R4: Cost Estimation (P1)

**What to add to the spec:**

Pre-run estimation endpoint:

```
POST /api/projects/:projectId/evals/estimate
  body: { evalSetId }
  response: {
    conversations: { count, estimatedTurns, estimatedTokens, estimatedCost },
    judging: { count, estimatedTokens, estimatedCost },
    total: { minCost, maxCost, estimatedDurationMinutes }
  }
```

Show estimation in "Start Run" modal:

```
Estimated cost: $3.20 - $8.50
  Conversations: 15 × ~8 turns = ~$2.40
  Judging: 45 calls = ~$1.35
  Duration: ~4-8 minutes

Monthly budget remaining: $91.50 / $100.00
```

### R5: Trajectory Evaluation (P1)

**What to add to the spec:**

Extend `EvalScenario` — new fields on Mongoose schema:

```typescript
{
  expectedMilestones: { type: [String] },  // Ordered checkpoints e.g. ["verify_identity", "lookup_account", "process_refund"]
  expectedAgentPath:  { type: [String] },  // Expected handoff sequence
  maxToolCalls:       { type: Number },    // Efficiency threshold
}
```

New built-in code scorers:

- `milestoneCompletionScorer`: Compare trace events against `expectedMilestones`, score = % completed
- `handoffCorrectnessScorer`: Compare actual agent handoffs against `expectedAgentPath`
- `pathEfficiencyScorer`: Actual turns/tool calls vs. expected maximum
- `toolSequenceScorer`: Validate tool call order and parameters against expected patterns

These leverage the existing `traceEvents` field in `EvalConversationResult` — no new infrastructure needed.

### R10: Adversarial Persona Templates (P2)

**What to add to the spec:**

Built-in adversarial persona templates:

- **Prompt Injector**: Attempts to extract system prompts, override instructions, or inject new behavior
- **Social Engineer**: Tries to access other users' data, escalate privileges, or bypass verification
- **Off-Topic Derailer**: Constantly steers conversation away from the agent's domain
- **Abusive User**: Tests the agent's de-escalation and safety boundaries
- **Edge Case Explorer**: Provides malformed inputs, extreme values, unicode, and boundary conditions

These test the agent's robustness and safety — a gap no competitor fills well except promptfoo's red-teaming.

---

## Appendix: Research Sources

### Academic Papers

| Paper                                     | Venue               | Year | Key Contribution                        |
| ----------------------------------------- | ------------------- | ---- | --------------------------------------- |
| Survey on Evaluation of LLM-based Agents  | arXiv 2503.16416    | 2025 | Definitive taxonomy of agent evaluation |
| Evaluation and Benchmarking of LLM Agents | KDD 2025            | 2025 | Enterprise evaluation framework         |
| A Survey on LLM-as-a-Judge                | arXiv 2411.15594    | 2024 | Bias documentation and mitigation       |
| LLMs-as-Judges Comprehensive Survey       | arXiv 2412.05579    | 2024 | Prompt engineering for judges           |
| Evaluating Multi-Turn Conversations       | arXiv 2503.22458    | 2025 | User simulation methodology             |
| Beyond Accuracy: Enterprise Framework     | arXiv 2511.14136    | 2025 | Multi-dimensional evaluation            |
| AgentBench                                | ICLR 2024           | 2024 | Multi-environment agent benchmark       |
| SWE-bench                                 | ICLR 2024 Oral      | 2024 | Software engineering agent eval         |
| MultiAgentBench                           | ACL 2025            | 2025 | Multi-agent milestone-based KPIs        |
| Rubric Is All You Need                    | ACM ICER 2025       | 2025 | Rubric design for LLM judges            |
| RULERS                                    | arXiv 2601.08654    | 2025 | Evidence-anchored scoring               |
| Tool Selection Hallucinations             | arXiv 2601.05214    | 2025 | Tool-calling correctness                |
| Mirage of Hallucination Detection         | EMNLP 2025          | 2025 | Hallucination metric reliability        |
| AgentA/B                                  | arXiv 2504.09723    | 2025 | Agent A/B testing methodology           |
| Bloom                                     | Anthropic Alignment | 2025 | Automated behavioral eval generation    |

### Industry Sources

| Source                                                                                                  | Type      | Key Takeaway                                              |
| ------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------- |
| [Anthropic: Demystifying Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Guide     | Task/Trial/Grader taxonomy, 8-step roadmap, Pass@k/Pass^k |
| [Braintrust](https://www.braintrust.dev)                                                                | Platform  | Best CI/CD integration, PR-level eval diffs               |
| [LangSmith](https://docs.langchain.com/langsmith/evaluation)                                            | Platform  | Dataset management, experiment comparison                 |
| [Arize Phoenix](https://arize.com)                                                                      | Platform  | Open-source observability, OTel-compatible tracing        |
| [DeepEval](https://github.com/confident-ai/deepeval)                                                    | Framework | 60+ metrics, pytest integration                           |
| [promptfoo](https://promptfoo.dev)                                                                      | Framework | YAML-first, red-teaming, CI integration                   |
| [Langfuse](https://langfuse.com)                                                                        | Platform  | Open-source monitoring, LLM-as-judge                      |
| [Humanloop](https://humanloop.com)                                                                      | Platform  | Human review workflows, CI/CD gates                       |
| [W&B Weave](https://wandb.ai)                                                                           | Platform  | Experiment tracking, eval-driven development              |

---

## Next Steps

This research report identifies gaps and recommendations. The next step is to:

1. **Prioritize**: Which gaps to address in which phase (P0 items for Phase 1)
2. **Update the spec**: Incorporate P0 and P1 recommendations into `COPILOT_ARCHITECT_EVALS_SPEC.md`
3. **Write implementation plan**: Detailed technical plan for building the eval system
4. **Prototype**: Build P0 items first (bias mitigation, rubric templates, CI/CD APIs)
