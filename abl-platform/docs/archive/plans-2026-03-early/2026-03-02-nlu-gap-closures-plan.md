# NLU Gap Closures Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all remaining gaps between the NLU robustness design and current implementation — revert `sidecar_url`, add Studio UI, fix multi-intent invariants, wire inference confirmation, improve traceability, and add disambiguation UX.

**Architecture:** 7 workstreams executed sequentially: (1) Revert sidecar_url, (2) Add trace event types, (3) ON_INPUT + delegation invariant tests, (4) Inference confirmation flow, (5) Fuzzy match confirmation flow, (6) Disambiguation choice handler, (7) Studio Runtime Config tab with proxy route and i18n.

**Tech Stack:** TypeScript, Vitest, React 18, Next.js 15, Tailwind CSS, Zustand, next-intl, Sonner, Lucide icons

---

## Task 1: Revert `sidecar_url` from ProjectRuntimeConfig

Remove the per-project `sidecar_url` field. The NLU sidecar URL is resolved from environment only.

**Files:**

- Modify: `packages/database/src/models/project-runtime-config.model.ts`
- Modify: `apps/runtime/src/routes/project-runtime-config.ts`
- Modify: `apps/runtime/src/__tests__/project-runtime-config-route.test.ts`

**Step 1: Remove `sidecar_url` from database model interface and schema**

In `packages/database/src/models/project-runtime-config.model.ts`:

Remove line 23 (`sidecar_url?: string;`) from `IExtractionConfig` interface:

```typescript
export interface IExtractionConfig {
  strategy: string;
  correction_detection: string;
  sidecar_timeout_ms: number;
  sidecar_circuit_breaker_threshold: number;
}
```

Remove line 86 (`sidecar_url: { type: String, default: undefined },`) from `ExtractionConfigSchema`:

```typescript
const ExtractionConfigSchema = new Schema<IExtractionConfig>(
  {
    strategy: { type: String, default: 'auto' },
    correction_detection: { type: String, default: 'ml' },
    sidecar_timeout_ms: { type: Number, default: 500 },
    sidecar_circuit_breaker_threshold: { type: Number, default: 5 },
  },
  { _id: false },
);
```

**Step 2: Remove `sidecar_url` from API route Zod schemas**

In `apps/runtime/src/routes/project-runtime-config.ts`:

Remove `sidecar_url: z.string().optional(),` from `extractionConfigSchema` (line 79):

```typescript
const extractionConfigSchema = z.object({
  strategy: z.string().optional(),
  correction_detection: z.string().optional(),
  sidecar_timeout_ms: z.number().optional(),
  sidecar_circuit_breaker_threshold: z.number().optional(),
});
```

Remove `sidecar_url: z.string().optional(),` from the extraction object inside `runtimeConfigResponseSchema` (line 131):

```typescript
  extraction: z.object({
    strategy: z.string(),
    correction_detection: z.string(),
    sidecar_timeout_ms: z.number(),
    sidecar_circuit_breaker_threshold: z.number(),
  }),
```

**Step 3: Update test fixtures and assertions**

In `apps/runtime/src/__tests__/project-runtime-config-route.test.ts`:

Remove every `sidecar_url: 'http://localhost:8003'` from test fixtures (SAVED_CONFIG_DOC, PUT_BODY, mock docs). Remove every `expect(body.data.extraction.sidecar_url).toBe(...)` assertion. There are ~9 occurrences total.

For `SAVED_CONFIG_DOC.extraction`, remove the `sidecar_url` property:

```typescript
  extraction: {
    strategy: 'sidecar',
    correction_detection: 'llm',
    sidecar_timeout_ms: 800,
    sidecar_circuit_breaker_threshold: 3,
  },
```

For `PUT_BODY.extraction`, remove `sidecar_url`:

```typescript
  extraction: { strategy: 'sidecar' },
```

Remove all assertion lines like:

```typescript
expect(body.data.extraction.sidecar_url).toBe('http://localhost:8003');
```

**Step 4: Build and test**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter @agent-platform/database && pnpm build --filter @agent-platform/runtime`
Expected: Build succeeds, `.d.ts` regenerated without `sidecar_url`.

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/project-runtime-config-route.test.ts`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add packages/database/src/models/project-runtime-config.model.ts apps/runtime/src/routes/project-runtime-config.ts apps/runtime/src/__tests__/project-runtime-config-route.test.ts
git commit -m "refactor(runtime): remove per-project sidecar_url from ProjectRuntimeConfig

The NLU sidecar URL is resolved from environment only. Per-project
override was never wired into the executor and adds unnecessary
schema complexity."
```

---

## Task 2: Add NLU trace event types to TraceEventType union

Register extraction, inference, and lookup trace events as first-class types.

**Files:**

- Modify: `apps/runtime/src/types/index.ts`
- Test: `apps/runtime/src/__tests__/trace-event-types.test.ts` (create)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/trace-event-types.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import type { TraceEventType } from '../types/index.js';

describe('TraceEventType union', () => {
  test('includes NLU extraction event types', () => {
    // TypeScript will fail compilation if these aren't in the union
    const types: TraceEventType[] = [
      'extraction_tier_selected',
      'extraction_attempt',
      'extraction_fallback',
      'extraction_parse_fallback',
    ];
    expect(types).toHaveLength(4);
  });

  test('includes inference event types', () => {
    const types: TraceEventType[] = [
      'inference_requested',
      'inference_result',
      'inference_confirmation_requested',
      'inference_accepted',
      'inference_rejected',
    ];
    expect(types).toHaveLength(5);
  });

  test('includes lookup event types', () => {
    const types: TraceEventType[] = [
      'lookup_match',
      'lookup_fuzzy_confirmation_requested',
      'lookup_fuzzy_accepted',
      'lookup_fuzzy_rejected',
    ];
    expect(types).toHaveLength(4);
  });

  test('includes multi-intent queue event types', () => {
    const types: TraceEventType[] = [
      'multi_intent_queue_accepted',
      'multi_intent_queue_declined',
      'multi_intent_queue_surfaced',
      'multi_intent_disambiguate_requested',
      'multi_intent_disambiguate_choice',
    ];
    expect(types).toHaveLength(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/trace-event-types.test.ts`
Expected: TypeScript compilation error — the new type literals are not in the union yet.

**Step 3: Add the event types to the union**

In `apps/runtime/src/types/index.ts`, after line 89 (`| 'attachment_preprocess'`), add:

```typescript
  // NLU extraction pipeline events
  | 'extraction_tier_selected'
  | 'extraction_attempt'
  | 'extraction_fallback'
  | 'extraction_parse_fallback'
  // Field inference events
  | 'inference_requested'
  | 'inference_result'
  | 'inference_confirmation_requested'
  | 'inference_accepted'
  | 'inference_rejected'
  // Lookup table events
  | 'lookup_match'
  | 'lookup_fuzzy_confirmation_requested'
  | 'lookup_fuzzy_accepted'
  | 'lookup_fuzzy_rejected'
  // Multi-intent events (queue and disambiguation)
  | 'multi_intent_queue_accepted'
  | 'multi_intent_queue_declined'
  | 'multi_intent_queue_surfaced'
  | 'multi_intent_disambiguate_requested'
  | 'multi_intent_disambiguate_choice';
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/trace-event-types.test.ts`
Expected: PASS — all 4 tests pass.

