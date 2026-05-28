# Event Mapping Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between ~60 runtime trace events and the 14 Interactions step types, add human-readable labels for every event, and formalize a contract test that prevents drift.

**Architecture:** Add a shared event registry in `@agent-platform/shared-kernel`. Expand the studio-side `EVENT_TO_STEP` mapping to cover all runtime events. Add lifecycle banners and a session resolution footer as new display concepts (no new step types). A contract test verifies complete coverage.

**Tech Stack:** TypeScript, React, Vitest, `@agent-platform/design-tokens`, `@agent-platform/shared-kernel`

**Constraints:**

- Must NOT delete any existing exports
- Run `npx prettier --write <files>` on all changed files before committing
- Run `tsc --noEmit` after each file write
- Commit after each task
- Branch: `KI0326/feature/debug-log-interactions` (already checked out)

---

## File Structure

| File                                                                                          | Responsibility                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Create:** `packages/shared-kernel/src/constants/trace-event-registry.ts`                    | Shared `RUNTIME_EVENT_TYPES` constant — authoritative list of all runtime event types                  |
| **Modify:** `packages/shared-kernel/src/index.ts`                                             | Re-export the registry                                                                                 |
| **Create:** `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`               | Contract test — verifies every event is mapped + labeled                                               |
| **Modify:** `apps/studio/src/components/observatory/interactions/constants.ts`                | Add `EVENT_LABELS`, expand `EVENT_TO_STEP`, add `LIFECYCLE_EVENTS`, `SESSION_EVENTS`                   |
| **Modify:** `apps/studio/src/components/observatory/interactions/types.ts`                    | Add `LifecycleBanner`, `SessionResolution` interfaces; extend `Interaction` + `ProcessedInteractions`  |
| **Modify:** `apps/studio/src/components/observatory/interactions/event-processor.ts`          | Handle lifecycle → banners, session_resolution → footer, new `extractStepData` + `mergeStepData` cases |
| **Create:** `apps/studio/src/components/observatory/interactions/LifecycleBanner.tsx`         | Thin inline divider component for lifecycle events                                                     |
| **Create:** `apps/studio/src/components/observatory/interactions/SessionResolutionFooter.tsx` | Footer bar for session_resolution                                                                      |
| **Modify:** `apps/studio/src/components/observatory/interactions/InteractionCard.tsx`         | Interleave banners with steps by timestamp                                                             |
| **Modify:** `apps/studio/src/components/observatory/interactions/InteractionsTab.tsx`         | Render `SessionResolutionFooter` at bottom                                                             |
| **Modify:** `apps/studio/src/components/observatory/interactions/InteractionStep.tsx`         | Use `EVENT_LABELS` in `RawEventBlock`; handle `warning` in error renderer                              |
| **Modify:** `apps/studio/src/components/observatory/interactions/index.ts`                    | Export new components + types                                                                          |
| **Modify:** `apps/runtime/src/services/execution/trace-helpers.ts`                            | Import + validate `EVENT_VERBOSITY` keys against `RUNTIME_EVENT_TYPES`                                 |

---

### Task 1: Shared Event Registry

**Files:**

- Create: `packages/shared-kernel/src/constants/trace-event-registry.ts`
- Modify: `packages/shared-kernel/src/index.ts`

- [ ] **Step 1: Create the registry file**

```ts
// packages/shared-kernel/src/constants/trace-event-registry.ts

/**
 * Trace Event Registry — Authoritative list of all runtime event types.
 *
 * Both runtime (EVENT_VERBOSITY) and studio (EVENT_TO_STEP, EVENT_LABELS)
 * validate against this list. A contract test ensures complete coverage.
 */

/** Every event type the runtime can emit. */
export const RUNTIME_EVENT_TYPES = [
  // ── Minimal (always emitted) ──
  'error',
  'escalation',
  'completion_check',
  'warning',

  // ── Standard ──
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

  // ── Verbose (decision traces) ──
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

  // ── Debug ──
  'llm_call',
  'engine_decision',

  // ── Events emitted but not in EVENT_VERBOSITY (UI / response events) ──
  'agent_response',
  'entity_extraction',
  'extraction_tier_selected',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/sainathbhima/Documents/abl-platform && pnpm build --filter=@agent-platform/shared-kernel`
Expected: PASS — no type errors

- [ ] **Step 3: Add re-export to shared-kernel index**

In `packages/shared-kernel/src/index.ts`, add at the end of the Constants section:

```ts
// ─── Constants ─────────────────────────────────────────────────────────
export { PLAN_FEATURES } from './constants/plan-features.js';
export { RUNTIME_EVENT_TYPES } from './constants/trace-event-registry.js';
export type { RuntimeEventType } from './constants/trace-event-registry.js';
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/sainathbhima/Documents/abl-platform && pnpm build --filter=@agent-platform/shared-kernel`
Expected: PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/shared-kernel/src/constants/trace-event-registry.ts packages/shared-kernel/src/index.ts
git add packages/shared-kernel/src/constants/trace-event-registry.ts packages/shared-kernel/src/index.ts
git commit -m "[ABLP-2] feat(shared-kernel): add RUNTIME_EVENT_TYPES trace event registry"
```

---

### Task 2: Expand EVENT_TO_STEP + Add EVENT_LABELS + LIFECYCLE/SESSION Sets

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/constants.ts`

