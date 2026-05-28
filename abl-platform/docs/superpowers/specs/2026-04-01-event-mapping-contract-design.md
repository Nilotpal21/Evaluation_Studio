# Event Mapping Contract — Design Spec

**Date:** 2026-04-01
**Status:** Approved
**Goal:** Close the gap between runtime trace events and the Interactions tab UI mapping, and formalize a contract that prevents future drift.

## Problem

The runtime emits ~60 event types (defined in `trace-helpers.ts` `EVENT_VERBOSITY`). The Interactions tab maps ~40 of them via `EVENT_TO_STEP` in `constants.ts`. The remaining ~25 events are silently dropped — they attach to whatever step is current and are only visible in the raw events toggle. This means memory lifecycle, corrections, pipeline intelligence, agent lifecycle, and session resolution events are invisible in the structured interaction view.

## Goals

1. **Close the mapping gap** — every runtime event type renders meaningfully in the Interactions tab
2. **Formalize a contract** — a shared registry + test that fails when a new runtime event has no UI mapping

## Approach

- **Zero new step types** — keep existing 14 `InteractionStepType` values
- **Fold unmapped events** into the closest existing step type
- **Lifecycle events as structural banners** — thin dividers between steps, not step cards
- **Session resolution as footer** — rendered at bottom of interaction list
- **Contract test** — shared event registry ensures complete coverage

---

## Section 0: Event Labels — Human-Readable Names

Every runtime event gets a user-readable label via `EVENT_LABELS` in `constants.ts`. Used in raw event lists, tooltips, banner text, and step detail headers.

```ts
export const EVENT_LABELS: Record<string, string> = {
  // ── User Input ──
  user_message: 'User Message',
  'message.user.received': 'User Message Received',

  // ── LLM ──
  llm_call: 'LLM Call',
  'llm.call.completed': 'LLM Call Completed',
  'llm.call.failed': 'LLM Call Failed',
  inference_start: 'Inference Started',
  inference_complete: 'Inference Complete',
  inference_error: 'Inference Error',
  inference_stream_start: 'Stream Started',
  inference_stream_end: 'Stream Ended',
  engine_decision: 'Engine Decision',

  // ── Tool Calls ──
  tool_call: 'Tool Call',
  tool_result: 'Tool Result',
  'tool.call.completed': 'Tool Call Completed',
  'tool.call.failed': 'Tool Call Failed',
  dsl_call: 'DSL Action Call',

  // ── Guardrails ──
  guardrail_check: 'Guardrail Check',
  guardrail_violation: 'Guardrail Violation',
  guardrail_warning: 'Guardrail Warning',
  guardrail_fix: 'Guardrail Auto-Fix',
  guardrail_reask: 'Guardrail Re-Ask',
  guardrail_pipeline_complete: 'Guardrail Pipeline Complete',
  guardrail_pipeline_error: 'Guardrail Pipeline Error',
  guardrail_input_blocked: 'Input Blocked',
  guardrail_output_blocked: 'Output Blocked',
  guardrail_tool_blocked: 'Tool Blocked',
  guardrail_tool_output_blocked: 'Tool Output Blocked',
  guardrail_handoff_blocked: 'Handoff Blocked',
  guardrail_cost: 'Guardrail Cost Check',
  guardrail_circuit_breaker: 'Circuit Breaker Tripped',
  guardrail_cache_hit: 'Guardrail Cache Hit',
  guardrail_cache_miss: 'Guardrail Cache Miss',
  guardrail_provider_error: 'Guardrail Provider Error',

  // ── Flow / Transitions ──
  flow_step_enter: 'Flow Step Entered',
  flow_step_exit: 'Flow Step Exited',
  flow_transition: 'Flow Transition',
  'flow.step.entered': 'Flow Step Entered',
  'flow.step.exited': 'Flow Step Exited',
  'flow.transition': 'Flow Transition',

  // ── Gather / Extraction ──
  dsl_collect: 'Field Collection',
  entity_extraction: 'Entity Extraction',
  extraction_tier_selected: 'Extraction Tier Selected',
  extraction_attempt: 'Extraction Attempt',
  extraction_fallback: 'Extraction Fallback',
  extraction_parse_fallback: 'Parse Fallback',
  extraction_strategy_resolved: 'Extraction Strategy Resolved',
  gather_field_activation: 'Field Activated',
  gather_complete_reason: 'Gather Complete',
  dsl_on_input: 'Input Received',
  dsl_await_attachment: 'Awaiting Attachment',
  constraint_backtrack: 'Field Backtrack',
  constraint_backtrack_limit: 'Backtrack Limit Reached',
  constraint_directive: 'Constraint Directive',
  constraint_mini_collect: 'Mini-Collect',

  // ── Decisions ──
  decision: 'Decision',
  handoff: 'Handoff',
  'agent.decision': 'Agent Decision',
  'agent.handoff': 'Agent Handoff',
  handoff_condition_check: 'Handoff Condition Check',
  completion_check: 'Completion Check',
  correction: 'Self-Correction',
  correction_invalidation: 'Correction Invalidated',
  digression: 'Digression Detected',
  sub_intent: 'Sub-Intent Recognized',
  pipeline_intent_bridge: 'Intent Bridged',
  pipeline_tiered_action: 'Tiered Action',
  pipeline_out_of_scope_decline: 'Out of Scope Declined',
  escalation: 'Escalated',
  constraint_check: 'Constraint Check',
  validation_fail_open: 'Validation Fail-Open',

  // ── Agent Response ──
  agent_response: 'Agent Response',
  dsl_respond: 'DSL Response',
  dsl_prompt: 'DSL Prompt',

  // ── Memory ──
  data_stored: 'Data Stored',
  dsl_set: 'Variable Set',
  memory_init: 'Memory Initialized',
  memory_remember: 'Memory Stored',
  memory_recall: 'Memory Recalled',
  memory_error: 'Memory Error',
  memory_preferences: 'Preferences Stored',
  memory_trigger_evaluated: 'Memory Trigger Evaluated',
  memory_recall_result: 'Memory Recall Result',
  memory_unavailable: 'Memory Unavailable',
  preference_detected: 'Preference Detected',

  // ── Errors / Warnings ──
  error: 'Error',
  'system.error': 'System Error',
  constraint_violation: 'Constraint Violation',
  warning: 'Warning',

  // ── Parallel Execution ──
  fan_out_start: 'Parallel Start',
  fan_out_task_start: 'Parallel Task Started',
  fan_out_task_complete: 'Parallel Task Complete',
  fan_out_complete: 'Parallel Complete',
  fan_out_child_created: 'Child Task Created',
  fan_out_child_completed: 'Child Task Completed',

  // ── Lifecycle (banners) ──
  agent_enter: 'Agent Entered',
  agent_exit: 'Agent Exited',
  delegate_start: 'Delegation Started',
  delegate_complete: 'Delegation Complete',
  thread_return: 'Thread Returned',

  // ── Session ──
  session_resolution: 'Session Resolved',
};
```