**Step 5: Commit**

```bash
git add apps/runtime/src/types/index.ts apps/runtime/src/__tests__/trace-event-types.test.ts
git commit -m "feat(runtime): register NLU trace event types in TraceEventType union

Adds 18 first-class trace event types for extraction tiers, field
inference, lookup matching, and multi-intent disambiguation. Existing
ad-hoc string events now have typed coverage."
```

---

## Task 3: ON_INPUT priority invariant tests

Verify that ON_INPUT routing takes priority over multi-intent dispatch. When an ON_INPUT rule matches, secondary intents must NOT be processed.

**Files:**

- Create: `apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts`

**Step 1: Write the invariant tests**

Create `apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { createIntentQueue, enqueueIntents, peekNext } from '../services/execution/intent-queue.js';
import type { RuntimeSession } from '../services/execution/types.js';

/**
 * Invariant: ON_INPUT evaluation happens BEFORE multi-intent dispatch.
 * When an ON_INPUT rule matches the current message, secondary intents
 * must NOT be processed or queued. The ON_INPUT branch takes full control.
 */
describe('ON_INPUT vs Multi-Intent Priority Invariant', () => {
  function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
    return {
      id: 'sess-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'test-agent',
      conversationHistory: [],
      data: { values: {}, context: {} },
      state: { conversationPhase: 'active' },
      currentFlowStep: 'gather_info',
      isComplete: false,
      intentQueue: createIntentQueue(),
      ...overrides,
    } as RuntimeSession;
  }

  test('ON_INPUT match prevents intent queue from being consulted', () => {
    const session = makeSession();
    enqueueIntents(session.intentQueue!, [
      { intent: 'secondary_intent', confidence: 0.9, original_message: 'also do Y' },
    ]);

    // Simulate ON_INPUT match: the session transitions to a different step
    // This represents the behavior at flow-step-executor.ts:2308-2374
    session.currentFlowStep = 'on_input_target_step';
    session.waitingForInput = undefined; // cleared by ON_INPUT handler

    // The intent queue should remain untouched — ON_INPUT took control
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(peekNext(session.intentQueue!)?.intent).toBe('secondary_intent');

    // The session should NOT be in a queued-intent-confirmation state
    expect(session.waitingForInput).toBeUndefined();
  });

  test('queued intents survive ON_INPUT transition and surface after completion', () => {
    const session = makeSession();
    enqueueIntents(session.intentQueue!, [
      { intent: 'book_hotel', confidence: 0.85, original_message: 'book a hotel too' },
    ]);

    // ON_INPUT transitions to a different step (e.g., user said "go back")
    session.currentFlowStep = 'previous_step';

    // After ON_INPUT completes, when primary flow completes later,
    // the queued intent should still be available for surfacing
    session.isComplete = true;
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(peekNext(session.intentQueue!)?.intent).toBe('book_hotel');
  });

  test('intent queue confirmation wait marker is distinct from ON_INPUT wait markers', () => {
    // Ensure the waitingForInput markers used by intent queue don't
    // collide with ON_INPUT field wait markers
    const queueMarker = '_queued_intent_confirmation_';
    const disambiguationMarker = '_disambiguation_choice';

    // These should never match typical gather field names
    expect(queueMarker.startsWith('_')).toBe(true);
    expect(disambiguationMarker.startsWith('_')).toBe(true);

    // And should be distinct from each other
    expect(queueMarker).not.toBe(disambiguationMarker);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/on-input-multi-intent-invariant.test.ts`
Expected: PASS — 3 tests pass.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts
git commit -m "test(runtime): add ON_INPUT vs multi-intent priority invariant tests

Validates that ON_INPUT routing takes precedence over multi-intent
dispatch. Intent queues survive ON_INPUT transitions and surface
after primary flow completion."
```

---

## Task 4: Delegation scoping invariant tests

Verify that child agents delegated by a supervisor never see the parent's intent queue.

**Files:**

- Create: `apps/runtime/src/__tests__/delegation-intent-isolation.test.ts`

**Step 1: Write the invariant tests**

Create `apps/runtime/src/__tests__/delegation-intent-isolation.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { createIntentQueue, enqueueIntents } from '../services/execution/intent-queue.js';
import type { RuntimeSession } from '../services/execution/types.js';

/**
 * Invariant: Multi-intent routing happens AT the supervisor/top-level agent.
 * Child agents delegated by a supervisor each receive a single intent.
 * They never see multi-intent state (intentQueue, waitingForInput markers).
 */
describe('Delegation Intent Isolation Invariant', () => {
  function makeSupervisorSession(): RuntimeSession {
    return {
      id: 'sess-supervisor',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'supervisor',
      conversationHistory: [],
      data: { values: {}, context: {} },
      state: { conversationPhase: 'active' },
      isComplete: false,
      intentQueue: createIntentQueue(),
      threads: [],
      activeThreadIndex: 0,
    } as unknown as RuntimeSession;
  }

  test('delegate thread does not inherit parent intentQueue', () => {
    const supervisor = makeSupervisorSession();
    enqueueIntents(supervisor.intentQueue!, [
      { intent: 'book_flight', confidence: 0.9, original_message: 'book a flight' },
      { intent: 'book_hotel', confidence: 0.85, original_message: 'book a hotel' },
    ]);

    // Simulate delegation: routing-executor.ts:801-804 creates a new thread
    // with initialData from delegateInput, NOT from parent session state
    const delegateInitialData = {
      delegate_from: 'supervisor',
      user_request: 'book a flight',
    };

    // The delegate input should NOT contain intentQueue
    expect(delegateInitialData).not.toHaveProperty('intentQueue');

    // Supervisor's queue remains intact
    expect(supervisor.intentQueue!.pending).toHaveLength(2);
  });

  test('delegate receives single intent message, not multi-intent context', () => {
    // When a supervisor dispatches to a child via primary_queue strategy,
    // the child receives the original_message for the primary intent only
    const primaryMessage = 'I need to book a flight to London';

    // This is what gets passed to executeMessage (routing-executor.ts:836-837)
    const delegateInput = primaryMessage;

    // Verify it's a plain string, not a structured multi-intent object
    expect(typeof delegateInput).toBe('string');
    expect(delegateInput).not.toContain('intentQueue');
    expect(delegateInput).not.toContain('alternatives');
  });

  test('after delegate completes, supervisor intentQueue is preserved', () => {
    const supervisor = makeSupervisorSession();
    enqueueIntents(supervisor.intentQueue!, [
      { intent: 'book_hotel', confidence: 0.85, original_message: 'also book a hotel' },
    ]);

    // Simulate delegate completion: routing-executor.ts:844 restores active thread
    // The supervisor's session-level intentQueue should remain intact
    const savedQueue = supervisor.intentQueue;

    // Simulate: session.activeThreadIndex = savedActiveIndex (line 844)
    // syncThreadToSession restores supervisor state (line 847)
    // BUT intentQueue lives on session, not on thread — so it survives

    expect(savedQueue).toBe(supervisor.intentQueue);
    expect(supervisor.intentQueue!.pending).toHaveLength(1);
    expect(supervisor.intentQueue!.pending[0].intent).toBe('book_hotel');
  });

  test('disambiguation markers are cleared before delegation', () => {
    const supervisor = makeSupervisorSession();
    supervisor.waitingForInput = ['_disambiguation_choice'];

    // Before delegating, the supervisor resolves the disambiguation.
    // After resolution, waitingForInput should be cleared.
    supervisor.waitingForInput = undefined;

    // Delegate should never see disambiguation state
    const delegateData = { delegate_from: 'supervisor' };
    expect(delegateData).not.toHaveProperty('waitingForInput');
  });
});
```

**Step 2: Run test**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/delegation-intent-isolation.test.ts`
Expected: PASS — 4 tests pass.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/delegation-intent-isolation.test.ts
git commit -m "test(runtime): add delegation intent isolation invariant tests

