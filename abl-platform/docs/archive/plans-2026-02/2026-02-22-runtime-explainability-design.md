# Runtime Explainability Design

## Problem

After closing the 10 spec review gaps, the ABL runtime has ~18 areas where behavior is implicit, hard to trace, or silently fails. This creates two problems:

1. **Agent developers** can't troubleshoot when things don't work as expected
2. **Arch** (the AI assistant) can't explain what happened because trace events don't capture decisions

The root issue: the runtime makes decisions that are invisible to both humans and Arch. When a developer asks "why didn't my REMEMBER trigger fire?" or "why was the wrong field corrected?", neither the traces nor the docs give a clear answer.

---

## Scope

This design covers three workstreams:

- **W1: Decision Traces** — Emit trace events for every implicit decision
- **W2: Spec Clarity** — Update ABL docs to document all implicit behavior
- **W3: Arch Diagnostics** — Give Arch the ability to proactively diagnose common issues

---

## W1: Decision Traces

### Principle

Every decision point in the runtime should emit a trace event that answers: **what was decided, what alternatives existed, and why this path was chosen.**

### 18 Decision Points Requiring Traces

#### Category: Extraction & Strategy

| #   | Decision Point                                | Current Visibility | Proposed Trace Event                                                                     |
| --- | --------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- | -------------- | ------------ |
| 1   | Strategy resolution (field → block → default) | None               | `extraction_strategy_resolved` with `{ field, resolvedStrategy, source: 'field'          | 'block'        | 'default' }` |
| 2   | Pattern extraction attempted/matched/failed   | None               | `extraction_attempt` with `{ field, method: 'pattern', pattern, matched: bool, value? }` |
| 3   | LLM extraction JSON parse fallback to regex   | None               | `extraction_parse_fallback` with `{ field, primaryFailed: true, regexMatched: bool }`    |
| 4   | Hybrid fallback from LLM to pattern           | None               | `extraction_fallback` with `{ field, from: 'llm', to: 'pattern', reason: 'llm_error'     | 'no_result' }` |

#### Category: Memory

| #   | Decision Point                                      | Current Visibility | Proposed Trace Event                                                                   |
| --- | --------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- | ------------ | --------------------- |
| 5   | REMEMBER trigger evaluated (condition true/false)   | Only on success    | `memory_trigger_evaluated` with `{ trigger, condition, result: bool, reason? }`        |
| 6   | RECALL instruction fired (data found/not found)     | Only on success    | `memory_recall_result` with `{ event, factsFound: number, factsLoaded: string[] }`     |
| 7   | FactStore unavailable (no-op path taken)            | None               | `memory_unavailable` with `{ reason: 'no_fact_store'                                   | 'no_user_id' | 'no_memory_config' }` |
| 8   | Preference detected (pattern, category, confidence) | None               | `preference_detected` with `{ text, category, confidence, pattern }`                   |
| 9   | Memory error caught and swallowed                   | WARN log only      | `memory_error` with `{ operation, error, continued: true }` (already partially exists) |

#### Category: Constraints & Control Flow

| #   | Decision Point                                        | Current Visibility | Proposed Trace Event                                                               |
| --- | ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- | ---------------------- | --------- |
| 10  | Backtrack count incremented                           | None               | `constraint_backtrack` with `{ step, count, limit: 3, action: 'goto'               | 'retry' }`             |
| 11  | Backtrack limit reached → escalation                  | None               | `constraint_backtrack_limit` with `{ step, count: 3, fallbackAction: 'escalate' }` |
| 12  | Constraint directive type (terminal vs. control flow) | None               | `constraint_directive` with `{ constraint, action, type: 'terminal'                | 'control_flow' }`      |
| 13  | Mini-collect entered/exited                           | None               | `constraint_mini_collect` with `{ fields, phase: 'enter'                           | 'exit', result: 'pass' | 'fail' }` |

#### Category: Gather & Corrections