These labels are used everywhere an event type is displayed to the user:

- Raw event list in step detail (`InteractionStep` raw events toggle)
- Lifecycle banner text
- Tooltips on step headers
- Contract test validates every `RUNTIME_EVENT_TYPES` entry has a label

---

## Section 1: Complete Event-to-Step Mapping

### Existing Mappings (no changes)

All ~40 entries currently in `EVENT_TO_STEP` remain unchanged. This includes:

- `user_message`, `message.user.received` → `user_input`
- `llm_call`, `llm.call.completed`, `llm.call.failed`, `inference_*` → `llm_call`
- `tool_call`, `tool_result`, `tool.call.*`, `dsl_call` → `tool_call`
- `guardrail_*` → `input_guard` / `output_guard`
- `flow_step_enter`, `flow_step_exit`, `flow_transition`, `flow.*` → `flow_transition`
- `dsl_collect`, `entity_extraction`, `extraction_tier_selected`, `extraction_attempt`, `extraction_fallback`, `extraction_parse_fallback` → `gather`
- `decision`, `handoff`, `agent.decision`, `agent.handoff`, `handoff_condition_check`, `engine_decision`, `completion_check` → `decision`
- `agent_response`, `dsl_respond`, `dsl_prompt` → `agent_response`
- `error`, `system.error`, `constraint_violation` → `error`
- `fan_out_*` → `parallel_tools`
- `data_stored`, `dsl_set` → `memory_diff`

### New Mappings: Memory Events → `memory_diff` (9 events)