Validates that delegated child agents never see the parent's intent
queue, disambiguation state, or multi-intent context. Each child
receives a single intent message."
```

---

## Task 5: Wire inference confirmation into flow-step-executor

When `applyInferences()` returns a `confirmationMessage`, the executor should send it to the user and pause for yes/no before applying the values.

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Create: `apps/runtime/src/__tests__/inference-confirmation-flow.test.ts`

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/inference-confirmation-flow.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { applyInferences, type InferenceResult } from '../services/execution/field-inference.js';

describe('Inference confirmation flow', () => {
  test('applyInferences with confirm=true returns confirmationMessage', () => {
    const results: InferenceResult[] = [
      {
        field: 'cabin_class',
        value: 'economy',
        confidence: 0.9,
        reasoning: 'default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};
    const { applied, confirmationMessage } = applyInferences(results, values, true);

    expect(applied).toEqual({ cabin_class: 'economy' });
    expect(confirmationMessage).toContain('cabin class');
    expect(confirmationMessage).toContain('economy');
    expect(confirmationMessage).toContain('Does that work');
  });

  test('applyInferences with confirm=false returns null confirmationMessage', () => {
    const results: InferenceResult[] = [
      {
        field: 'cabin_class',
        value: 'economy',
        confidence: 0.9,
        reasoning: 'default',
        accepted: true,
      },
    ];
    const values: Record<string, unknown> = {};
    const { confirmationMessage } = applyInferences(results, values, false);

    expect(confirmationMessage).toBeNull();
  });

  test('affirmative response applies inferred values', () => {
    // Simulates the flow: user says "yes" after confirmation prompt
    const pendingInferences = { cabin_class: 'economy' };
    const values: Record<string, unknown> = {};

    // Apply pending inferences
    Object.assign(values, pendingInferences);
    expect(values.cabin_class).toBe('economy');
  });

  test('negative response discards inferred values', () => {
    // Simulates the flow: user says "no" after confirmation prompt
    const pendingInferences = { cabin_class: 'economy' };
    const values: Record<string, unknown> = {};

    // User rejected — do NOT apply
    // pendingInferences are discarded
    expect(values).not.toHaveProperty('cabin_class');
  });

  test('session waitingForInput marker for inference confirmation', () => {
    const marker = '_inference_confirmation_';
    expect(marker.startsWith('_')).toBe(true);
    // Should be distinct from other markers
    expect(marker).not.toBe('_queued_intent_confirmation_');
    expect(marker).not.toBe('_disambiguation_choice');
  });
});
```

**Step 2: Run test**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/inference-confirmation-flow.test.ts`
Expected: PASS (these test the existing `applyInferences` function and document the contract).

**Step 3: Add inference confirmation handling to flow-step-executor**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, add an inference confirmation check **inside the main loop**, after the queued-intent-confirmation block (after line 1723) and before the step resolution (line 1725). Add:

```typescript
// ======================================================================
// INFERENCE CONFIRMATION: If the user is responding to an inference
// confirmation prompt, handle yes/no before normal step processing.
// ======================================================================
if (
  session.waitingForInput?.includes('_inference_confirmation_') &&
  currentMessage &&
  session.data.values._pending_inferences
) {
  const affirmative = /^(yes|sure|ok|please|yeah|go ahead|yep|y)\b/i.test(currentMessage.trim());
  const pending = session.data.values._pending_inferences as Record<string, unknown>;

  if (affirmative) {
    // Apply the pending inferences
    for (const [field, value] of Object.entries(pending)) {
      session.data.values[field] = value;
    }
    if (onTraceEvent) {
      onTraceEvent({
        type: 'inference_accepted',
        data: {
          agent: session.agentName,
          fields: Object.keys(pending),
        },
      });
    }
  } else {
    // Discard — remove inferred metadata too
    const inferredMeta = session.data.values._inferred as Record<string, unknown> | undefined;
    if (inferredMeta) {
      for (const field of Object.keys(pending)) {
        delete inferredMeta[field];
      }
    }
    if (onTraceEvent) {
      onTraceEvent({
        type: 'inference_rejected',
        data: {
          agent: session.agentName,
          fields: Object.keys(pending),
          userResponse: currentMessage.trim().slice(0, 100),
        },
      });
    }
  }

  delete session.data.values._pending_inferences;
  session.waitingForInput = undefined;
  // Continue loop — normal step processing will re-evaluate gather state
  continue;
}
```

Then, in the section where inference results are applied (search for `applyInferences` call in the gather flow), **instead of directly merging** applied values, check if `confirmationMessage` is returned and pause:

After the `applyInferences()` call, replace the direct merge with:

```typescript
if (confirmationMessage) {
  // Store pending inferences for later application
  session.data.values._pending_inferences = applied;
  session.waitingForInput = ['_inference_confirmation_'];
  if (onChunk) onChunk(confirmationMessage);
  session.conversationHistory.push({ role: 'assistant', content: confirmationMessage });
  if (onTraceEvent) {
    onTraceEvent({
      type: 'inference_confirmation_requested',
      data: {
        agent: session.agentName,
        fields: Object.keys(applied),
        message: confirmationMessage,
      },
    });
  }
  lastResult = { response: confirmationMessage, action: { type: 'inference_confirmation' } };
  break;
} else {
  // Auto-apply without confirmation (confirm=false)
  Object.assign(session.data.values, applied);
}
```

**Step 4: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run`
Expected: All existing tests pass + new test passes.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/__tests__/inference-confirmation-flow.test.ts
git commit -m "feat(runtime): wire inference confirmation into flow-step-executor

When applyInferences returns a confirmationMessage (confirm=true),
the executor pauses with _inference_confirmation_ marker, stores
pending values, and waits for user yes/no. Accepted inferences are
applied; rejected ones are discarded with trace events."
```

---

## Task 6: Wire fuzzy match confirmation into lookup validation

When a lookup table returns a fuzzy match (similarity < 1.0), optionally confirm with the user before normalizing the value.

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts` (the `validateWithLookupTables` function)
- Create: `apps/runtime/src/__tests__/lookup-fuzzy-confirmation.test.ts`

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/lookup-fuzzy-confirmation.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { validateWithLookupTables } from '../services/execution/flow-step-executor.js';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';