- [ ] **Step 1: Add EVENT_LABELS, expand EVENT_TO_STEP, add LIFECYCLE_EVENTS and SESSION_EVENTS**

Replace the entire `constants.ts` with (preserving all existing exports and values):

```ts
/**
 * Interactions Tab — Constants
 *
 * Step type configuration, semantic intent mappings, event labels,
 * and display thresholds.
 */

import type { SemanticIntent } from '@agent-platform/design-tokens';
import type { InteractionStepType } from './types';

export interface StepConfig {
  intent: SemanticIntent;
  label: string;
}

export const STEP_CONFIG: Record<InteractionStepType, StepConfig> = {
  user_input: { intent: 'info', label: 'USER INPUT' },
  input_guard: { intent: 'success', label: 'INPUT GUARD' },
  llm_call: { intent: 'purple', label: 'LLM CALL' },
  gather: { intent: 'info', label: 'GATHER' },
  flow_transition: { intent: 'warning', label: 'TRANSITION' },
  flow_graph: { intent: 'warning', label: 'FLOW' },
  tool_call: { intent: 'success', label: 'TOOL CALL' },
  parallel_tools: { intent: 'info', label: 'PARALLEL' },
  retry: { intent: 'warning', label: 'RETRY' },
  output_guard: { intent: 'success', label: 'OUTPUT GUARD' },
  agent_response: { intent: 'purple', label: 'RESPONSE' },
  memory_diff: { intent: 'orange', label: 'MEMORY' },
  decision: { intent: 'warning', label: 'DECISION' },
  error: { intent: 'error', label: 'ERROR' },
};

// =============================================================================
// EVENT → STEP MAPPING
// =============================================================================

export const EVENT_TO_STEP: Record<string, InteractionStepType> = {
  // ── User Input ──
  user_message: 'user_input',
  'message.user.received': 'user_input',

  // ── LLM ──
  llm_call: 'llm_call',
  'llm.call.completed': 'llm_call',
  'llm.call.failed': 'llm_call',
  inference_start: 'llm_call',
  inference_complete: 'llm_call',
  inference_error: 'llm_call',
  inference_stream_start: 'llm_call',
  inference_stream_end: 'llm_call',

  // ── Tool Calls ──
  tool_call: 'tool_call',
  tool_result: 'tool_call',
  'tool.call.completed': 'tool_call',
  'tool.call.failed': 'tool_call',
  dsl_call: 'tool_call',

  // ── Guardrails ──
  guardrail_check: 'input_guard',
  guardrail_violation: 'input_guard',
  guardrail_warning: 'input_guard',
  guardrail_fix: 'input_guard',
  guardrail_reask: 'input_guard',
  guardrail_pipeline_complete: 'input_guard',
  guardrail_pipeline_error: 'input_guard',
  guardrail_input_blocked: 'input_guard',
  guardrail_output_blocked: 'output_guard',
  guardrail_tool_blocked: 'input_guard',
  guardrail_tool_output_blocked: 'output_guard',
  guardrail_handoff_blocked: 'input_guard',
  guardrail_cost: 'input_guard',
  guardrail_circuit_breaker: 'input_guard',
  guardrail_cache_hit: 'input_guard',
  guardrail_cache_miss: 'input_guard',
  guardrail_provider_error: 'input_guard',

  // ── Flow / Transitions ──
  flow_step_enter: 'flow_transition',
  flow_step_exit: 'flow_transition',
  flow_transition: 'flow_transition',
  'flow.step.entered': 'flow_transition',
  'flow.step.exited': 'flow_transition',
  'flow.transition': 'flow_transition',

  // ── Gather / Extraction ──
  dsl_collect: 'gather',
  entity_extraction: 'gather',
  extraction_tier_selected: 'gather',
  extraction_attempt: 'gather',
  extraction_fallback: 'gather',
  extraction_parse_fallback: 'gather',
  extraction_strategy_resolved: 'gather',
  gather_field_activation: 'gather',
  gather_complete_reason: 'gather',
  dsl_on_input: 'gather',
  dsl_await_attachment: 'gather',
  constraint_backtrack: 'gather',
  constraint_backtrack_limit: 'gather',
  constraint_directive: 'gather',
  constraint_mini_collect: 'gather',

  // ── Decisions ──
  decision: 'decision',
  handoff: 'decision',
  'agent.decision': 'decision',
  'agent.handoff': 'decision',
  handoff_condition_check: 'decision',
  engine_decision: 'decision',
  completion_check: 'decision',
  correction: 'decision',
  correction_invalidation: 'decision',
  digression: 'decision',
  sub_intent: 'decision',
  pipeline_intent_bridge: 'decision',
  pipeline_tiered_action: 'decision',
  pipeline_out_of_scope_decline: 'decision',
  escalation: 'decision',
  constraint_check: 'decision',
  validation_fail_open: 'decision',

  // ── Agent Response ──
  agent_response: 'agent_response',
  dsl_respond: 'agent_response',
  dsl_prompt: 'agent_response',

  // ── Errors / Warnings ──
  error: 'error',
  'system.error': 'error',
  constraint_violation: 'error',
  warning: 'error',

  // ── Parallel Execution ──
  fan_out_start: 'parallel_tools',
  fan_out_task_start: 'parallel_tools',
  fan_out_task_complete: 'parallel_tools',
  fan_out_complete: 'parallel_tools',
  fan_out_child_created: 'parallel_tools',
  fan_out_child_completed: 'parallel_tools',

  // ── Memory ──
  data_stored: 'memory_diff',
  dsl_set: 'memory_diff',
  memory_init: 'memory_diff',
  memory_remember: 'memory_diff',
  memory_recall: 'memory_diff',
  memory_error: 'memory_diff',
  memory_preferences: 'memory_diff',
  memory_trigger_evaluated: 'memory_diff',
  memory_recall_result: 'memory_diff',
  memory_unavailable: 'memory_diff',
  preference_detected: 'memory_diff',
};

// =============================================================================
// HUMAN-READABLE EVENT LABELS
// =============================================================================

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

// =============================================================================
// LIFECYCLE & SESSION EVENT SETS
// =============================================================================

/** Events rendered as thin inline banners between steps — NOT step cards */
export const LIFECYCLE_EVENTS = new Set([
  'agent_enter',
  'agent_exit',
  'delegate_start',
  'delegate_complete',
  'thread_return',
]);

/** Events rendered as a session footer — NOT step cards */
export const SESSION_EVENTS = new Set(['session_resolution']);

// =============================================================================
// STATUS / MODE SETS
// =============================================================================

export const ERROR_EVENT_TYPES = new Set([
  'error',
  'system.error',
  'constraint_violation',
  'guardrail_violation',
  'guardrail_input_blocked',
  'guardrail_output_blocked',
  'guardrail_pipeline_error',
]);

export const WARNING_EVENT_TYPES = new Set([
  'warning',
  'guardrail_warning',
  'guardrail_cost',
  'extraction_fallback',
  'extraction_parse_fallback',
]);

export const SCRIPTED_MODE_EVENTS = new Set([
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  'dsl_collect',
  'dsl_prompt',
  'dsl_respond',
  'dsl_set',
  'dsl_on_input',
  'dsl_call',
  'flow.step.entered',
  'flow.step.exited',
  'flow.transition',
]);
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/sainathbhima/Documents/abl-platform && pnpm build --filter=@agent-platform/shared-kernel && npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/constants.ts
git add apps/studio/src/components/observatory/interactions/constants.ts
git commit -m "[ABLP-2] feat(observatory): expand EVENT_TO_STEP + add EVENT_LABELS, LIFECYCLE_EVENTS, SESSION_EVENTS"
```