| #   | Decision Point                                                    | Current Visibility                | Proposed Trace Event                                                         |
| --- | ----------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------- | ------------------- |
| 14  | Field activation mode → field skipped/active                      | None                              | `gather_field_activation` with `{ field, activation, active: bool, reason }` |
| 15  | `complete_when` short-circuit (gather complete before all fields) | None                              | `gather_complete_reason` with `{ reason: 'complete_when'                     | 'all_fields'                          | 'check_complete', missingOptional: string[] }` |
| 16  | Correction field identification (which field matched, method)     | Partial (correction event exists) | Enrich existing `correction` event with `{ detectionMethod: 'regex'          | 'llm', fieldMatchReason: 'type_match' | 'last_string'                                  | 'llm_identified' }` |
| 17  | Dependent field invalidation after correction                     | New (added in Task 11)            | Already emits `correction_invalidation` — keep as-is                         |

#### Category: Session & Config

| #   | Decision Point                                    | Current Visibility | Proposed Trace Event                                                     |
| --- | ------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| 18  | LLM validation fail-open (error treated as valid) | WARN log only      | `validation_fail_open` with `{ field, rule, error, treatAsValid: true }` |

### Implementation Approach

Add a `TraceDecision` event type alongside existing `TraceEvent`:

```typescript
interface TraceDecision {
  type: 'decision';
  category: 'extraction' | 'memory' | 'constraint' | 'gather' | 'validation' | 'config';
  decision: string; // e.g. 'extraction_strategy_resolved'
  inputs: Record<string, unknown>; // what was evaluated
  result: string | boolean; // what was decided
  reason?: string; // human-readable explanation
  alternatives?: string[]; // what other paths existed
}
```

This is emitted via the existing `onTraceEvent` callback. No new infrastructure needed.

### Verbosity Control

Not all traces should be emitted in production. Add a `traceVerbosity` setting per session:

- **`minimal`** (default): Only errors, escalations, and completion events
- **`standard`**: Above + step transitions, tool calls, constraint checks
- **`verbose`**: Above + all decision traces (the 18 above)
- **`debug`**: Above + LLM prompts/responses, extraction details, memory operations

Set via session creation options or agent IR config:

```yaml
AGENT: My_Agent
DEBUG:
  trace_verbosity: verbose
```

---

## W2: Spec Clarity

### Documentation Gaps to Close

These are behaviors the runtime implements but the spec doesn't clearly document. Agent developers hit these as surprises.

#### 1. Extraction Strategy Selection Guide

**Gap:** Docs list three strategies but give no guidance on when to use each.

**Add to `TOOLS_AND_GATHER.md`:**

| Strategy           | Use When                                                 | Tradeoffs                                                           |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `pattern`          | Structured data (dates, emails, phone numbers, amounts)  | Fast, deterministic, but misses natural language variations         |
| `llm`              | Open-ended text, subjective fields, complex descriptions | Accurate but slower, costs LLM tokens, no regex fallback on failure |
| `hybrid` (default) | Most fields                                              | Best of both — pattern first, LLM fallback. Slight latency overhead |

**Add per-field strategy override syntax:**

```yaml
GATHER:
  STRATEGY: hybrid          # block default
  - destination:
    STRATEGY: llm            # override for this field
  - email:
    STRATEGY: pattern        # fast path for structured data
```

#### 2. Backtrack Semantics

**Gap:** `MAX_BACKTRACKS_PER_STEP = 3` is mentioned but semantics are undefined.

**Add to `CONSTRAINTS.md`:**

> **Backtrack limit:** When a constraint's `ON_FAIL` uses `GOTO` or `RETRY`, the runtime tracks how many times each step has been revisited due to constraint failures. After 3 backtracks to the same step, the runtime stops looping and escalates to a human agent.
>
> - The counter is per-step, per-session (not per-turn)
> - Both `GOTO` and `RETRY` increment the counter for their target step
> - The counter does NOT reset between user messages
> - When the limit is reached, the constraint's `ON_FAIL` action is ignored and the session escalates
>
> **To customize:** The limit is currently fixed at 3. If your workflow needs more iterations, restructure the flow to use separate steps for each retry attempt.