| Event                      | Data Fields              | Display                                       |
| -------------------------- | ------------------------ | --------------------------------------------- |
| `memory_init`              | `memoryType`, `config`   | "Memory initialized — {memoryType}"           |
| `memory_remember`          | `key`, `value`, `source` | Same shape as `data_stored` — already handled |
| `memory_recall`            | `key`, `query`           | "Recalled {key}" with query                   |
| `memory_error`             | `message`, `operation`   | Error badge + message                         |
| `memory_preferences`       | `preferences` (object)   | Key-value list of preferences                 |
| `memory_trigger_evaluated` | `trigger`, `result`      | "Trigger: {trigger} → {result}"               |
| `memory_recall_result`     | `key`, `value`, `found`  | "Recall {key}: {found ? value : 'not found'}" |
| `memory_unavailable`       | `reason`                 | Warning badge + reason                        |
| `preference_detected`      | `preference`, `value`    | "Detected: {preference} = {value}"            |

### New Mappings: Pipeline Intelligence + Corrections → `decision` (10 events)

| Event                           | `decisionType`     | Display                            |
| ------------------------------- | ------------------ | ---------------------------------- |
| `correction`                    | `correction`       | "Correction: {field} — {reason}"   |
| `correction_invalidation`       | `correction`       | "Invalidated: {field}"             |
| `digression`                    | `digression`       | "Digression detected — {topic}"    |
| `sub_intent`                    | `sub_intent`       | "Sub-intent: {intent}"             |
| `pipeline_intent_bridge`        | `intent_bridge`    | "Intent bridged: {from} → {to}"    |
| `pipeline_tiered_action`        | `tiered_action`    | "Tiered action: {tier} — {action}" |
| `pipeline_out_of_scope_decline` | `out_of_scope`     | "Out of scope: {reason}"           |
| `escalation`                    | `escalation`       | "Escalated — {reason}"             |
| `constraint_check`              | `constraint_check` | "Constraint: {name} — {result}"    |
| `validation_fail_open`          | `field_validation` | "Validation fail-open: {field}"    |

### New Mappings: Gather-Related + Constraint Backtracking → `gather` (9 events)

| Event                          | Merged Data                           | Purpose                            |
| ------------------------------ | ------------------------------------- | ---------------------------------- |
| `dsl_on_input`                 | `userInput` field                     | DSL input handler in gather flow   |
| `dsl_await_attachment`         | `awaitingAttachment: true` flag       | File/attachment wait during gather |
| `extraction_strategy_resolved` | `strategy` field                      | Extraction strategy selection      |
| `gather_field_activation`      | Adds to `activatedFields` array       | Individual field activation        |
| `gather_complete_reason`       | `completeReason` field                | Why gather completed               |
| `constraint_backtrack`         | `backtracked: true`, `backtrackField` | Backtrack during constraint gather |
| `constraint_backtrack_limit`   | `backtrackLimitHit: true`             | Backtrack limit reached            |
| `constraint_directive`         | `directive` text                      | Constraint directive issued        |
| `constraint_mini_collect`      | Adds to `miniCollectFields` array     | Mini-collect for constraint fields |

### New Mapping: Warning → `error` (1 event)

| Event     | Display                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `warning` | Rendered as error step with `severity: 'warning'` badge (amber instead of red) |

---

## Section 2: Lifecycle Banners

Agent lifecycle events render as **thin inline dividers** between step cards — not as full step cards.

### Data Model

```ts
// New interface in types.ts
interface LifecycleBanner {
  id: string;
  timestamp: Date;
  kind: 'agent_enter' | 'agent_exit' | 'delegate_start' | 'delegate_complete' | 'thread_return';
  agentName: string;
  targetAgent?: string; // for delegate_start
  parentAgent?: string; // for thread_return
}
```

Added to `Interaction`:

```ts
interface Interaction {
  // ... existing fields ...
  banners: LifecycleBanner[];
}
```

### Events → Banners

| Event               | Banner Kind         | Text                          |
| ------------------- | ------------------- | ----------------------------- |
| `agent_enter`       | `agent_enter`       | "→ Entered {agentName}"       |
| `agent_exit`        | `agent_exit`        | "← Exited {agentName}"        |
| `delegate_start`    | `delegate_start`    | "Delegating to {targetAgent}" |
| `delegate_complete` | `delegate_complete` | "Delegation complete"         |
| `thread_return`     | `thread_return`     | "Returned to {parentAgent}"   |

### Rendering