---

### Task 3: Add New Types — LifecycleBanner + SessionResolution

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/types.ts`

- [ ] **Step 1: Add LifecycleBanner and SessionResolution interfaces, extend Interaction and ProcessedInteractions**

Add after the `InteractionStep` interface (before `Interaction`):

```ts
export type LifecycleBannerKind =
  | 'agent_enter'
  | 'agent_exit'
  | 'delegate_start'
  | 'delegate_complete'
  | 'thread_return';

export interface LifecycleBanner {
  id: string;
  timestamp: Date;
  kind: LifecycleBannerKind;
  agentName: string;
  targetAgent?: string;
  parentAgent?: string;
}

export interface SessionResolution {
  timestamp: Date;
  outcome: string;
  reason?: string;
  finalAgent?: string;
  durationMs?: number;
}
```

Add `banners` to `Interaction`:

```ts
export interface Interaction {
  id: string;
  index: number;
  agentName: string;
  agentMode: 'reasoning' | 'scripted' | 'unknown';
  status: 'ok' | 'warning' | 'error';
  startTime: Date;
  endTime: Date;
  durationMs: number;
  steps: InteractionStep[];
  banners: LifecycleBanner[];
}
```

Add `resolution` to `ProcessedInteractions`:

```ts
export interface ProcessedInteractions {
  interactions: Interaction[];
  summary: SessionSummary;
  agentPath: AgentPathNode[];
  agentSwitches: AgentSwitch[];
  resolution: SessionResolution | null;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: FAIL — `event-processor.ts` doesn't yet return `banners` or `resolution`. This is expected; Task 4 fixes it.

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/types.ts
git add apps/studio/src/components/observatory/interactions/types.ts
git commit -m "[ABLP-2] feat(observatory): add LifecycleBanner, SessionResolution types to interactions"
```

---

### Task 4: Update Event Processor — Banners, Resolution, New Step Data

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/event-processor.ts`

- [ ] **Step 1: Import LIFECYCLE_EVENTS and SESSION_EVENTS**

Add to the imports from `./constants`:

```ts
import {
  EVENT_TO_STEP,
  ERROR_EVENT_TYPES,
  WARNING_EVENT_TYPES,
  SCRIPTED_MODE_EVENTS,
  LIFECYCLE_EVENTS,
  SESSION_EVENTS,
} from './constants';
```

Add `LifecycleBanner` and `SessionResolution` to the type import:

```ts
import type {
  Interaction,
  InteractionStep,
  InteractionStepType,
  SessionSummary,
  AgentPathNode,
  AgentSwitch,
  ProcessedInteractions,
  LifecycleBanner,
  SessionResolution,
} from './types';
```

- [ ] **Step 2: Update processEventsToInteractions to return resolution**

In `processEventsToInteractions`, after `const agentSwitches = buildAgentSwitches(interactions);`, add:

```ts
const resolution = buildResolution(sorted);
```

Update the return to:

```ts
return { interactions, summary, agentPath, agentSwitches, resolution };
```

Update `emptySummary` return in the early exit:

```ts
if (events.length === 0) {
  return {
    interactions: [],
    summary: emptySummary(''),
    agentPath: [],
    agentSwitches: [],
    resolution: null,
  };
}
```

- [ ] **Step 3: Update classifySteps to extract lifecycle banners**

Change `buildInteraction` to also extract banners. Replace the existing `buildInteraction` function:

```ts
function buildInteraction(events: ExtendedTraceEvent[], index: number): Interaction {
  const { steps, banners } = classifyStepsAndBanners(events);
  const agentName = detectPrimaryAgent(events);
  const agentMode = detectAgentMode(events);
  const status = determineStatus(events);

  const startTime = events[0].timestamp;
  const endTime = events[events.length - 1].timestamp;
  const durationMs = endTime.getTime() - startTime.getTime();

  return {
    id: `interaction-${index}`,
    index,
    agentName,
    agentMode,
    status,
    startTime,
    endTime,
    durationMs,
    steps,
    banners,
  };
}
```

Rename `classifySteps` to `classifyStepsAndBanners` and add banner extraction:

```ts
function classifyStepsAndBanners(events: ExtendedTraceEvent[]): {
  steps: InteractionStep[];
  banners: LifecycleBanner[];
} {
  const steps: InteractionStep[] = [];
  const banners: LifecycleBanner[] = [];
  let currentStep: InteractionStep | null = null;

  for (const event of events) {
    // Lifecycle events → banners (not steps)
    if (LIFECYCLE_EVENTS.has(event.type)) {
      banners.push({
        id: `banner-${event.id}`,
        timestamp: event.timestamp,
        kind: event.type as LifecycleBanner['kind'],
        agentName: event.agentName ?? (event.data.agentName as string) ?? 'unknown',
        targetAgent: (event.data.toAgent ?? event.data.targetAgent ?? event.data.target) as
          | string
          | undefined,
        parentAgent: (event.data.fromAgent ?? event.data.parentAgent ?? event.data.from) as
          | string
          | undefined,
      });
      continue;
    }

    // Session events → skip (handled separately)
    if (SESSION_EVENTS.has(event.type)) {
      continue;
    }

    const stepType = EVENT_TO_STEP[event.type] as InteractionStepType | undefined;

    if (stepType) {
      if (currentStep && currentStep.type === stepType) {
        currentStep.events.push(event);
        if (event.durationMs) {
          currentStep.durationMs = (currentStep.durationMs ?? 0) + event.durationMs;
        }
        mergeStepData(currentStep, event);
      } else {
        currentStep = {
          id: `step-${event.id}`,
          type: stepType,
          timestamp: event.timestamp,
          durationMs: event.durationMs,
          agentName: event.agentName,
          events: [event],
          data: extractStepData(stepType, event),
        };
        steps.push(currentStep);
      }
    } else if (currentStep) {
      currentStep.events.push(event);
    }
  }

  return { steps, banners };
}
```

- [ ] **Step 4: Add buildResolution function**

Add at the end of the file (before `emptySummary`):

```ts
function buildResolution(sorted: ExtendedTraceEvent[]): SessionResolution | null {
  // Find the last session_resolution event
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    if (e.type === 'session_resolution') {
      return {
        timestamp: e.timestamp,
        outcome: (e.data.outcome ?? e.data.status ?? 'completed') as string,
        reason: e.data.reason as string | undefined,
        finalAgent: e.agentName ?? (e.data.agentName as string | undefined),
        durationMs: e.data.durationMs as number | undefined,
      };
    }
  }
  return null;
}
```

- [ ] **Step 5: Add new extractStepData cases for newly-mapped events**

In `extractStepData`, add/update these cases:

For the `decision` case, add the new decision types to the `decisionType` inference chain. After the existing line `(d.field && d.violation != null ? 'field_validation' : null) ??`, add:

```ts
        (event.type === 'correction' || event.type === 'correction_invalidation'
          ? 'correction'
          : null) ??
        (event.type === 'digression' ? 'digression' : null) ??
        (event.type === 'sub_intent' ? 'sub_intent' : null) ??
        (event.type === 'pipeline_intent_bridge' ? 'intent_bridge' : null) ??
        (event.type === 'pipeline_tiered_action' ? 'tiered_action' : null) ??
        (event.type === 'pipeline_out_of_scope_decline' ? 'out_of_scope' : null) ??
        (event.type === 'escalation' ? 'escalation' : null) ??
        (event.type === 'constraint_check' ? 'constraint_check' : null) ??
        (event.type === 'validation_fail_open' ? 'field_validation' : null) ??
```

For the `memory_diff` case, update to handle the broader set of memory events:

```ts
    case 'memory_diff':
      return {
        key: d.key ?? d.field,
        value: d.value,
        source: d.source ?? d.tool,
        contextBefore: d.contextBefore,
        contextAfter: d.contextAfter,
        sourceMap: d.sourceMap,
        readKeys: d.readKeys,
        memoryType: d.memoryType,
        operation: d.operation ?? event.type,
        query: d.query,
        found: d.found,
        preferences: d.preferences,
        trigger: d.trigger,
        result: d.result,
        reason: d.reason,
        preference: d.preference,
      };
```

For the `error` case, add severity:

```ts
    case 'error':
      return {
        message: d.message ?? d.error ?? (typeof d.code === 'string' ? d.code : 'Unknown error'),
        code: d.code ?? d.errorCode,
        severity: event.type === 'warning' ? 'warning' : 'error',
      };
```

- [ ] **Step 6: Add new mergeStepData cases for gather events**

In the `gather` case of `mergeStepData`, add after the existing merge logic:

```ts
// Merge new gather sub-events
if (d.strategy) step.data.strategy = d.strategy;
if (d.completeReason) step.data.completeReason = d.completeReason;
if (d.directive) step.data.directive = d.directive;
if (event.type === 'dsl_on_input') {
  step.data.userInput = d.userInput ?? d.input ?? d.content;
}
if (event.type === 'dsl_await_attachment') {
  step.data.awaitingAttachment = true;
}
if (event.type === 'gather_field_activation') {
  const activated = (step.data.activatedFields ?? []) as string[];
  const fieldName = (d.field ?? d.fieldName) as string | undefined;
  if (fieldName) activated.push(fieldName);
  step.data.activatedFields = activated;
}
if (event.type === 'constraint_backtrack') {
  step.data.backtracked = true;
  step.data.backtrackField = d.field ?? d.fieldName;
}
if (event.type === 'constraint_backtrack_limit') {
  step.data.backtrackLimitHit = true;
}
if (event.type === 'constraint_mini_collect') {
  const miniFields = (step.data.miniCollectFields ?? []) as string[];
  const fieldName = (d.field ?? d.fieldName) as string | undefined;
  if (fieldName) miniFields.push(fieldName);
  step.data.miniCollectFields = miniFields;
}
```

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS (or minor issues from downstream components not yet using `banners` — acceptable)

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/event-processor.ts
git add apps/studio/src/components/observatory/interactions/event-processor.ts
git commit -m "[ABLP-2] feat(observatory): update event processor — lifecycle banners, session resolution, expanded step data"
```

---

### Task 5: LifecycleBanner Component

**Files:**

- Create: `apps/studio/src/components/observatory/interactions/LifecycleBanner.tsx`

- [ ] **Step 1: Create the component**

```tsx
/**
 * LifecycleBanner — Thin inline divider for agent lifecycle events.
 *
 * Renders between step cards. Not a step card itself — just a
 * single-line contextual marker (agent entered/exited, delegation).
 */

import { getIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import { EVENT_LABELS } from './constants';
import type { LifecycleBanner as LifecycleBannerData } from './types';

interface LifecycleBannerProps {
  banner: LifecycleBannerData;
}

const BANNER_CONFIG: Record<
  LifecycleBannerData['kind'],
  { icon: string; intent: 'info' | 'warning' }
> = {
  agent_enter: { icon: '→', intent: 'info' },
  agent_exit: { icon: '←', intent: 'info' },
  delegate_start: { icon: '⤴', intent: 'warning' },
  delegate_complete: { icon: '⤵', intent: 'warning' },
  thread_return: { icon: '↩', intent: 'info' },
};

function getBannerText(banner: LifecycleBannerData): string {
  const label = EVENT_LABELS[banner.kind] ?? banner.kind;
  switch (banner.kind) {
    case 'agent_enter':
      return `${label} — ${banner.agentName}`;
    case 'agent_exit':
      return `${label} — ${banner.agentName}`;
    case 'delegate_start':
      return banner.targetAgent ? `${label} — ${banner.targetAgent}` : label;
    case 'delegate_complete':
      return label;
    case 'thread_return':
      return banner.parentAgent ? `${label} — ${banner.parentAgent}` : label;
  }
}

export function LifecycleBannerComponent({ banner }: LifecycleBannerProps) {
  const config = BANNER_CONFIG[banner.kind];
  const styles = getIntentStyles(config.intent);
  const text = getBannerText(banner);

  return (
    <div className="flex items-center gap-2 h-6 my-1">
      <div className={clsx('flex-1 h-px', styles.border ? 'bg-border-muted' : 'bg-border-muted')} />
      <span className="text-[9px] text-foreground-subtle flex items-center gap-1 shrink-0">
        <span>{config.icon}</span>
        <span>{text}</span>
      </span>
      <div className="flex-1 h-px bg-border-muted" />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/LifecycleBanner.tsx
git add apps/studio/src/components/observatory/interactions/LifecycleBanner.tsx
git commit -m "[ABLP-2] feat(observatory): add LifecycleBanner component for agent lifecycle events"
```

---

### Task 6: SessionResolutionFooter Component

**Files:**

- Create: `apps/studio/src/components/observatory/interactions/SessionResolutionFooter.tsx`

- [ ] **Step 1: Create the component**

```tsx
/**
 * SessionResolutionFooter — Footer bar showing session outcome.
 *
 * Rendered at the bottom of the interaction list when a
 * session_resolution event is present.
 */

import { useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import type { SessionResolution } from './types';

interface SessionResolutionFooterProps {
  resolution: SessionResolution;
}

function getResolutionIntent(outcome: string): SemanticIntent {
  switch (outcome) {
    case 'completed':
    case 'resolved':
    case 'success':
      return 'success';
    case 'escalated':
    case 'timeout':
      return 'warning';
    case 'abandoned':
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function getResolutionIcon(outcome: string): string {
  switch (outcome) {
    case 'completed':
    case 'resolved':
    case 'success':
      return '✓';
    case 'escalated':
      return '⬆';
    case 'abandoned':
      return '✕';
    case 'failed':
    case 'error':
      return '✕';
    default:
      return '•';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function SessionResolutionFooter({ resolution }: SessionResolutionFooterProps) {
  const intent = useMemo(() => getResolutionIntent(resolution.outcome), [resolution.outcome]);
  const styles = getIntentStyles(intent);
  const icon = getResolutionIcon(resolution.outcome);

  return (
    <div
      className={clsx(
        'mx-3 mt-2 mb-1 px-3 py-2 rounded-md border text-xs',
        styles.border,
        styles.bgSubtle,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={clsx('font-medium', styles.text)}>
          {icon} Session {resolution.outcome}
        </span>

        {resolution.finalAgent && (
          <>
            <span className="text-foreground-subtle">·</span>
            <span className="text-foreground-muted font-mono text-[10px]">
              {resolution.finalAgent}
            </span>
          </>
        )}

        {resolution.durationMs != null && (
          <>
            <span className="text-foreground-subtle">·</span>
            <span className="text-foreground-muted font-mono text-[10px]">
              {formatDuration(resolution.durationMs)}
            </span>
          </>
        )}

        {resolution.reason && (
          <>
            <span className="text-foreground-subtle">·</span>
            <span className="text-foreground-subtle text-[10px]">{resolution.reason}</span>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/SessionResolutionFooter.tsx
git add apps/studio/src/components/observatory/interactions/SessionResolutionFooter.tsx
git commit -m "[ABLP-2] feat(observatory): add SessionResolutionFooter component"
```

---

### Task 7: Update InteractionCard — Interleave Banners with Steps

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/InteractionCard.tsx`

- [ ] **Step 1: Import LifecycleBannerComponent and update rendering**

Add import:

```ts
import { LifecycleBannerComponent } from './LifecycleBanner';
import type { LifecycleBanner } from './types';
```

Inside the expanded content section (the `<div className="px-3 pt-2 pb-1 bg-background">` block), replace the step rendering with interleaved banners and steps:

Replace the block that filters and maps steps with:

```tsx
{
  /* Flow breadcrumb for scripted agents */
}
{
  interaction.agentMode === 'scripted' && <FlowBreadcrumb steps={interaction.steps} />;
}

{
  (() => {
    // Interleave steps and banners by timestamp
    const filteredSteps = interaction.steps.filter((s) => {
      if (s.type === 'flow_transition' && !s.data.fromStep && !s.data.toStep) {
        return false;
      }
      return true;
    });

    type TimelineItem =
      | { kind: 'step'; step: (typeof filteredSteps)[0]; index: number }
      | { kind: 'banner'; banner: LifecycleBanner };

    const items: TimelineItem[] = [
      ...filteredSteps.map((step, index) => ({ kind: 'step' as const, step, index })),
      ...interaction.banners.map((banner) => ({ kind: 'banner' as const, banner })),
    ].sort((a, b) => {
      const tsA = a.kind === 'step' ? a.step.timestamp.getTime() : a.banner.timestamp.getTime();
      const tsB = b.kind === 'step' ? b.step.timestamp.getTime() : b.banner.timestamp.getTime();
      return tsA - tsB;
    });

    return items.map((item, i) => {
      if (item.kind === 'banner') {
        return <LifecycleBannerComponent key={item.banner.id} banner={item.banner} />;
      }

      const isLastStep =
        items.filter((it) => it.kind === 'step').indexOf(item) ===
        items.filter((it) => it.kind === 'step').length - 1;

      return (
        <motion.div
          key={item.step.id}
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{
            duration: 0.5,
            delay: 0.15 + i * 0.12,
            ease: [0.16, 1, 0.3, 1],
          }}
        >
          <InteractionStep step={item.step} isLast={isLastStep} allSteps={interaction.steps} />
        </motion.div>
      );
    });
  })();
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/InteractionCard.tsx
git add apps/studio/src/components/observatory/interactions/InteractionCard.tsx
git commit -m "[ABLP-2] feat(observatory): interleave lifecycle banners with steps in InteractionCard"
```

---

### Task 8: Update InteractionsTab — Render SessionResolutionFooter

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/InteractionsTab.tsx`

- [ ] **Step 1: Import SessionResolutionFooter and render it**

Add import:

```ts
import { SessionResolutionFooter } from './SessionResolutionFooter';
```

Destructure `resolution` from `processed`:

```ts
const { summary, agentSwitches, resolution } = processed;
```

After the interactions list `</div>` but before the closing of the outer `<div className="flex flex-col h-full">`, add:

```tsx
{
  /* Session resolution footer */
}
{
  resolution && <SessionResolutionFooter resolution={resolution} />;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/InteractionsTab.tsx
git add apps/studio/src/components/observatory/interactions/InteractionsTab.tsx
git commit -m "[ABLP-2] feat(observatory): render SessionResolutionFooter in InteractionsTab"
```

---

### Task 9: Use EVENT_LABELS in RawEventBlock + Warning Severity in Error Renderer

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/InteractionStep.tsx`

- [ ] **Step 1: Import EVENT_LABELS**

Add to the imports from `./constants`:

```ts
import { STEP_CONFIG, EVENT_LABELS } from './constants';
```

- [ ] **Step 2: Use EVENT_LABELS in RawEventBlock**

In the `RawEventBlock` component, replace the raw `type` display with the label:

Change this line:

```tsx
<span>{type}</span>
```

To:

```tsx
<span>{EVENT_LABELS[type] ?? type}</span>
```

- [ ] **Step 3: Add warning severity to error renderer**

In `StepContent`, update the `case 'error'` block to check severity:

```tsx
    case 'error': {
      const isWarning = step.data.severity === 'warning';
      return (
        <div
          className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}
        >
          <div className={clsx('font-medium', isWarning ? 'text-warning' : 'text-error')}>
            {isWarning && (
              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-warning/10 text-warning mr-2">
                WARNING
              </span>
            )}
            {String(step.data.message ?? (isWarning ? 'Warning' : 'Error'))}
          </div>
          {step.data.code ? (
            <div className="text-foreground-subtle font-mono text-[10px] mt-0.5">
              {String(step.data.code)}
            </div>
          ) : null}
        </div>
      );
    }
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/InteractionStep.tsx
git add apps/studio/src/components/observatory/interactions/InteractionStep.tsx
git commit -m "[ABLP-2] feat(observatory): use EVENT_LABELS in raw events, add warning severity to error renderer"
```

---

### Task 10: Update Exports

**Files:**

- Modify: `apps/studio/src/components/observatory/interactions/index.ts`

- [ ] **Step 1: Add new exports**

Add to the exports:

```ts
export { LifecycleBannerComponent } from './LifecycleBanner';
export { SessionResolutionFooter } from './SessionResolutionFooter';
export { EVENT_LABELS, LIFECYCLE_EVENTS, SESSION_EVENTS } from './constants';
export type { LifecycleBanner, LifecycleBannerKind, SessionResolution } from './types';
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/interactions/index.ts
git add apps/studio/src/components/observatory/interactions/index.ts
git commit -m "[ABLP-2] feat(observatory): export new LifecycleBanner, SessionResolutionFooter, EVENT_LABELS"
```

---

### Task 11: Contract Test

**Files:**

- Create: `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`

- [ ] **Step 1: Create the contract test**

```ts
/**
 * Trace Event Contract Test
 *
 * Ensures every event in the shared RUNTIME_EVENT_TYPES registry
 * is accounted for in the studio UI mapping (EVENT_TO_STEP,
 * LIFECYCLE_EVENTS, or SESSION_EVENTS) and has a human-readable label.
 *
 * Also ensures the runtime EVENT_VERBOSITY keys are all in the registry.
 */

import { describe, test, expect } from 'vitest';
import { RUNTIME_EVENT_TYPES } from '../constants/trace-event-registry.js';

// ─── Studio-side mapping (duplicated here as constants for the contract) ──
// These MUST stay in sync with apps/studio/.../interactions/constants.ts.
// If this test fails, the studio mapping is out of sync.

const STUDIO_EVENT_TO_STEP_KEYS = new Set([
  // User Input
  'user_message',
  // LLM
  'llm_call',
  // Tool Calls
  'tool_call',
  'dsl_call',
  // Guardrails
  'guardrail_check',
  'guardrail_violation',
  'guardrail_warning',
  'guardrail_fix',
  'guardrail_reask',
  'guardrail_pipeline_complete',
  'guardrail_pipeline_error',
  'guardrail_input_blocked',
  'guardrail_output_blocked',
  'guardrail_tool_blocked',
  'guardrail_tool_output_blocked',
  'guardrail_handoff_blocked',
  'guardrail_cost',
  'guardrail_circuit_breaker',
  'guardrail_cache_hit',
  'guardrail_cache_miss',
  'guardrail_provider_error',
  // Flow
  'flow_step_enter',
  'flow_step_exit',
  'flow_transition',
  // Gather
  'dsl_collect',
  'entity_extraction',
  'extraction_tier_selected',
  'extraction_attempt',
  'extraction_fallback',
  'extraction_parse_fallback',
  'extraction_strategy_resolved',
  'gather_field_activation',
  'gather_complete_reason',
  'dsl_on_input',
  'dsl_await_attachment',
  'constraint_backtrack',
  'constraint_backtrack_limit',
  'constraint_directive',
  'constraint_mini_collect',
  // Decisions
  'decision',
  'handoff',
  'handoff_condition_check',
  'engine_decision',
  'completion_check',
  'correction',
  'correction_invalidation',
  'digression',
  'sub_intent',
  'pipeline_intent_bridge',
  'pipeline_tiered_action',
  'pipeline_out_of_scope_decline',
  'escalation',
  'constraint_check',
  'validation_fail_open',
  // Agent Response
  'agent_response',
  'dsl_respond',
  'dsl_prompt',
  // Errors
  'error',
  'constraint_violation',
  'warning',
  // Parallel
  'fan_out_start',
  'fan_out_task_start',
  'fan_out_task_complete',
  'fan_out_complete',
  'fan_out_child_created',
  'fan_out_child_completed',
  // Memory
  'data_stored',
  'dsl_set',
  'memory_init',
  'memory_remember',
  'memory_recall',
  'memory_error',
  'memory_preferences',
  'memory_trigger_evaluated',
  'memory_recall_result',
  'memory_unavailable',
  'preference_detected',
]);

const STUDIO_LIFECYCLE_EVENTS = new Set([
  'agent_enter',
  'agent_exit',
  'delegate_start',
  'delegate_complete',
  'thread_return',
]);

const STUDIO_SESSION_EVENTS = new Set(['session_resolution']);

// ─── Runtime-side EVENT_VERBOSITY keys ──
const RUNTIME_EVENT_VERBOSITY_KEYS = new Set([
  'error',
  'escalation',
  'completion_check',
  'warning',
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
  'llm_call',
  'engine_decision',
]);

describe('Trace Event Contract', () => {
  test('every RUNTIME_EVENT_TYPES entry is mapped in the studio UI', () => {
    const allMapped = new Set([
      ...STUDIO_EVENT_TO_STEP_KEYS,
      ...STUDIO_LIFECYCLE_EVENTS,
      ...STUDIO_SESSION_EVENTS,
    ]);

    const unmapped = RUNTIME_EVENT_TYPES.filter((e) => !allMapped.has(e));
    expect(unmapped).toEqual([]);
  });

  test('every EVENT_VERBOSITY key is in RUNTIME_EVENT_TYPES', () => {
    const registry = new Set<string>(RUNTIME_EVENT_TYPES);
    const missing = [...RUNTIME_EVENT_VERBOSITY_KEYS].filter((k) => !registry.has(k));
    expect(missing).toEqual([]);
  });

  test('RUNTIME_EVENT_TYPES has no duplicates', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of RUNTIME_EVENT_TYPES) {
      if (seen.has(e)) dupes.push(e);
      seen.add(e);
    }
    expect(dupes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/sainathbhima/Documents/abl-platform && pnpm build --filter=@agent-platform/shared-kernel && pnpm test --filter=@agent-platform/shared-kernel`
Expected: PASS — all 3 tests pass

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/shared-kernel/src/__tests__/trace-event-contract.test.ts
git add packages/shared-kernel/src/__tests__/trace-event-contract.test.ts
git commit -m "[ABLP-2] test(shared-kernel): add trace event contract test — validates complete UI mapping coverage"
```

---

### Task 12: Update Runtime trace-helpers to Reference Registry

**Files:**

- Modify: `apps/runtime/src/services/execution/trace-helpers.ts`

- [ ] **Step 1: Add a comment referencing the shared registry**

At the top of the `EVENT_VERBOSITY` record, add a comment:

```ts
/**
 * Map each trace event type to the minimum verbosity level required to emit it.
 *
 * All keys here MUST be present in RUNTIME_EVENT_TYPES from
 * @agent-platform/shared-kernel. The contract test in shared-kernel
 * verifies this automatically.
 */
```

This is a documentation-only change. The runtime doesn't import the registry at compile time (to avoid circular deps), but the contract test in shared-kernel verifies the keys match.

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/trace-helpers.ts
git add apps/runtime/src/services/execution/trace-helpers.ts
git commit -m "[ABLP-2] docs(runtime): reference RUNTIME_EVENT_TYPES contract in trace-helpers"
```

---

### Task 13: Full Build Verification

- [ ] **Step 1: Build shared-kernel + studio**

Run: `cd /Users/sainathbhima/Documents/abl-platform && pnpm build --filter=@agent-platform/shared-kernel && pnpm build --filter=studio`
Expected: PASS

- [ ] **Step 2: Run shared-kernel tests**

Run: `pnpm test --filter=@agent-platform/shared-kernel`
Expected: PASS — contract tests pass

- [ ] **Step 3: Run studio typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: PASS — no type errors