#### 3. Memory (REMEMBER/RECALL) Working Examples

**Gap:** Memory is documented syntactically but has zero working examples.

**Add to `ABL_QUICK_REFERENCE.md`:**

```yaml
MEMORY:
  REMEMBER:
    - WHEN: destination IS SET
      STORE: destination -> user.preferences.last_destination
      TTL: '30d'

    - WHEN: hotel_type IS SET
      STORE: hotel_type -> user.preferences.hotel_type

  RECALL:
    ON_SESSION_START: "Load user's previous booking preferences"
    ON_SEARCH_INITIATED: 'Recall preferred hotel chains and room types'

  PERSISTENT:
    - PATH: user.preferences.last_destination
      DESCRIPTION: 'Last booked destination'
      TYPE: string
    - PATH: user.preferences.hotel_type
      DESCRIPTION: 'Preferred hotel category'
      TYPE: string
      DEFAULT_VALUE: 'mid-range'
```

> **How it works:**
>
> 1. On session start, RECALL loads facts from the persistent store matching `ON_SESSION_START` events
> 2. When `destination` is set during conversation, REMEMBER stores it with a 30-day TTL
> 3. On next session, the stored destination is recalled and available as `user.preferences.last_destination`
> 4. If no stored value exists, `DEFAULT_VALUE` is used
>
> **Requirements:** Memory requires a configured FactStore (MongoDB in production). Without it, REMEMBER/RECALL silently no-op. Check traces for `memory_unavailable` events.

#### 4. Gather Activation Mode Semantics

**Gap:** Progressive and conditional activation are documented but interaction with `required` is unclear.

**Add to `TOOLS_AND_GATHER.md`:**

> **Activation precedence:**
>
> - `required` (default): Field is always prompted. Must be collected before step advances.
> - `optional`: Field is never prompted. Only captured if user mentions it voluntarily.
> - `progressive`: Field becomes `required` only after all `DEPENDS_ON` fields are collected. Until then, it's invisible.
> - `{ WHEN: expr }`: Field becomes `required` when the condition evaluates to true. Re-evaluated each turn.
>
> **Important:** `required: true` + `activation: optional` → the field is treated as optional. Activation mode takes precedence over the `required` flag.
>
> **Circular DEPENDS_ON:** If field A depends on B and B depends on A, neither will ever activate. The compiler does not currently detect this — it's a silent deadlock.

#### 5. ON_INPUT Fallthrough Behavior

**Gap:** No documentation on what happens when no ON_INPUT condition matches.

**Add to `ABL_QUICK_REFERENCE.md`:**

> **ON_INPUT evaluation:**
>
> 1. Conditions are evaluated top-to-bottom, first match wins
> 2. If no condition matches and no `ELSE` branch exists, the user's input is silently ignored and the agent re-prompts
> 3. **Best practice:** Always include an `ELSE` branch to handle unexpected input
>
> ```yaml
> ON_INPUT:
>   - WHEN: input == "yes"
>     THEN: confirm_step
>   - WHEN: input == "no"
>     THEN: restart_step
>   - ELSE:
>     RESPOND: "I didn't understand. Please say yes or no."
>     THEN: SAME_STEP
> ```

#### 6. Correction Detection Semantics

**Gap:** `CORRECTIONS: true` is a flag with no explanation of how corrections are detected.

**Add to `TOOLS_AND_GATHER.md`:**

> **How correction detection works:**
>
> 1. **Regex detection (fast):** Matches phrases like "actually X", "no, Y", "I meant Z", "change to W"
> 2. **LLM detection (fallback):** If regex doesn't match but an LLM client is available, asks the LLM whether the user is correcting a previous value
> 3. **Field identification:** The system identifies which field to correct by matching the new value's type against collected fields. If multiple fields match, the last-collected field of the matching type wins.
>
> **Dependent field invalidation:** If field B has `DEPENDS_ON: [A]` and field A is corrected, field B is automatically cleared and will be re-collected. This is transitive — if C depends on B, it's also cleared.
>
> **Limitations:**
>
> - Regex patterns are English-only (configurable via `CORRECTION_PATTERNS`)
> - Field identification is heuristic — ambiguous corrections may update the wrong field
> - `_correction` is returned as a fallback field name when no match is found (this value is not used)