- Single-line `div`, 24px tall
- `foreground-subtle` text, `border-muted` horizontal rule
- `info` intent for agent enter/exit, `warning` intent for delegation
- No expand/collapse, no card border
- Interleaved with steps by timestamp in `InteractionCard`

### Placement Logic

In `InteractionCard`, both `banners` and `steps` are walked in timestamp order:

```
if banner.timestamp < nextStep.timestamp → render banner
otherwise → render step
```

---

## Section 3: Session Resolution Footer

`session_resolution` events render as a **footer bar** at the bottom of the interaction list.

### Data Model

```ts
// New interface in types.ts
interface SessionResolution {
  timestamp: Date;
  outcome: string; // 'completed', 'escalated', 'abandoned'
  reason?: string;
  finalAgent?: string;
  durationMs?: number;
}
```

Added to `ProcessedInteractions`:

```ts
interface ProcessedInteractions {
  // ... existing fields ...
  resolution: SessionResolution | null;
}
```

### Rendering

- Single bar below all interaction cards in `InteractionTimeline`
- `success` intent for completed, `warning` for escalated, `error` for abandoned/failed
- Shows: outcome icon + text, final agent name, session duration
- Only rendered when `resolution !== null`

### Extraction

In `event-processor.ts`, `processEventsToInteractions` scans for the last `session_resolution` event and builds the `SessionResolution` object. This event is excluded from step classification.

---

## Section 4: Contract Test

### Shared Event Registry

Create `packages/shared-types/src/trace-event-registry.ts`:

```ts
/** Every event type the runtime can emit. Authoritative list. */
export const RUNTIME_EVENT_TYPES = [
  // minimal
  'error',
  'escalation',
  'completion_check',
  'warning',
  // standard
  'decision',
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'tool_call',
  'constraint_check',
  'constraint_violation',
  'handoff',
  'dsl_collect',
  'dsl_prompt',
  'dsl_respond',
  'dsl_set',
  'dsl_on_input',
  'dsl_call',
  'dsl_await_attachment',
  'correction',
  'user_message',
  'session_resolution',
  'memory_init',
  'memory_remember',
  'memory_recall',
  'memory_error',
  'memory_preferences',
  'agent_enter',
  'agent_exit',
  'delegate_start',
  'delegate_complete',
  'handoff_condition_check',
  'thread_return',
  'data_stored',
  'digression',
  'sub_intent',
  'pipeline_intent_bridge',
  'pipeline_tiered_action',
  'pipeline_out_of_scope_decline',
  // verbose
  'extraction_strategy_resolved',
  'extraction_attempt',
  'extraction_parse_fallback',
  'extraction_fallback',
  'memory_trigger_evaluated',
  'memory_recall_result',
  'memory_unavailable',
  'preference_detected',
  'constraint_backtrack',
  'constraint_backtrack_limit',
  'constraint_directive',
  'constraint_mini_collect',
  'gather_field_activation',
  'gather_complete_reason',
  'correction_invalidation',
  'validation_fail_open',
  // debug
  'llm_call',
  'engine_decision',
  // UI-only (emitted by runtime but not in EVENT_VERBOSITY)
  'agent_response',
  'entity_extraction',
  'extraction_tier_selected',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];
```

### Both Sides Reference the Registry

- **Runtime** `trace-helpers.ts`: `EVENT_VERBOSITY` keys validated against `RUNTIME_EVENT_TYPES`
- **Studio** `constants.ts`: exports `EVENT_TO_STEP`, `LIFECYCLE_EVENTS`, `SESSION_EVENTS`

### Contract Test

```ts
// packages/shared-types/src/__tests__/trace-event-contract.test.ts

test('every runtime event type is accounted for in the UI mapping', () => {
  const allMapped = new Set([
    ...Object.keys(EVENT_TO_STEP),
    ...LIFECYCLE_EVENTS,
    ...SESSION_EVENTS,
  ]);

  const unmapped = RUNTIME_EVENT_TYPES.filter((e) => !allMapped.has(e));
  expect(unmapped).toEqual([]);
});

test('every runtime event type has a human-readable label', () => {
  const unlabeled = RUNTIME_EVENT_TYPES.filter((e) => !EVENT_LABELS[e]);
  expect(unlabeled).toEqual([]);
});

test('EVENT_VERBOSITY keys are all in RUNTIME_EVENT_TYPES', () => {
  const registry = new Set(RUNTIME_EVENT_TYPES);
  const verbosityKeys = Object.keys(EVENT_VERBOSITY);
  const missing = verbosityKeys.filter((k) => !registry.has(k));
  expect(missing).toEqual([]);
});
```

