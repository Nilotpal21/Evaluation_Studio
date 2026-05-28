# Runtime Improvements: Prompt Optimization & Pipeline Architecture

**Date:** 2026-03-06
**Status:** Approved
**Author:** Prasanna Arikala + Claude

---

## 1. Executive Summary

Two-phase runtime improvement for reasoning agent execution quality, latency, and cost.

**PR 1 — Prompt & Tool Schema Improvements:** Always-on changes to `prompt-builder.ts` and `reasoning-executor.ts`. No new infrastructure. Delivers immediate quality wins for all agents regardless of model.

**PR 2 — Pipeline Module:** Opt-in classification and tool filtering pipeline that runs before the reasoning loop. Adds short-circuit routing, tool set reduction, and multi-intent detection. Valuable for weaker models, supervisor agents with many handoff targets, and high-throughput cost optimization. Disabled by default.

**Key insight from benchmarking:** For well-designed agents with good prompts on GPT-4.1, prompt improvements are the primary value driver. The pipeline adds incremental value for specific use cases. Both are independently deployable and toggleable.

---

## 2. PR 1: Prompt & Tool Schema Improvements

Changes to existing files only. Always on — no configuration toggles.

### 2.1 Remove `reason` Parameter from Tool Schemas

**File:** `prompt-builder.ts` line 532

Currently every tool gets an injected `reason` parameter (required string). It's stripped before execution in `reasoning-executor.ts` (lines 793-814, 1103-1120) — purely observability. Costs ~100 tokens per tool set.

**Change:** Remove `reason` injection from:

- Regular tools (line 532)
- `__handoff__`, `__delegate__`, `__fan_out__`, `__set_context__` schemas

**Keep `reason` on:**

- `__escalate__` — operational field, forwarded to human agent handoff (line 808-812)
- `__return_to_parent__` — operational field, forwarded to parent supervisor (line 808-812)

**`thought` parameter — NO CHANGES.** Extended thinking and thought streaming remain exactly as-is. The `thought` parameter is gated by `enableThinking` (line 534) and powers the thought streaming UI. Stripping code in `reasoning-executor.ts` already handles `reason` being undefined gracefully (destructuring with `...rest` omits it). Trace events fire on `reason || thought`, so thought-only traces still work.

### 2.2 Add "Do NOT Repeat Actions" Instruction

**File:** `prompt-builder.ts` template context

Add to system prompt template:

```
Do NOT repeat tool calls you have already made in this conversation unless the user explicitly asks you to retry.
```

Prevents redundant tool calls observed in benchmarks (e.g., calling `check_account_balance` again when data was already in conversation context).

### 2.3 Tool Result Truncation for Old Iterations

**File:** `reasoning-executor.ts` within the while loop (before LLM call at line 333)

After iteration N+2, replace old tool results in the message array with `[Result from {tool_name} — see earlier in conversation]`. The LLM already saw the full result; keeping the full JSON wastes tokens on later iterations.

The existing `MAX_TOOL_RESULT_CHARS = 50_000` (line 85) truncates per-result size. This new truncation is per-iteration staleness — complementary, not redundant.

**Implementation:** Add a `truncateOldToolResults(messages, currentIteration, keepRecent=2)` function that walks the message array and replaces tool result content for iterations older than `currentIteration - keepRecent`.

### 2.4 Enhance `__handoff__` Description

**File:** `prompt-builder.ts` **handoff** tool construction (lines 637-673)

Currently the handoff tool description is interpolated with target names. Enhance to include brief capability descriptions for each target, so the LLM can make better routing decisions from the tool schema alone without duplicating routing descriptions in the system prompt body.

### 2.5 Structured Output Enforcement Prompt

**File:** `prompt-builder.ts` template context

Add to system prompt template:

```
Always call the relevant tool before making factual claims about account data or actions. Never state that an action was completed unless a tool call confirmed it.
```

Addresses the hallucination pattern where models claim actions without executing tools.

### 2.6 Files Modified (PR 1)