#### 7. LLM Validation Fail-Open Behavior

**Gap:** No documentation that `VALIDATION_PROCESS: LLM` fails open.

**Add to `TOOLS_AND_GATHER.md`:**

> **LLM validation behavior:**
>
> - When the LLM is available: sends the value + validation rule to the LLM for evaluation
> - When the LLM is unavailable or returns an error: **the field is treated as valid** (fail-open)
> - When the value exceeds 2000 characters: treated as invalid (rejected)
>
> **Why fail-open:** LLM validation is a quality enhancement, not a security gate. For security-critical validation, use `pattern` or `custom` validation types which are deterministic.

#### 8. State Persistence Across Control Flow

**Gap:** No documentation on what state survives GOTO, RETRY, HANDOFF.

**Add new section to `ABL_QUICK_REFERENCE.md`:**

> **State persistence rules:**
> | Action | Collected fields | SET variables | Conversation history | Current step |
> |--------|-----------------|--------------|---------------------|-------------|
> | GOTO | Preserved | Preserved | Preserved | Changes to target |
> | RETRY | Preserved | Preserved | Preserved | Stays on current |
> | HANDOFF (RETURN: true) | Preserved in parent | Preserved in parent | Continues | Returns to parent step |
> | HANDOFF (RETURN: false) | Preserved in child | Child gets own scope | Child gets own history | Child starts from entry |
> | COMPLETE | N/A | N/A | N/A | Session ends |
> | ESCALATE | Frozen | Frozen | Frozen + passed to human | Paused |

---

## W3: Arch Diagnostics

### Principle

Arch should proactively detect and explain common issues before the developer has to ask. This requires two capabilities:

1. **Pattern recognition on traces** — Arch reads trace events and identifies known failure patterns
2. **Explanation templates** — Pre-built explanations for each implicit behavior

### Diagnostic Patterns

These are patterns Arch should recognize in trace data and proactively explain:

#### Pattern 1: Memory Silent No-Op

**Trace signature:** No `memory_trigger_evaluated` events despite agent having MEMORY config
**Diagnosis:** "Your agent has REMEMBER triggers configured, but the memory system isn't active. This usually means no FactStore is configured for this session. Memory requires a persistent store (MongoDB) — in local development, preferences won't persist across sessions."
**Fix:** "Configure a FactStore in your deployment, or use `InMemoryFactStore` for testing."

#### Pattern 2: Backtrack Loop → Unexpected Escalation

**Trace signature:** 3x `constraint_backtrack` events for same step, followed by `escalation`
**Diagnosis:** "Your constraint on step '{step}' triggered a GOTO/RETRY loop that hit the maximum backtrack limit (3). After 3 attempts, the runtime escalated instead of continuing the loop."
**Fix:** "Consider restructuring your flow so the correction path uses different steps, or handle the case where the constraint can't be satisfied after multiple attempts."

#### Pattern 3: Wrong Field Corrected

**Trace signature:** `correction` event where `field` doesn't match what user likely intended
**Diagnosis:** "The correction detector matched '{newValue}' to field '{field}' using the '{detectionMethod}' method. This was a heuristic match — the system matched the value type to the last collected field of that type. If this is wrong, consider using more specific correction phrases like 'change {fieldName} to {value}'."

#### Pattern 4: Extraction Strategy Mismatch

**Trace signature:** `extraction_strategy_resolved` with `source: 'default'` + extraction failure
**Diagnosis:** "Field '{field}' used the default 'hybrid' extraction strategy because no explicit strategy was set. For structured data like emails, phone numbers, or dates, consider using `STRATEGY: pattern` for faster, more reliable extraction."

#### Pattern 5: Gather Stall (Fields Never Activate)