### Drift Prevention

When a developer adds a new event type to `EVENT_VERBOSITY` in the runtime:

1. They must add it to `RUNTIME_EVENT_TYPES` in shared-types (test 2 fails otherwise)
2. They must add it to `EVENT_TO_STEP`, `LIFECYCLE_EVENTS`, or `SESSION_EVENTS` (test 1 fails otherwise)

---

## Section 5: Component Enrichment

### `memory_diff` Renderer

Inspects `event.type` on the step's events array to select layout:

- `memory_init` → "Memory initialized — {memoryType}" one-liner
- `memory_recall` / `memory_recall_result` → "Recalled {key}" with value or "not found"
- `memory_error` / `memory_unavailable` → Error/warning badge + message
- `memory_preferences` / `preference_detected` → Key-value preference list
- `memory_trigger_evaluated` → "Trigger: {trigger} → {result}"
- `memory_remember` / `data_stored` / `dsl_set` → Existing key/value display (no change)

Falls back to current key/value display for unknown shapes.

### `decision` Renderer

Already switches on `decisionType`. New decision types added to `extractStepData`:

- `correction`, `correction_invalidation` → `decisionType: 'correction'`
- `digression` → `decisionType: 'digression'`
- `sub_intent` → `decisionType: 'sub_intent'`
- `pipeline_intent_bridge` → `decisionType: 'intent_bridge'`
- `pipeline_tiered_action` → `decisionType: 'tiered_action'`
- `pipeline_out_of_scope_decline` → `decisionType: 'out_of_scope'`
- `escalation` → `decisionType: 'escalation'` (already in DecisionKind)
- `constraint_check` → `decisionType: 'constraint_check'` (already in DecisionKind)
- `validation_fail_open` → `decisionType: 'field_validation'` (already in DecisionKind)

### `gather` Renderer

New events merge via `mergeStepData` — shown as supplementary detail rows below the field list:

- `dsl_on_input` → `userInput` field
- `dsl_await_attachment` → `awaitingAttachment: true`
- `extraction_strategy_resolved` → `strategy` field
- `gather_field_activation` → appends to `activatedFields`
- `gather_complete_reason` → `completeReason`
- `constraint_backtrack` → `backtracked: true`, `backtrackField`
- `constraint_backtrack_limit` → `backtrackLimitHit: true`
- `constraint_directive` → `directive` text
- `constraint_mini_collect` → appends to `miniCollectFields`

### `error` Renderer

Checks `event.type === 'warning'` to show warning badge (amber, `warning` intent) instead of error badge (red, `error` intent).

### No Changes Needed

`user_input`, `llm_call`, `tool_call`, `input_guard`, `output_guard`, `agent_response`, `flow_transition`, `parallel_tools`, `retry`, `flow_graph` — no new events folded in.

---

## Files Affected

### New Files

- `packages/shared-types/src/trace-event-registry.ts` — shared event registry
- `packages/shared-types/src/__tests__/trace-event-contract.test.ts` — contract test

### Modified Files

- `apps/studio/src/components/observatory/interactions/constants.ts` — add 29 new entries to `EVENT_TO_STEP`, add `LIFECYCLE_EVENTS` and `SESSION_EVENTS` sets
- `apps/studio/src/components/observatory/interactions/types.ts` — add `LifecycleBanner`, `SessionResolution` interfaces; add `banners` to `Interaction`, `resolution` to `ProcessedInteractions`
- `apps/studio/src/components/observatory/interactions/event-processor.ts` — handle lifecycle events as banners, session_resolution as footer, new `extractStepData` cases for folded events, new `mergeStepData` cases for gather events
- `apps/studio/src/components/observatory/interactions/InteractionCard.tsx` — interleave banners with steps by timestamp
- `apps/studio/src/components/observatory/interactions/InteractionStep.tsx` — enriched decision/memory/gather/error rendering for new event subtypes
- `apps/studio/src/components/observatory/interactions/GatherConfidence.tsx` — supplementary detail rows for new gather events
- `apps/runtime/src/services/execution/trace-helpers.ts` — import `RUNTIME_EVENT_TYPES`, validate `EVENT_VERBOSITY` keys against it