| File                                                        | Change                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/services/execution/prompt-builder.ts`     | Remove `reason` injection (2.1), add prompt instructions (2.2, 2.5), enhance handoff description (2.4) |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Add tool result truncation (2.3)                                                                       |

---

## 3. PR 2: Pipeline Module

New opt-in module. Disabled by default. Single hook point in the reasoning executor.

### 3.1 Architecture

New directory: `apps/runtime/src/services/pipeline/`

```
pipeline/
  index.ts              -- PipelineExecutor (single entry point)
  classifier.ts         -- intent classification + multi-intent detection
  tool-filter.ts        -- tool set reduction
  types.ts              -- PipelineConfig, ClassifierResult, FilterResult
```

**Hook point in `reasoning-executor.ts`** — before the while loop (around line 308):

```typescript
// Before the reasoning loop
if (pipelineConfig.enabled) {
  const pipelineResult = await this.pipeline.run(
    session,
    messages,
    tools,
    pipelineConfig,
    onTraceEvent,
  );
  if (pipelineResult.shortCircuit) {
    return this.routing.handleHandoff(session, pipelineResult.handoffInput, onChunk, onTraceEvent);
  }
  if (pipelineResult.filteredTools) {
    tools = pipelineResult.filteredTools;
  }
}
// Existing while loop continues with (possibly filtered) tools
```

### 3.2 Classifier

Single LLM call to the pipeline model. Structured output:

```typescript
interface ClassifierResult {
  intents: Array<{
    target: string | null; // null = handle in-agent
    confidence: number; // 0.0 - 1.0
    summary: string; // brief description, e.g., "billing dispute"
  }>;
  should_execute_in_agent: boolean;
  matched_tools: string[];
}
```

**Short-circuit rule:** Only when `intents.length === 1 && intents[0].confidence >= threshold && intents[0].target !== null`. All other cases fall through to the reasoning loop.

**Keyword veto:** After classification, zero-cost regex check. If user message contains tool-action keywords (e.g., "refund", "cancel", "update") that match in-agent tool names or descriptions, veto the short-circuit. Configurable keyword list per agent.

### 3.3 Tool Filter

Single LLM call to pipeline model:

```
Select 2-6 most relevant tools for the next agent step.
If no tools are needed (e.g. farewell, thanks), return {"tools": []}.
Return ONLY valid JSON: {"tools": ["name1", "name2"]}
```

Falls back to full tool set on:

- JSON parse failure
- Fewer than 2 tools matched
- Empty tools array when message clearly needs action

### 3.4 Execution Modes

**Parallel (`pipeline.mode: 'parallel'`):** Classifier and tool filter run via `Promise.all()`. Overhead = `max(classify, filter)` instead of `sum`. Tool filter result is discarded on short-circuit (wasted pipeline tokens, but no added latency).

**Sequential (`pipeline.mode: 'sequential'`):** Classifier runs first. If short-circuit, skip tool filter entirely (saves pipeline tokens). If no short-circuit, run tool filter.

Default: `'parallel'`.

### 3.5 Pipeline Model Resolution

The pipeline uses its own LLM call — not the session's `llmClient`. Resolution:

```
Agent IR execution.pipeline.model -> Project config pipeline.model -> hardcoded default
```

The pipeline model must be configured as an available model endpoint in the platform (self-hosted or cloud API key).

### 3.6 Multi-Intent Handling

**Detection:** The classifier returns `intents` as an array. Multi-intent is detected when `intents.length > 1`.

**Behavior matrix:**

| Scenario                                   | Action                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Single intent, high confidence, has target | Short-circuit to target                                           |
| Single intent, low confidence              | Fall through to reasoning loop with filtered tools                |
| Single intent, in-agent (target: null)     | Fall through to reasoning loop with filtered tools                |
| Multi-intent, same target                  | Short-circuit to target (both intents go to same place)           |
| Multi-intent, different targets            | No short-circuit. Fall through with tools from all intents merged |
| Multi-intent, mixed (in-agent + handoff)   | No short-circuit. One intent is in-agent, can't route away        |

**Tool merging on multi-intent:** When multiple intents are detected and we fall through, the tool filter results from each intent are unioned. If intent 1 needs `[process_refund, get_transaction_history]` and intent 2 needs `[update_subscription]`, the reasoning loop sees all 3.

**Fan-out for supervisors:** Supervisor agents already have the `__fan_out__` system tool for parallel multi-intent dispatch. The pipeline doesn't invoke fan-out directly — it ensures the LLM sees all relevant tools and lets it decide whether to call `__fan_out__` or handle sequentially.

### 3.7 Trace Events

The pipeline emits trace events for observability:

| Event Type               | Data                                                  | When                       |
| ------------------------ | ----------------------------------------------------- | -------------------------- |
| `pipeline_classify`      | intents, confidence, model, latencyMs                 | After classification       |
| `pipeline_filter`        | original tool count, filtered tools, model, latencyMs | After tool filtering       |
| `pipeline_short_circuit` | target, confidence, intent summary                    | On short-circuit routing   |
| `pipeline_keyword_veto`  | matched keywords, vetoed target                       | When keyword veto fires    |
| `pipeline_multi_intent`  | intent count, targets, merged tools                   | When multi-intent detected |

### 3.8 Files Modified (PR 2)

| File                                                        | Change                                               |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `apps/runtime/src/services/pipeline/index.ts`               | New — PipelineExecutor                               |
| `apps/runtime/src/services/pipeline/classifier.ts`          | New — classifier + multi-intent                      |
| `apps/runtime/src/services/pipeline/tool-filter.ts`         | New — tool set reduction                             |
| `apps/runtime/src/services/pipeline/types.ts`               | New — PipelineConfig, ClassifierResult, FilterResult |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Add pipeline hook before while loop                  |

---

## 4. Configuration

### 4.1 Project-Level Config

Extends existing project runtime settings:

```typescript
interface ProjectPipelineConfig {
  pipeline?: {
    enabled?: boolean; // default: false
    mode?: 'parallel' | 'sequential'; // default: 'parallel'
    model?: string; // default: 'qwen3-30b'
    shortCircuit?: {
      enabled?: boolean; // default: true
      confidenceThreshold?: number; // default: 0.85
    };
    toolFilter?: {
      enabled?: boolean; // default: true
      maxTools?: number; // default: 6
    };
  };
  prompts?: {
    injectDoNotRepeat?: boolean; // default: true
    injectToolBeforeClaim?: boolean; // default: true
    truncateOldToolResults?: boolean; // default: true
    truncateAfterIterations?: number; // default: 2
  };
}
```

Pipeline defaults to `enabled: false` — opt-in at project level. Prompt improvements are always-on code changes; the `prompts` config exists only as escape hatches if a specific project needs to disable them.

### 4.2 Agent-Level Override

Extends `AgentIR.execution`:

```typescript
interface ExecutionConfig {
  // ... existing fields (max_iterations, model, temperature, etc.) ...
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    model?: string;
    shortCircuit?: {
      enabled?: boolean;
      confidenceThreshold?: number;
    };
    toolFilter?: {
      enabled?: boolean;
      maxTools?: number;
    };
    keywordVeto?: {
      enabled?: boolean; // default: true
      keywords?: string[]; // agent-specific keyword list
    };
  };
}
```

### 4.3 Resolution Order

```
Agent IR execution.pipeline  ->  Project pipeline config  ->  hardcoded defaults
```

Merge strategy: agent-level fields override project-level where specified. Unset fields fall through to project, then to defaults. Same pattern as `model`, `temperature`, `enable_thinking` today.

### 4.4 What's NOT Configurable

- **Prompt improvements from PR 1** — always-on code changes (with `prompts.*` escape hatches)
- **Multi-intent detection** — always on when classifier is enabled
- **Classifier output schema** — fixed, not user-configurable
- **Keyword veto** — on by default, can be disabled per agent but not per project

---

## 5. Benchmark Context

This design is informed by benchmarking documented in:

- `docs/plans/2026-03-06-pipeline-benchmark-results.md` — full benchmark data across 4 pipeline models, 6 scenarios
- `docs/plans/2026-03-06-reasoning-engine-optimization-design.md` — phased optimization roadmap

**Key findings:**

- **Prompt improvements** (PR 1) deliver quality wins for all agents regardless of model
- **Pipeline short-circuit** eliminates GPT-4.1 calls entirely on high-confidence routing turns (0 calls vs 3-5)
- **Tool filtering** helps most when tool count is high (12+) or model is weaker
- **For GPT-4.1 with well-designed agents,** prompt improvements are the primary win; pipeline is incremental
- **For weaker/cheaper models** (Qwen, Haiku), pipeline delivers significant quality and latency improvements
- **Cost is driven by call count reduction** (fewer output tokens at $8.00/1M), not input token savings (halved by prompt caching)

---

## 6. Verification Plan

### PR 1

- Unit tests for `truncateOldToolResults()` function
- Integration test: verify `reason` is NOT in regular tool schemas, IS in `__escalate__` and `__return_to_parent__`
- Integration test: verify `thought` parameter unchanged (extended thinking not broken)
- Integration test: verify "do NOT repeat" and "tool before claim" present in built system prompt
- Existing test suite passes (regression)

### PR 2

- Unit tests for classifier (single intent, multi-intent, keyword veto)
- Unit tests for tool filter (happy path, parse failure fallback, empty tools)
- Unit tests for PipelineExecutor (parallel mode, sequential mode, short-circuit, fall-through)
- Integration test: pipeline disabled = no overhead, executor path unchanged
- Integration test: pipeline enabled with mock pipeline model, verify short-circuit routing
- Integration test: multi-intent detection prevents short-circuit, merged tools passed to loop
- Trace event assertions for all pipeline events

## Implementation Plan

**Goal:** Improve reasoning agent quality, latency, and cost via prompt optimizations (PR 1) and an opt-in pipeline module (PR 2).

**Architecture:** PR 1 modifies `prompt-builder.ts` and `reasoning-executor.ts` directly — no new files. PR 2 adds a new `services/pipeline/` module with classifier, tool filter, and multi-intent detection, hooked into the executor before the reasoning loop. Configuration extends `ExecutionConfig` (agent-level) and `ProjectRuntimeConfigIR` (project-level).

**Tech Stack:** TypeScript, Vitest, Express.js runtime, LLM provider abstraction via `SessionLLMClient`

---

### PR 1: Prompt & Tool Schema Improvements

#### Task 1: Remove `reason` parameter from regular tool schemas

Remove `reason` injection from regular tools, `__handoff__`, `__delegate__`, `__fan_out__`, `__set_context__` schemas in `prompt-builder.ts`. Keep `reason` on `__escalate__` and `__return_to_parent__` (operational fields forwarded to human agents). Verify `thought` parameter unchanged.

#### Task 2: Add "Do NOT Repeat Actions" instruction

Add to system prompt template in `prompt-builder.ts`: "Do NOT repeat tool calls you have already made in this conversation unless the user explicitly asks you to retry."

#### Task 3: Implement tool result truncation for old iterations

Add `truncateOldToolResults(messages, currentIteration, keepRecent=2)` function in `reasoning-executor.ts`. Replace old tool results (older than `currentIteration - keepRecent`) with `[Result from {tool_name} -- see earlier in conversation]`. Complementary to existing `MAX_TOOL_RESULT_CHARS = 50_000` per-result truncation.

#### Task 4: Enhance `__handoff__` tool description

Enhance handoff tool description with brief capability descriptions for each target agent and few-shot usage example showing correct handoff message format with account ID, issue summary, and structured context.

#### Task 5: Add structured output enforcement prompt

Add to system prompt: "Always call the relevant tool before making factual claims about account data or actions. Never state that an action was completed unless a tool call confirmed it."

#### Task 6: PR 1 integration tests

Verify `reason` NOT in regular tool schemas, IS in `__escalate__`/`__return_to_parent__`. Verify `thought` unchanged. Verify prompt instructions present. Existing test suite regression check.

### PR 2: Pipeline Module

#### Task 7: Create pipeline types

Create `apps/runtime/src/services/pipeline/types.ts` with `PipelineConfig`, `ClassifierResult` (intents array with target, confidence, summary), `FilterResult`, `PipelineResult`.

#### Task 8: Implement classifier

Create `apps/runtime/src/services/pipeline/classifier.ts`. Single LLM call to pipeline model returning structured intents. Short-circuit rule: single intent, confidence >= threshold, non-null target. Keyword veto: zero-cost regex check against tool-action keywords.

#### Task 9: Implement tool filter

Create `apps/runtime/src/services/pipeline/tool-filter.ts`. Single LLM call selecting 2-6 most relevant tools. Fallback to full tool set on JSON parse failure, fewer than 2 tools, or empty tools for action-needed messages.

#### Task 10: Implement PipelineExecutor

Create `apps/runtime/src/services/pipeline/index.ts`. Orchestrates classifier and tool filter. Parallel mode: `Promise.all()`. Sequential mode: classifier first, skip filter on short-circuit. Returns `PipelineResult` with optional `shortCircuit` and `filteredTools`.

#### Task 11: Hook pipeline into reasoning executor

Add pipeline hook in `reasoning-executor.ts` before the while loop. If `pipelineResult.shortCircuit`, route directly via `this.routing.handleHandoff()`. If `pipelineResult.filteredTools`, replace tools for reasoning loop.

#### Task 12: Add pipeline configuration to IR

Extend `ExecutionConfig` with `pipeline?` block (enabled, mode, model, shortCircuit, toolFilter, keywordVeto). Extend `ProjectRuntimeConfigIR` with project-level pipeline config. Resolution order: Agent IR -> Project config -> hardcoded defaults.

#### Task 13: Multi-intent handling

Handle multi-intent detection (intents.length > 1). Same target: short-circuit. Different targets: fall through with merged tools. Mixed in-agent + handoff: fall through. Union tool filter results from each intent.

#### Task 14: Pipeline trace events

Emit: `pipeline_classify`, `pipeline_filter`, `pipeline_short_circuit`, `pipeline_keyword_veto`, `pipeline_multi_intent`.

#### Task 15: PR 2 tests

Unit tests for classifier, tool filter, PipelineExecutor. Integration tests for disabled pipeline, enabled with mock model, multi-intent detection. Trace event assertions.

---

## Appendix: Benchmarking Data

### Pipeline Model Comparison (from `2026-03-06-runtime-pipeline-design.md`)

**Setup:** GPT-4.1 for reasoning. 4 pipeline model candidates for CLASSIFY + TOOL FILTER.

#### Simple Scenario (4 turns)

| Pipeline Model   | Avg Turn    | Cost        | Tool Filtering                |
| ---------------- | ----------- | ----------- | ----------------------------- |
| None (Baseline)  | 2,041ms     | $0.0155     | N/A                           |
| GPT-4.1-nano     | 3,047ms     | $0.0136     | Moderate (1/4 turns filtered) |
| Claude Haiku 4.5 | 3,430ms     | $0.0227     | Poor (0/4 filtered)           |
| Gemini 2.5 Flash | 3,656ms     | $0.0176     | Poor (0/4 filtered)           |
| **Qwen3-30B**    | **2,791ms** | **$0.0087** | **Best (3/4 filtered)**       |

#### Complex Scenario (5 turns)

| Pipeline Model   | Avg Turn    | Cost        | Short-Circuits |
| ---------------- | ----------- | ----------- | -------------- |
| None (Baseline)  | 3,390ms     | $0.0265     | N/A            |
| GPT-4.1-nano     | 3,831ms     | $0.0173     | 0/5            |
| Claude Haiku 4.5 | 3,739ms     | $0.0221     | 2/5            |
| Gemini 2.5 Flash | 5,040ms     | $0.0321     | 0/5            |
| **Qwen3-30B**    | **2,189ms** | **$0.0065** | **3/5**        |

**Winner: Qwen3-30B** — fastest, cheapest, best classifier and tool filter.

### Pipeline Mode Comparison

| Mode                        | Simple Scenario   | Complex Scenario    | Quality |
| --------------------------- | ----------------- | ------------------- | ------- |
| A: No pipeline              | 9,394ms           | 26,928ms            | 6/9     |
| B: Sequential pipeline      | 13,154ms (+40%)   | 16,007ms (-41%)     | 5/9     |
| C: Sequential + optimized   | 11,316ms (+20%)   | 12,814ms (-52%)     | 8/9     |
| **D: Parallel + optimized** | **9,125ms (-3%)** | **13,987ms (-48%)** | **8/9** |

### Reasoning Engine Optimization Analysis (from `2026-03-06-reasoning-engine-optimization-design.md`)

#### Root Cause Analysis — Token Bloat Sources

| Source                                           | Waste                                               | Location                         |
| ------------------------------------------------ | --------------------------------------------------- | -------------------------------- |
| System prompt rebuilt every iteration            | Breaks prompt cache across 5-10 iterations per turn | `reasoning-executor.ts:286, 654` |
| `context_json` uses pretty-printed JSON          | ~2x token overhead vs minified                      | `prompt-builder.ts:268`          |
| Full conversation history passed every iteration | Grows linearly; fan-out results up to 50K chars     | `reasoning-executor.ts:167-172`  |
| Routing descriptions duplicated                  | Doubled for every supervisor                        | `prompt-builder.ts:606-634`      |
| `reason` field injected into every tool schema   | ~9 copies per agent, zero behavioral value          | `prompt-builder.ts:531-532`      |
| No `cache_control` breakpoints set               | Zero cache markers in codebase                      | `session-llm-client.ts`          |

#### Estimated Per-Turn Token Savings (Supervisor Agent, 8 specialists, 12 tools)

| Optimization                       | Tokens Saved Per Call        | Calls Affected              |
| ---------------------------------- | ---------------------------- | --------------------------- |
| Prompt caching (stable prefix)     | ~3000 (90% of cached prefix) | Every iteration after first |
| Tool pre-filtering (15 -> 5 tools) | ~1000 per iteration          | Every iteration             |
| Remove `__fan_out__` schema        | ~500                         | Every iteration             |
| Remove `reason` from all tools     | ~150                         | Every iteration             |
| Deduplicate routing descriptions   | ~300                         | Every iteration             |
| Minify `context_json`              | ~100                         | Every iteration             |
| Truncate old tool results          | ~2000 per truncated result   | Iterations 3+               |
| History compaction (long sessions) | ~3000-5000                   | All calls in session        |

**Conservative estimate:** 40-60% reduction in input tokens per turn for a typical supervisor agent.

#### Phased Rollout

**Phase 1 (No New Dependencies):** Stop rebuilding system prompt every iteration, minify context_json, remove `__fan_out__`, gate system tools, make `reason`/`thought` optional, deduplicate routing descriptions, truncate old tool results, add `cache_control` breakpoints, narrative casting on handoffs, stuck loop escalation, few-shot examples on `__handoff__`, reduce `MAX_TOOL_RESULT_CHARS`. Expected: 30-40% token reduction.

**Phase 2 (Small Model Offloading):** CLASSIFY stage for supervisors, EXTRACT stage for GATHER agents, tool pre-filtering per iteration, platform default operation models. Expected: additional 20-30% primary model token reduction, 30-50% fewer primary model calls.

**Phase 3 (History Compaction):** COMPACT stage (async post-turn), summary injection on subsequent turns, configurable thresholds. Expected: bounded context growth for long sessions.