**Trace signature:** Repeated `gather_field_activation` with `active: false` for same field across multiple turns
**Diagnosis:** "Field '{field}' has `activation: progressive` with `DEPENDS_ON: [{deps}]`, but those dependency fields haven't been collected yet. The field won't be prompted until all dependencies are satisfied."

#### Pattern 6: ON_INPUT Silent Drop

**Trace signature:** User message received but no `flow_transition` or `on_input_match` event
**Diagnosis:** "The user's message '{message}' didn't match any ON_INPUT condition, and there's no ELSE branch. The agent re-prompted without acknowledging the input. Add an ELSE branch to handle unexpected responses."

#### Pattern 7: LLM Validation Silently Disabled

**Trace signature:** `validation_fail_open` events
**Diagnosis:** "LLM validation for field '{field}' failed (error: {error}), so the value was accepted without validation. This is by design (fail-open), but means the value '{value}' may not meet your validation rule '{rule}'. If this validation is critical, consider using a deterministic validation type (pattern, range, enum)."

#### Pattern 8: Preference Not Persisted

**Trace signature:** `preference_detected` event but no subsequent `memory_trigger_evaluated` with matching field
**Diagnosis:** "A preference was detected ('{category}: {text}') but there's no REMEMBER trigger configured for this field. Add a REMEMBER rule to persist detected preferences."

### Arch Explanation API

For Arch to use these diagnostics, it needs a structured way to query trace data. Proposed API:

```typescript
interface ArchDiagnosticRequest {
  sessionId: string;
  question?: string; // "Why didn't my memory persist?"
  autoDetect?: boolean; // run all pattern detectors
}

interface ArchDiagnosticResult {
  patterns: Array<{
    pattern: string; // 'memory_silent_noop'
    confidence: number; // 0.0-1.0
    explanation: string; // human-readable
    evidence: TraceEvent[]; // supporting trace events
    fix: string; // actionable recommendation
    specReference?: string; // link to relevant doc section
  }>;
}
```

Arch calls this after the developer describes their issue, and it returns matched patterns with explanations. Arch can then present these conversationally.

---

## Implementation Priority

### Phase 1: Decision Traces (highest impact, lowest risk)

- Add the 18 trace events listed in W1
- Add `traceVerbosity` session config
- Estimated: 3-4 tasks, touches flow-step-executor.ts, reasoning-executor.ts, memory-integration.ts, constraint-checker.ts

### Phase 2: Spec Documentation (highest developer impact)

- Update the 8 documentation areas in W2
- Add working examples for MEMORY, ON_INPUT, corrections
- Estimated: 1-2 tasks, documentation only

### Phase 3: Arch Diagnostic Patterns (highest Arch impact)

- Implement the 8 diagnostic patterns in W3
- Build the diagnostic query API
- Wire into Arch's trace analysis workflow
- Estimated: 2-3 tasks, new module + Arch integration

### Dependencies

- Phase 1 is prerequisite for Phase 3 (Arch needs decision traces to detect patterns)
- Phase 2 is independent (can run in parallel with Phase 1)
- Phase 3 requires Phase 1 complete

---

## Success Criteria

1. **Developer can self-diagnose:** Given any of the 18 implicit behaviors, a developer with `trace_verbosity: verbose` can see exactly what happened and why
2. **Arch can explain proactively:** Given a session with issues, Arch detects at least the top 3 most common patterns without being asked
3. **Spec is complete:** Every implicit behavior has a documented explanation with examples in the relevant doc file
4. **Zero silent failures:** Every error path either emits a trace event or is documented as intentionally silent with rationale

## Implementation Plan

**Goal:** Make every implicit runtime decision visible to agent developers (via traces) and to Arch (via diagnostic patterns), and close all spec documentation gaps.

**Architecture:** Three workstreams executed sequentially. W1 adds 18 decision trace events to existing execution modules using the established `onTraceEvent` callback pattern. W2 updates 4 doc files with behavioral explanations. W3 adds an Arch diagnostic module that pattern-matches on trace events.