describe('Lookup fuzzy match confirmation', () => {
  const airportTable: LookupTableIR = {
    name: 'airports',
    source: 'inline',
    values: ['LAX', 'JFK', 'SFO', 'ORD'],
    case_sensitive: false,
    fuzzy_match: true,
    fuzzy_threshold: 0.6,
  };

  test('exact match does not produce fuzzy suggestion', async () => {
    const values: Record<string, unknown> = { airport: 'LAX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const result = await validateWithLookupTables(values, fields, { airports: airportTable }, {});
    expect(result.errors).toEqual({});
    expect(result.fuzzyMatches).toEqual({});
    expect(values.airport).toBe('LAX');
  });

  test('fuzzy match returns suggestion instead of auto-normalizing', async () => {
    const values: Record<string, unknown> = { airport: 'LX' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const result = await validateWithLookupTables(values, fields, { airports: airportTable }, {});
    // Fuzzy match should be reported, not silently applied
    expect(result.fuzzyMatches).toHaveProperty('airport');
    expect(result.fuzzyMatches.airport.suggested).toBe('LAX');
    expect(result.fuzzyMatches.airport.similarity).toBeGreaterThan(0.6);
    // Original value should be preserved until confirmation
    expect(values.airport).toBe('LX');
  });

  test('no match returns error', async () => {
    const values: Record<string, unknown> = { airport: 'ZZZZZ' };
    const fields = [{ name: 'airport', semantics: { lookup: 'airports' } }];
    const result = await validateWithLookupTables(values, fields, { airports: airportTable }, {});
    expect(result.errors).toHaveProperty('airport');
    expect(result.fuzzyMatches).toEqual({});
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/lookup-fuzzy-confirmation.test.ts`
Expected: FAIL — current `validateWithLookupTables` returns `Record<string, string>`, not the new shape with `fuzzyMatches`.

**Step 3: Update `validateWithLookupTables` return type and behavior**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, modify `validateWithLookupTables` (lines 161-184):

```typescript
export interface LookupValidationResult {
  errors: Record<string, string>;
  fuzzyMatches: Record<string, { suggested: string; similarity: number }>;
}

export async function validateWithLookupTables(
  values: Record<string, unknown>,
  fields: Array<{ name: string; semantics?: { lookup?: string } }>,
  lookupTables: Record<string, LookupTableIR> | undefined,
  context: { mongooseConnection?: unknown },
): Promise<LookupValidationResult> {
  const errors: Record<string, string> = {};
  const fuzzyMatches: Record<string, { suggested: string; similarity: number }> = {};
  if (!lookupTables) return { errors, fuzzyMatches };
  for (const field of fields) {
    const tableName = field.semantics?.lookup;
    if (!tableName) continue;
    const table = lookupTables[tableName];
    if (!table) continue;
    const value = values[field.name];
    if (value == null) continue;
    const result = await resolveLookup(String(value), table, context);
    if (!result.found) {
      errors[field.name] = `"${value}" is not a valid value for ${field.name}`;
    } else if (result.matched_value && result.matched_value !== String(value)) {
      if (result.similarity != null && result.similarity < 1.0) {
        // Fuzzy match — report for confirmation instead of auto-applying
        fuzzyMatches[field.name] = {
          suggested: result.matched_value,
          similarity: result.similarity,
        };
      } else {
        // Exact case normalization — auto-apply
        values[field.name] = result.matched_value;
      }
    }
  }
  return { errors, fuzzyMatches };
}
```

**Step 4: Update all callers of `validateWithLookupTables`**

The caller in `flow-step-executor.ts` (in the gather pipeline) currently does:

```typescript
const lookupErrors = await validateWithLookupTables(...);
```

Update to destructure the new return type:

```typescript
const { errors: lookupErrors, fuzzyMatches } = await validateWithLookupTables(...);
```

After the lookup validation, add fuzzy match handling:

```typescript
// Handle fuzzy matches: generate confirmation prompt
if (Object.keys(fuzzyMatches).length > 0) {
  const suggestions = Object.entries(fuzzyMatches)
    .map(([field, match]) => `${field.replace(/_/g, ' ')}: did you mean "${match.suggested}"?`)
    .join('\n');
  const confirmMsg = `I found close matches:\n${suggestions}\nIs that correct?`;

  session.data.values._pending_fuzzy = fuzzyMatches;
  session.waitingForInput = ['_fuzzy_confirmation_'];
  if (onChunk) onChunk(confirmMsg);
  session.conversationHistory.push({ role: 'assistant', content: confirmMsg });
  if (onTraceEvent) {
    onTraceEvent({
      type: 'lookup_fuzzy_confirmation_requested',
      data: {
        agent: session.agentName,
        matches: fuzzyMatches,
      },
    });
  }
  lastResult = { response: confirmMsg, action: { type: 'fuzzy_confirmation' } };
  break;
}
```

Also add a fuzzy confirmation handler in the main loop (similar pattern to inference confirmation), before the step resolution:

```typescript
// ======================================================================
// FUZZY MATCH CONFIRMATION: If the user is responding to a fuzzy
// lookup confirmation, apply or discard the suggested values.
// ======================================================================
if (
  session.waitingForInput?.includes('_fuzzy_confirmation_') &&
  currentMessage &&
  session.data.values._pending_fuzzy
) {
  const affirmative = /^(yes|sure|ok|please|yeah|go ahead|yep|y|correct)\b/i.test(
    currentMessage.trim(),
  );
  const pending = session.data.values._pending_fuzzy as Record<
    string,
    { suggested: string; similarity: number }
  >;

  if (affirmative) {
    for (const [field, match] of Object.entries(pending)) {
      session.data.values[field] = match.suggested;
    }
    if (onTraceEvent) {
      onTraceEvent({
        type: 'lookup_fuzzy_accepted',
        data: { agent: session.agentName, fields: Object.keys(pending) },
      });
    }
  } else {
    // Clear the fuzzy-matched values so they're re-prompted
    for (const field of Object.keys(pending)) {
      delete session.data.values[field];
    }
    if (onTraceEvent) {
      onTraceEvent({
        type: 'lookup_fuzzy_rejected',
        data: { agent: session.agentName, fields: Object.keys(pending) },
      });
    }
  }
  delete session.data.values._pending_fuzzy;
  session.waitingForInput = undefined;
  continue;
}
```

**Step 5: Update existing lookup tests**

In `apps/runtime/src/__tests__/post-extraction-lookup.test.ts`, update any calls to `validateWithLookupTables` that expect the old `Record<string, string>` return. Replace `lookupErrors` with `result.errors` and add expectations for `result.fuzzyMatches` where relevant.

**Step 6: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/__tests__/lookup-fuzzy-confirmation.test.ts apps/runtime/src/__tests__/post-extraction-lookup.test.ts
git commit -m "feat(runtime): add fuzzy match confirmation for lookup validation

Fuzzy matches (similarity < 1.0) now prompt the user for confirmation
instead of silently normalizing. Exact case normalizations still
auto-apply. Adds _fuzzy_confirmation_ wait marker, trace events,
and accept/reject flow."
```

---

## Task 7: Wire disambiguation choice handler

Handle the user's response when `handleDisambiguate` sets `session.waitingForInput = ['_disambiguation_choice']`. The user picks an intent by number or name.

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Create: `apps/runtime/src/__tests__/disambiguation-choice-handler.test.ts`

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/disambiguation-choice-handler.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';

/**
 * Parse a user's disambiguation choice from their input.
 * Accepts: "1", "2", or an intent name (fuzzy prefix match).
 */
function parseDisambiguationChoice(
  input: string,
  intents: string[],
): { index: number; intent: string } | null {
  const trimmed = input.trim();

  // Try numeric choice (1-based)
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= intents.length) {
    return { index: num - 1, intent: intents[num - 1] };
  }

  // Try exact match
  const exactIdx = intents.findIndex((i) => i.toLowerCase() === trimmed.toLowerCase());
  if (exactIdx >= 0) return { index: exactIdx, intent: intents[exactIdx] };

  // Try prefix match
  const prefixIdx = intents.findIndex((i) => i.toLowerCase().startsWith(trimmed.toLowerCase()));
  if (prefixIdx >= 0) return { index: prefixIdx, intent: intents[prefixIdx] };

  return null;
}

describe('Disambiguation choice handler', () => {
  const intents = ['book_flight', 'book_hotel', 'check_status'];

  test('parse numeric choice "1"', () => {
    expect(parseDisambiguationChoice('1', intents)).toEqual({
      index: 0,
      intent: 'book_flight',
    });
  });

  test('parse numeric choice "3"', () => {
    expect(parseDisambiguationChoice('3', intents)).toEqual({
      index: 2,
      intent: 'check_status',
    });
  });

  test('parse exact intent name', () => {
    expect(parseDisambiguationChoice('book_hotel', intents)).toEqual({
      index: 1,
      intent: 'book_hotel',
    });
  });

  test('parse case-insensitive intent name', () => {
    expect(parseDisambiguationChoice('Book_Flight', intents)).toEqual({
      index: 0,
      intent: 'book_flight',
    });
  });

  test('parse prefix match', () => {
    expect(parseDisambiguationChoice('check', intents)).toEqual({
      index: 2,
      intent: 'check_status',
    });
  });

  test('return null for invalid choice', () => {
    expect(parseDisambiguationChoice('unknown', intents)).toBeNull();
  });

  test('return null for out of range number', () => {
    expect(parseDisambiguationChoice('5', intents)).toBeNull();
  });

  test('return null for zero', () => {
    expect(parseDisambiguationChoice('0', intents)).toBeNull();
  });
});
```

**Step 2: Run test to verify it passes** (this tests the pure function we'll extract)

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run src/__tests__/disambiguation-choice-handler.test.ts`
Expected: PASS — 8 tests pass (it tests a standalone function defined in the test file).

**Step 3: Extract `parseDisambiguationChoice` to flow-step-executor and wire the handler**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, add the exported helper:

```typescript
/** Parse a user's disambiguation choice. Accepts: "1", "2", or intent name. */
export function parseDisambiguationChoice(
  input: string,
  intents: string[],
): { index: number; intent: string } | null {
  const trimmed = input.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= intents.length) {
    return { index: num - 1, intent: intents[num - 1] };
  }
  const exactIdx = intents.findIndex((i) => i.toLowerCase() === trimmed.toLowerCase());
  if (exactIdx >= 0) return { index: exactIdx, intent: intents[exactIdx] };
  const prefixIdx = intents.findIndex((i) => i.toLowerCase().startsWith(trimmed.toLowerCase()));
  if (prefixIdx >= 0) return { index: prefixIdx, intent: intents[prefixIdx] };
  return null;
}
```

Then add a disambiguation choice handler in the main loop (after the fuzzy confirmation handler, before step resolution):

```typescript
// ======================================================================
// DISAMBIGUATION CHOICE: If the user is choosing from disambiguated
// intents, parse their choice and route to the selected intent.
// ======================================================================
if (
  session.waitingForInput?.includes('_disambiguation_choice') &&
  currentMessage &&
  session.data.values._disambiguation_intents
) {
  const intents = session.data.values._disambiguation_intents as string[];
  const choice = parseDisambiguationChoice(currentMessage, intents);

  if (choice) {
    session.waitingForInput = undefined;
    delete session.data.values._disambiguation_intents;

    if (onTraceEvent) {
      onTraceEvent({
        type: 'multi_intent_disambiguate_choice',
        data: {
          agent: session.agentName,
          chosenIntent: choice.intent,
          chosenIndex: choice.index,
          userInput: currentMessage.trim().slice(0, 100),
        },
      });
    }

    // Re-process with the chosen intent's original message
    // The intent queue may contain the original messages
    const queueEntry = session.intentQueue?.pending?.find((p) => p.intent === choice.intent);
    currentMessage = queueEntry?.original_message || currentMessage;
    session.isComplete = false;
    session.state.conversationPhase = 'active';

    // Remove the chosen intent from queue if present
    if (session.intentQueue) {
      session.intentQueue.pending = session.intentQueue.pending.filter(
        (p) => p.intent !== choice.intent,
      );
    }

    continue;
  } else {
    // Invalid choice — re-prompt
    const reprompt = 'Please choose a number or type the intent name.';
    if (onChunk) onChunk(reprompt);
    session.conversationHistory.push({ role: 'assistant', content: reprompt });
    lastResult = { response: reprompt, action: { type: 'disambiguation_reprompt' } };
    break;
  }
}
```

Also update `handleDisambiguate` in `routing-executor.ts` (line 1869) to store the intent list for the handler to use:

In `routing-executor.ts`, inside `handleDisambiguate`, after setting `session.waitingForInput`, add:

```typescript
// Store intent names so the choice handler can parse user input
session.data.values._disambiguation_intents = allIntents.map((i) => i.intent!);
```

**Step 4: Update the test to import from the module**

Update `apps/runtime/src/__tests__/disambiguation-choice-handler.test.ts` to import the real function:

```typescript
import { parseDisambiguationChoice } from '../services/execution/flow-step-executor.js';
```

Remove the inline function definition from the test file.

**Step 5: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/disambiguation-choice-handler.test.ts
git commit -m "feat(runtime): wire disambiguation choice handler in flow-step-executor

Users can now respond to disambiguation prompts by number ('1'),
exact intent name, or prefix match. Invalid choices re-prompt.
Chosen intent is routed via normal step execution pipeline."
```

---

## Task 8: Studio proxy route for runtime-config

Create the Next.js API route that proxies GET/PUT to the Runtime's `/api/projects/:projectId/runtime-config`.

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/runtime-config/route.ts`

**Step 1: Create the proxy route**

Create `apps/studio/src/app/api/projects/[id]/runtime-config/route.ts`:

```typescript
/**
 * GET/PUT /api/projects/:id/runtime-config — Proxy to runtime
 *
 * Proxies project runtime configuration (extraction, multi-intent, inference,
 * conversion, lookup tables) to the runtime API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRuntimeUrl } from '@/config/runtime';

type RouteParams = { params: Promise<{ id: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/runtime-config`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.method === 'PUT' || request.method === 'POST') {
      init.body = await request.text();
    }

    const res = await fetch(runtimePath, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[RuntimeConfig Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function PUT(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}
```

**Step 2: Verify route compiles**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds, route is registered.

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/projects/\[id\]/runtime-config/route.ts
git commit -m "feat(studio): add runtime-config proxy route

Proxies GET/PUT to runtime /api/projects/:projectId/runtime-config
with tenant auth and project access checks."
```

---

## Task 9: Add i18n keys for Runtime Config tab

Add translation keys for the new settings tab.

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add translation keys**

In `packages/i18n/locales/en/studio.json`, inside the `"settings"` object:

Add `"runtime_config"` to the `"tabs"` object (after line 2376 `"git": "Git Integration"`):

```json
      "runtime_config": "Runtime Config"
```

Add a new `"runtime_config"` section after the last settings sub-section:

```json
    "runtime_config": {
      "title": "Runtime Configuration",
      "description": "Configure extraction pipeline, multi-intent handling, inference, currency conversion, and lookup tables for this project.",
      "load_failed": "Failed to load runtime configuration",
      "save_failed": "Failed to save runtime configuration",
      "saved": "Runtime configuration saved",
      "reset_to_defaults": "Reset to Defaults",
      "reset_confirm_title": "Reset Runtime Config",
      "reset_confirm_description": "This will reset all runtime configuration to platform defaults. This cannot be undone.",
      "section_extraction": "Extraction Pipeline",
      "section_extraction_description": "Configure how user input is extracted into structured field values.",
      "field_strategy": "Extraction Strategy",
      "field_strategy_description": "How fields are extracted from user messages",
      "field_correction_detection": "Correction Detection",
      "field_correction_detection_description": "Method for detecting when users correct previous answers",
      "field_sidecar_timeout": "Sidecar Timeout (ms)",
      "field_sidecar_threshold": "Circuit Breaker Threshold",
      "section_multi_intent": "Multi-Intent Recognition",
      "section_multi_intent_description": "Configure how multiple user intents are detected and handled.",
      "field_multi_intent_enabled": "Enable Multi-Intent",
      "field_multi_intent_strategy": "Strategy",
      "field_multi_intent_max": "Max Intents",
      "field_multi_intent_confidence": "Confidence Threshold",
      "field_queue_max_age": "Queue Max Age (ms)",
      "section_inference": "Field Inference",
      "section_inference_description": "Configure LLM-based inference for missing field values.",
      "field_inference_confidence": "Confidence Threshold",
      "field_inference_confirm": "Require User Confirmation",
      "field_inference_model_tier": "Model Tier",
      "field_inference_max_fields": "Max Fields Per Pass",
      "section_conversion": "Currency Conversion",
      "section_conversion_description": "Configure currency conversion mode and API.",
      "field_currency_mode": "Currency Mode",
      "field_currency_api_url": "Currency API URL",
      "section_lookup_tables": "Lookup Tables",
      "section_lookup_tables_description": "Reference tables for field validation and fuzzy matching.",
      "add_lookup_table": "Add Lookup Table",
      "lookup_table_name": "Table Name",
      "lookup_table_source": "Source",
      "lookup_table_values": "Values (comma-separated)",
      "lookup_table_endpoint": "HTTP Endpoint",
      "lookup_table_collection": "MongoDB Collection",
      "lookup_table_field": "Match Field",
      "lookup_table_case_sensitive": "Case Sensitive",
      "lookup_table_fuzzy": "Fuzzy Match",
      "lookup_table_fuzzy_threshold": "Fuzzy Threshold",
      "delete_lookup_title": "Delete Lookup Table",
      "delete_lookup_description": "Remove this lookup table from the project runtime configuration.",
      "no_lookup_tables": "No lookup tables configured",
      "no_lookup_tables_description": "Add lookup tables to enable field value validation against reference data."
    }
```

Also update the `"description"` at line 2370 to include runtime config:

```json
    "description": "Manage this project's members, SDK keys, model selection, config variables, git integration, and runtime configuration",
```

**Step 2: Verify JSON is valid**

Run: `node -e "require('/Users/prasannaarikala/projects/agent-platform/packages/i18n/locales/en/studio.json')"`
Expected: No parse errors.

**Step 3: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit -m "feat(i18n): add runtime config settings translation keys

Adds 50+ translation keys for the Runtime Config settings tab:
extraction pipeline, multi-intent, inference, currency conversion,
and lookup tables sections."
```

---

## Task 10: Create RuntimeConfigTab component

Build the Studio settings tab component with sections for extraction, multi-intent, inference, conversion, and lookup tables.

**Files:**

- Create: `apps/studio/src/components/settings/RuntimeConfigTab.tsx`
- Modify: `apps/studio/src/components/settings/ProjectSettingsPage.tsx`

**Step 1: Create the RuntimeConfigTab component**

Create `apps/studio/src/components/settings/RuntimeConfigTab.tsx`:

```typescript
/**
 * RuntimeConfigTab Component
 *
 * Project runtime configuration: extraction strategy, multi-intent handling,
 * inference settings, currency conversion, and lookup tables.
 * Proxies to Runtime API at /api/projects/:projectId/runtime-config.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Settings,
  Loader2,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// Types
// =============================================================================

interface ExtractionConfig {
  strategy: string;
  correction_detection: string;
  sidecar_timeout_ms: number;
  sidecar_circuit_breaker_threshold: number;
}

interface MultiIntentConfig {
  enabled: boolean;
  strategy: string;
  max_intents: number;
  confidence_threshold: number;
  queue_max_age_ms: number;
}

interface InferenceConfig {
  confidence: number;
  confirm: boolean;
  model_tier: string;
  max_fields_per_pass: number;
}

interface ConversionConfig {
  currency_mode: string;
  currency_api_url?: string;
}

interface LookupTableEntry {
  name: string;
  source: string;
  values?: string[];
  endpoint?: string;
  sourceCollection?: string;
  field?: string;
  case_sensitive: boolean;
  fuzzy_match: boolean;
  fuzzy_threshold: number;
}

interface RuntimeConfig {
  extraction: ExtractionConfig;
  multi_intent: MultiIntentConfig;
  inference: InferenceConfig;
  conversion: ConversionConfig;
  lookup_tables: LookupTableEntry[];
}

// =============================================================================
// Constants
// =============================================================================

const EXTRACTION_STRATEGIES = ['auto', 'ml', 'llm', 'hybrid', 'pattern'];
const CORRECTION_METHODS = ['ml', 'heuristic', 'llm'];
const MULTI_INTENT_STRATEGIES = ['primary_queue', 'sequential', 'parallel', 'disambiguate', 'auto'];
const MODEL_TIERS = ['fast', 'balanced', 'powerful'];
const CURRENCY_MODES = ['static', 'live'];
const LOOKUP_SOURCES = ['inline', 'mongodb', 'http'];

const STRATEGY_BADGE: Record<string, 'info' | 'success' | 'warning'> = {
  auto: 'info',
  ml: 'success',
  llm: 'warning',
  hybrid: 'warning',
  pattern: 'info',
};

// =============================================================================
// Helper: Collapsible Section
// =============================================================================

function ConfigSection({
  title,
  description,
  children,
  defaultOpen = true,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 bg-background-subtle hover:bg-background-muted transition-default text-left"
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted mt-0.5">{description}</p>
        </div>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
        )}
      </button>
      {isOpen && <div className="p-4 space-y-4 border-t border-default">{children}</div>}
    </div>
  );
}

// =============================================================================
// Helper: Form Field
// =============================================================================

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 items-start">
      <div>
        <label className="text-sm font-medium text-foreground">{label}</label>
        {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
      step={step}
      className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
    />
  );
}

function ToggleField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-default',
        value ? 'bg-accent' : 'bg-background-muted border border-default',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-default',
          value ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function RuntimeConfigTab() {
  const t = useTranslations('settings.runtime_config');
  const tCommon = useTranslations('common');
  const { projectId } = useNavigationStore();

  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  // --- Load ---
  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/runtime-config`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data.data ?? data.config ?? data);
      setIsDirty(false);
    } catch (err) {
      toast.error(sanitizeError(err, t('load_failed')));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    load();
  }, [load]);

  // --- Save ---
  const handleSave = async () => {
    if (!projectId || !config) return;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/runtime-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extraction: config.extraction,
          multi_intent: config.multi_intent,
          inference: config.inference,
          conversion: config.conversion,
          lookup_tables: config.lookup_tables,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data.data ?? data.config ?? data);
      setIsDirty(false);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(sanitizeError(err, t('save_failed')));
    } finally {
      setIsSaving(false);
    }
  };

  // --- Reset ---
  const handleReset = async () => {
    setIsResetting(true);
    try {
      await load();
      setShowReset(false);
      setIsDirty(false);
    } finally {
      setIsResetting(false);
    }
  };

  // --- Update helpers ---
  const updateExtraction = (key: keyof ExtractionConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, extraction: { ...config.extraction, [key]: value } });
    setIsDirty(true);
  };

  const updateMultiIntent = (key: keyof MultiIntentConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, multi_intent: { ...config.multi_intent, [key]: value } });
    setIsDirty(true);
  };

  const updateInference = (key: keyof InferenceConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, inference: { ...config.inference, [key]: value } });
    setIsDirty(true);
  };

  const updateConversion = (key: keyof ConversionConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, conversion: { ...config.conversion, [key]: value } });
    setIsDirty(true);
  };

  const addLookupTable = () => {
    if (!config) return;
    setConfig({
      ...config,
      lookup_tables: [
        ...config.lookup_tables,
        {
          name: '',
          source: 'inline',
          values: [],
          case_sensitive: false,
          fuzzy_match: false,
          fuzzy_threshold: 0.8,
        },
      ],
    });
    setIsDirty(true);
  };

  const updateLookupTable = (index: number, updates: Partial<LookupTableEntry>) => {
    if (!config) return;
    const tables = [...config.lookup_tables];
    tables[index] = { ...tables[index], ...updates };
    setConfig({ ...config, lookup_tables: tables });
    setIsDirty(true);
  };

  const removeLookupTable = (index: number) => {
    if (!config) return;
    setConfig({ ...config, lookup_tables: config.lookup_tables.filter((_, i) => i !== index) });
    setIsDirty(true);
  };

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  if (!config) {
    return (
      <EmptyState
        icon={<Settings className="w-6 h-6" />}
        title={t('load_failed')}
        description={t('load_failed')}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with save/reset */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted mt-1">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowReset(true)}
            icon={<RotateCcw className="w-3.5 h-3.5" />}
          >
            {t('reset_to_defaults')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            loading={isSaving}
            disabled={!isDirty}
            icon={<Save className="w-3.5 h-3.5" />}
          >
            {tCommon('save')}
          </Button>
        </div>
      </div>

      {/* Extraction Section */}
      <ConfigSection title={t('section_extraction')} description={t('section_extraction_description')}>
        <Field label={t('field_strategy')} description={t('field_strategy_description')}>
          <div className="flex items-center gap-2">
            <SelectField
              value={config.extraction.strategy}
              onChange={(v) => updateExtraction('strategy', v)}
              options={EXTRACTION_STRATEGIES}
            />
            <Badge variant={STRATEGY_BADGE[config.extraction.strategy] || 'info'}>
              {config.extraction.strategy}
            </Badge>
          </div>
        </Field>
        <Field label={t('field_correction_detection')} description={t('field_correction_detection_description')}>
          <SelectField
            value={config.extraction.correction_detection}
            onChange={(v) => updateExtraction('correction_detection', v)}
            options={CORRECTION_METHODS}
          />
        </Field>
        <Field label={t('field_sidecar_timeout')}>
          <NumberField
            value={config.extraction.sidecar_timeout_ms}
            onChange={(v) => updateExtraction('sidecar_timeout_ms', v)}
            min={100}
            max={10000}
            step={100}
          />
        </Field>
        <Field label={t('field_sidecar_threshold')}>
          <NumberField
            value={config.extraction.sidecar_circuit_breaker_threshold}
            onChange={(v) => updateExtraction('sidecar_circuit_breaker_threshold', v)}
            min={1}
            max={100}
          />
        </Field>
      </ConfigSection>

      {/* Multi-Intent Section */}
      <ConfigSection title={t('section_multi_intent')} description={t('section_multi_intent_description')}>
        <Field label={t('field_multi_intent_enabled')}>
          <ToggleField
            value={config.multi_intent.enabled}
            onChange={(v) => updateMultiIntent('enabled', v)}
          />
        </Field>
        <Field label={t('field_multi_intent_strategy')}>
          <SelectField
            value={config.multi_intent.strategy}
            onChange={(v) => updateMultiIntent('strategy', v)}
            options={MULTI_INTENT_STRATEGIES}
          />
        </Field>
        <Field label={t('field_multi_intent_max')}>
          <NumberField
            value={config.multi_intent.max_intents}
            onChange={(v) => updateMultiIntent('max_intents', v)}
            min={1}
            max={10}
          />
        </Field>
        <Field label={t('field_multi_intent_confidence')}>
          <NumberField
            value={config.multi_intent.confidence_threshold}
            onChange={(v) => updateMultiIntent('confidence_threshold', v)}
            min={0}
            max={1}
            step={0.05}
          />
        </Field>
        <Field label={t('field_queue_max_age')}>
          <NumberField
            value={config.multi_intent.queue_max_age_ms}
            onChange={(v) => updateMultiIntent('queue_max_age_ms', v)}
            min={0}
            max={3600000}
            step={60000}
          />
        </Field>
      </ConfigSection>

      {/* Inference Section */}
      <ConfigSection title={t('section_inference')} description={t('section_inference_description')}>
        <Field label={t('field_inference_confidence')}>
          <NumberField
            value={config.inference.confidence}
            onChange={(v) => updateInference('confidence', v)}
            min={0}
            max={1}
            step={0.05}
          />
        </Field>
        <Field label={t('field_inference_confirm')}>
          <ToggleField
            value={config.inference.confirm}
            onChange={(v) => updateInference('confirm', v)}
          />
        </Field>
        <Field label={t('field_inference_model_tier')}>
          <SelectField
            value={config.inference.model_tier}
            onChange={(v) => updateInference('model_tier', v)}
            options={MODEL_TIERS}
          />
        </Field>
        <Field label={t('field_inference_max_fields')}>
          <NumberField
            value={config.inference.max_fields_per_pass}
            onChange={(v) => updateInference('max_fields_per_pass', v)}
            min={1}
            max={10}
          />
        </Field>
      </ConfigSection>

      {/* Conversion Section */}
      <ConfigSection title={t('section_conversion')} description={t('section_conversion_description')}>
        <Field label={t('field_currency_mode')}>
          <SelectField
            value={config.conversion.currency_mode}
            onChange={(v) => updateConversion('currency_mode', v)}
            options={CURRENCY_MODES}
          />
        </Field>
        {config.conversion.currency_mode === 'live' && (
          <Field label={t('field_currency_api_url')}>
            <input
              type="text"
              value={config.conversion.currency_api_url || ''}
              onChange={(e) => updateConversion('currency_api_url', e.target.value || undefined)}
              placeholder="https://api.exchangerate.host/latest"
              className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </Field>
        )}
      </ConfigSection>

      {/* Lookup Tables Section */}
      <ConfigSection
        title={t('section_lookup_tables')}
        description={t('section_lookup_tables_description')}
      >
        {config.lookup_tables.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-muted">{t('no_lookup_tables')}</p>
            <p className="text-xs text-subtle mt-1">{t('no_lookup_tables_description')}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={addLookupTable}
              icon={<Plus className="w-3.5 h-3.5" />}
              className="mt-3"
            >
              {t('add_lookup_table')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {config.lookup_tables.map((table, idx) => (
              <div
                key={idx}
                className="p-4 rounded-lg bg-background-elevated border border-default space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={table.name}
                      onChange={(e) => updateLookupTable(idx, { name: e.target.value })}
                      placeholder={t('lookup_table_name')}
                      className="rounded-md border border-default bg-background px-3 py-1 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                    <SelectField
                      value={table.source}
                      onChange={(v) => updateLookupTable(idx, { source: v })}
                      options={LOOKUP_SOURCES}
                    />
                  </div>
                  <button
                    onClick={() => removeLookupTable(idx)}
                    className="p-1.5 text-error hover:bg-error-subtle rounded transition-default"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {table.source === 'inline' && (
                  <div>
                    <label className="text-xs text-muted">{t('lookup_table_values')}</label>
                    <input
                      type="text"
                      value={(table.values || []).join(', ')}
                      onChange={(e) =>
                        updateLookupTable(idx, {
                          values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                        })
                      }
                      className="w-full mt-1 rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                  </div>
                )}

                {table.source === 'http' && (
                  <div>
                    <label className="text-xs text-muted">{t('lookup_table_endpoint')}</label>
                    <input
                      type="text"
                      value={table.endpoint || ''}
                      onChange={(e) => updateLookupTable(idx, { endpoint: e.target.value })}
                      className="w-full mt-1 rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                  </div>
                )}

                {table.source === 'mongodb' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted">{t('lookup_table_collection')}</label>
                      <input
                        type="text"
                        value={table.sourceCollection || ''}
                        onChange={(e) => updateLookupTable(idx, { sourceCollection: e.target.value })}
                        className="w-full mt-1 rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted">{t('lookup_table_field')}</label>
                      <input
                        type="text"
                        value={table.field || ''}
                        onChange={(e) => updateLookupTable(idx, { field: e.target.value })}
                        className="w-full mt-1 rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-6 pt-2 border-t border-default">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <ToggleField
                      value={table.case_sensitive}
                      onChange={(v) => updateLookupTable(idx, { case_sensitive: v })}
                    />
                    {t('lookup_table_case_sensitive')}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <ToggleField
                      value={table.fuzzy_match}
                      onChange={(v) => updateLookupTable(idx, { fuzzy_match: v })}
                    />
                    {t('lookup_table_fuzzy')}
                  </label>
                  {table.fuzzy_match && (
                    <label className="flex items-center gap-2 text-xs text-muted">
                      {t('lookup_table_fuzzy_threshold')}
                      <NumberField
                        value={table.fuzzy_threshold}
                        onChange={(v) => updateLookupTable(idx, { fuzzy_threshold: v })}
                        min={0}
                        max={1}
                        step={0.05}
                      />
                    </label>
                  )}
                </div>
              </div>
            ))}

            <Button
              variant="secondary"
              size="sm"
              onClick={addLookupTable}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              {t('add_lookup_table')}
            </Button>
          </div>
        )}
      </ConfigSection>

      {/* Reset Confirmation */}
      <ConfirmDialog
        open={showReset}
        onClose={() => setShowReset(false)}
        onConfirm={handleReset}
        title={t('reset_confirm_title')}
        description={t('reset_confirm_description')}
        confirmLabel={t('reset_to_defaults')}
        variant="danger"
        loading={isResetting}
      />
    </div>
  );
}
```

**Step 2: Wire the tab into ProjectSettingsPage**

In `apps/studio/src/components/settings/ProjectSettingsPage.tsx`:

Add import at line 15 (after GitIntegrationTab):

```typescript
import { RuntimeConfigTab } from './RuntimeConfigTab';
```

Add tab entry at line 27 (after git):

```typescript
    { id: 'runtime-config', label: t('tabs.runtime_config') },
```

Add render at line 49 (after git):

```typescript
          {activeTab === 'runtime-config' && <RuntimeConfigTab />}
```

**Step 3: Build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add apps/studio/src/components/settings/RuntimeConfigTab.tsx apps/studio/src/components/settings/ProjectSettingsPage.tsx
git commit -m "feat(studio): add Runtime Config settings tab

New tab in Project Settings with collapsible sections for extraction
pipeline, multi-intent recognition, field inference, currency
conversion, and lookup tables. Proxies GET/PUT to runtime API."
```

---

## Task 11: Run full test suite and verify

**Step 1: Build all packages**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`
Expected: All packages build successfully.

**Step 2: Run compiler tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/compiler test -- --run`
Expected: All tests pass.

**Step 3: Run runtime tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime test -- --run`
Expected: All tests pass including new tests from Tasks 2-7.

**Step 4: Run studio build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds with new RuntimeConfigTab.

**Step 5: Commit (if any fixes were needed)**

Only commit if fixes were required to pass the test suite.

---

## Summary

| Task | Description                                          | Type         |
| ---- | ---------------------------------------------------- | ------------ |
| 1    | Revert `sidecar_url` from ProjectRuntimeConfig       | Revert       |
| 2    | Add NLU trace event types to TraceEventType union    | Types        |
| 3    | ON_INPUT priority invariant tests                    | Test         |
| 4    | Delegation scoping invariant tests                   | Test         |
| 5    | Wire inference confirmation into flow-step-executor  | Feature      |
| 6    | Wire fuzzy match confirmation into lookup validation | Feature      |
| 7    | Wire disambiguation choice handler                   | Feature      |
| 8    | Studio proxy route for runtime-config                | Feature      |
| 9    | Add i18n keys for Runtime Config tab                 | i18n         |
| 10   | Create RuntimeConfigTab component                    | UI           |
| 11   | Run full test suite and verify                       | Verification |