**Tech Stack:** TypeScript, Vitest, existing `TraceEvent` infrastructure (untyped `data: Record<string, unknown>`), existing `onTraceEvent?: (event) => void` callback chain

**Existing patterns to follow:**

- Guard: `if (onTraceEvent) { onTraceEvent({ type: '...', data: {...} }); }`
- The `onTraceEvent` callback has signature: `(event: { type: string; data: Record<string, unknown> }) => void`
- `TraceEventType` union in `apps/runtime/src/types/index.ts` (line 44) — add new types here
- All trace data is untyped (`Record<string, unknown>`) — no schema changes needed

---

### Task 1: Add New TraceEventType Strings + traceVerbosity to Session

**Files:**

- Modify: `apps/runtime/src/types/index.ts:44-80`
- Modify: `apps/runtime/src/services/execution/types.ts` (RuntimeSession interface)
- Modify: `apps/runtime/src/services/runtime-executor.ts:281-293` (session creation options)

**Step 1:** In `apps/runtime/src/types/index.ts`, add new trace event types to the `TraceEventType` union (after line 79, before the semicolon):

```typescript
  // Decision trace events (verbosity: verbose)
  | 'extraction_strategy_resolved'
  | 'extraction_attempt'
  | 'extraction_parse_fallback'
  | 'extraction_fallback'
  | 'memory_trigger_evaluated'
  | 'memory_recall_result'
  | 'memory_unavailable'
  | 'preference_detected'
  | 'constraint_backtrack'
  | 'constraint_backtrack_limit'
  | 'constraint_directive'
  | 'constraint_mini_collect'
  | 'gather_field_activation'
  | 'gather_complete_reason'
  | 'correction_invalidation'  // already emitted by Task 11
  | 'validation_fail_open'
```

**Step 2:** In `apps/runtime/src/services/execution/types.ts`, add `traceVerbosity` to the `RuntimeSession` interface:

```typescript
/** Controls which trace events are emitted. Default: 'standard' */
traceVerbosity?: 'minimal' | 'standard' | 'verbose' | 'debug';
```

**Step 3:** In `apps/runtime/src/services/runtime-executor.ts`, add `traceVerbosity` to the session creation options type (line 283) and wire it to the session object:

```typescript
// In options type:
traceVerbosity?: 'minimal' | 'standard' | 'verbose' | 'debug';

// In session creation (after line 370):
session.traceVerbosity = options.traceVerbosity ?? 'standard';
```

**Step 4:** Create a trace verbosity helper in `apps/runtime/src/services/execution/trace-helpers.ts`:

```typescript
/**
 * Trace verbosity levels (cumulative):
 * - minimal: errors, escalations, completion
 * - standard: above + step transitions, tool calls, constraint checks
 * - verbose: above + all decision traces (extraction, memory, gather, corrections)
 * - debug: above + LLM prompts/responses, raw extraction data
 */
const VERBOSITY_LEVELS = { minimal: 0, standard: 1, verbose: 2, debug: 3 } as const;

type TraceVerbosity = keyof typeof VERBOSITY_LEVELS;

/** Map each trace event type to the minimum verbosity level required to emit it */
const EVENT_VERBOSITY: Record<string, number> = {
  // minimal (always emitted)
  error: 0,
  escalation: 0,
  completion_check: 0,
  warning: 0,
  // standard
  flow_step_enter: 1,
  flow_step_exit: 1,
  flow_transition: 1,
  tool_call: 1,
  constraint_check: 1,
  constraint_violation: 1,
  handoff: 1,
  dsl_collect: 1,
  dsl_prompt: 1,
  dsl_respond: 1,
  dsl_set: 1,
  dsl_on_input: 1,
  dsl_call: 1,
  correction: 1,
  user_message: 1,
  session_resolution: 1,
  memory_init: 1,
  memory_remember: 1,
  memory_recall: 1,
  memory_error: 1,
  // verbose (decision traces)
  extraction_strategy_resolved: 2,
  extraction_attempt: 2,
  extraction_parse_fallback: 2,
  extraction_fallback: 2,
  memory_trigger_evaluated: 2,
  memory_recall_result: 2,
  memory_unavailable: 2,
  preference_detected: 2,
  constraint_backtrack: 2,
  constraint_backtrack_limit: 2,
  constraint_directive: 2,
  constraint_mini_collect: 2,
  gather_field_activation: 2,
  gather_complete_reason: 2,
  correction_invalidation: 2,
  validation_fail_open: 2,
  memory_preferences: 2,
  // debug (everything)
  llm_call: 3,
  engine_decision: 3,
  data_stored: 3,
};

export function shouldEmitTrace(
  eventType: string,
  verbosity: TraceVerbosity = 'standard',
): boolean {
  const requiredLevel = EVENT_VERBOSITY[eventType] ?? 1; // default to standard
  return VERBOSITY_LEVELS[verbosity] >= requiredLevel;
}

export function emitDecisionTrace(
  onTraceEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined,
  verbosity: TraceVerbosity | undefined,
  type: string,
  data: Record<string, unknown>,
): void {
  if (!onTraceEvent) return;
  if (!shouldEmitTrace(type, verbosity ?? 'standard')) return;
  onTraceEvent({ type, data });
}
```

**Step 5:** Run `pnpm --filter runtime exec tsc --noEmit` to verify types compile.

**Step 6:** Commit: `feat(runtime): add decision trace event types and traceVerbosity setting`

---

### Task 2: Extraction Decision Traces (4 events)

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Test: `apps/runtime/src/__tests__/extraction-decision-traces.test.ts`

**Step 1:** Add import at top of flow-step-executor.ts:

```typescript
import { emitDecisionTrace } from './trace-helpers.js';
```

**Step 2:** In `extractEntitiesWithLLM()`, after the strategy resolution block (~line 556-567), emit `extraction_strategy_resolved`.

**Step 3:** After pattern-only extraction completes (~line 597), emit `extraction_attempt` for pattern fields.

**Step 4:** After LLM JSON parse fallback (~line 729), emit `extraction_parse_fallback`.

**Step 5:** In the hybrid fallback path (when LLM fails and pattern fallback runs), emit `extraction_fallback`.

**Step 6:** Write tests in `extraction-decision-traces.test.ts`:

- Strategy resolved with field-level override -> trace shows `source: 'field'`
- Strategy resolved with block-level -> trace shows `source: 'block'`
- Strategy resolved with default -> trace shows `source: 'default'`
- Pattern extraction emits `extraction_attempt` with matched/missed
- LLM JSON parse fallback emits `extraction_parse_fallback`
- `traceVerbosity: 'standard'` suppresses decision traces
- `traceVerbosity: 'verbose'` emits decision traces

**Step 7:** Run `pnpm --filter runtime test -- --testPathPattern extraction-decision-traces`.

**Step 8:** Commit: `feat(runtime): add extraction decision trace events`

---

### Task 3: Memory Decision Traces (5 events)

**Files:**

- Modify: `apps/runtime/src/services/execution/memory-integration.ts`
- Test: `apps/runtime/src/__tests__/memory-decision-traces.test.ts`

Emit `memory_unavailable` in guard clauses, `memory_trigger_evaluated` after evaluating each trigger, `memory_recall_result` after loading facts, and `preference_detected` after detecting each preference.

Write tests for: no memory config, no FactStore, trigger fires, trigger no match, recall loads facts, preference detected.

Commit: `feat(runtime): add memory decision trace events`

---

### Task 4: Constraint Decision Traces (4 events)

**Files:**

- Modify: `apps/runtime/src/services/execution/constraint-checker.ts`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Test: `apps/runtime/src/__tests__/constraint-decision-traces.test.ts`

Emit `constraint_directive` after determining directive type, `constraint_backtrack` when backtrack count is incremented, `constraint_backtrack_limit` when limit is exceeded, and `constraint_mini_collect` on enter and exit.

Write tests for: control flow directive, terminal action, backtrack incremented, backtrack limit exceeded, mini-collect enter/exit.

Commit: `feat(runtime): add constraint decision trace events`

---

### Task 5: Gather & Validation Decision Traces (3 events)

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Modify: `apps/runtime/src/services/execution/llm-field-validator.ts`
- Test: `apps/runtime/src/__tests__/gather-decision-traces.test.ts`

Emit `gather_field_activation` for each skipped field, `gather_complete_reason` after completeness check, and `validation_fail_open` in LLM validation error catch blocks.

Write tests for: optional field skipped, progressive field skipped, gather complete via complete_when, gather complete via all fields, LLM validation error.

Commit: `feat(runtime): add gather and validation decision trace events`

---

### Task 6: Update ABL_QUICK_REFERENCE.md

Add sections for: Memory (REMEMBER/RECALL) Working Example, ON_INPUT Evaluation Rules, State Persistence Across Control Flow.

Commit: `docs: add memory examples, ON_INPUT rules, and state persistence table to ABL quick reference`

---

### Task 7: Update TOOLS_AND_GATHER.md

Add sections for: Extraction Strategy Selection Guide, Gather Activation Mode Semantics, Correction Detection Semantics, LLM Validation Fail-Open Behavior.

Commit: `docs: add strategy guide, activation semantics, correction and validation behavior to TOOLS_AND_GATHER`

---

### Task 8: Update CONSTRAINTS.md and ERROR_HANDLING.md

Add sections for: Backtrack Limit Semantics, Mini-Collect (COLLECT from ON_FAIL), ON_ERROR vs. Constraint ON_FAIL clarification.

Commit: `docs: add backtrack semantics, mini-collect behavior, and error handling clarification`

---

### Task 9: Arch Diagnostic Module

**Files:**

- Create: `apps/runtime/src/services/diagnostics/arch-diagnostics.ts`
- Create: `apps/runtime/src/services/diagnostics/diagnostic-patterns.ts`
- Test: `apps/runtime/src/__tests__/arch-diagnostics.test.ts`

Implement 8 pattern detector functions: `detectMemorySilentNoop`, `detectBacktrackEscalation`, `detectWrongFieldCorrected`, `detectStrategyMismatch`, `detectGatherStall`, `detectOnInputDrop`, `detectValidationFailOpen`, `detectPreferenceNotPersisted`.

Create `arch-diagnostics.ts` as the main entry point with `runDiagnostics()`.

Write tests for each pattern detection.

Commit: `feat(runtime): add Arch diagnostic pattern detection module`

---

### Task 10: Wire Arch Diagnostics to Session API

Add `diagnoseSession(sessionId)` method to `RuntimeExecutor`. Add `traceHistory` to session types (bounded array of recent trace events, last 200). Capture trace events into `traceHistory` via the onTraceEvent wrapper.

> **Durability Note:** `traceHistory` stored on `SessionData` is only valid for single-pod deployments. For cluster-ready production, trace history must be backed by the trace store (ClickHouse/Redis) rather than embedded in the session.

Commit: `feat(runtime): wire Arch diagnostics to session API with trace history`

---

### Dependency Graph

```
Task 1 (types + verbosity helper)
  |
Task 2 + Task 3 + Task 4 + Task 5 (decision traces — parallel)
  |
Task 6 + Task 7 + Task 8 (docs — parallel, independent of traces)
  |
Task 9 (diagnostic patterns — needs trace types from Task 1)
  |
Task 10 (wire diagnostics — needs Task 9)
```

Tasks 6-8 (docs) can run in parallel with Tasks 2-5 (traces) since they're independent.

---

### Verification

After all tasks complete:

1. `pnpm --filter runtime test` — all tests pass
2. `pnpm --filter runtime exec tsc --noEmit` — type check passes
3. Check trace output: Create a test session with `traceVerbosity: 'verbose'`, run a message, verify decision traces appear
4. Check diagnostics: Create a session with missing FactStore, run messages, call `diagnoseSession()`, verify `memory_silent_noop` pattern detected
5. Check docs: Verify all 4 doc files have the new sections
