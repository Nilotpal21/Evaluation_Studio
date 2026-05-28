# Phase 2: Multi-Intent Recognition — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement multi-intent recognition with 5 configurable strategies (sequential, parallel, primary_queue, disambiguate, auto) and an LLM-decided auto mode that assesses intent relationships.

**Architecture:** Extend the existing NLU engine to detect and return multiple intents with relationship analysis. Add strategy dispatch in the routing executor. `primary_queue` is the safe default — secondary intents are queued and surfaced after the primary flow completes. `parallel` is restricted to supervisor agents only (they can fan-out to child agents). `auto` mode lets the LLM decide the best strategy based on intent relationships.

**Tech Stack:** TypeScript, Vitest, Mongoose (ProjectRuntimeConfig from Phase 1)

**Design Doc:** `docs/plans/2026-03-01-nlu-robustness-design.md`

**Prerequisite:** Phase 1 must be complete (ProjectRuntimeConfig model, IR schema updates).

---

## Task 1: Add MultiIntentStrategy and IntentHandlingConfig to IR schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts`

**Step 1: Add types to IR schema**

In `packages/compiler/src/platform/ir/schema.ts`, add after the existing `NLUIRConfig` interface (around line 1005):

```typescript
/** Multi-intent handling strategy */
export type MultiIntentStrategy =
  | 'sequential' // Execute intents in order, pass context forward
  | 'parallel' // Fan-out to sub-agents (supervisor only)
  | 'primary_queue' // Handle primary, queue rest, surface after completion
  | 'disambiguate' // Ask user to choose
  | 'auto'; // LLM decides based on intent relationships

/** Intent relationship type (assessed by LLM during detection) */
export type IntentRelationshipType = 'independent' | 'dependent' | 'ambiguous';

/** Multi-intent configuration on AgentIR */
export interface IntentHandlingConfig {
  multi_intent?: {
    enabled: boolean;
    strategy: MultiIntentStrategy;
    max_intents: number;
    confidence_threshold: number;
    queue_max_age_ms: number;
  };
}
```

Add `intent_handling?: IntentHandlingConfig` to the `AgentIR` interface.

**Step 2: Build**

```bash
pnpm --filter @agent-platform/compiler build
```

Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "[ABLP-2] feat(compiler): add MultiIntentStrategy and IntentHandlingConfig to IR schema"
```

---

## Task 2: Extend IntentResult with alternatives and relationships

**Files:**

- Modify: `packages/compiler/src/platform/nlu/types.ts`
- Test: `packages/compiler/src/__tests__/nlu/multi-intent-types.test.ts`

**Step 1: Write type validation test**

```typescript
// packages/compiler/src/__tests__/nlu/multi-intent-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  IntentResult,
  MultiIntentResult,
  IntentRelationship,
} from '../../platform/nlu/types.js';

describe('Multi-Intent Types', () => {
  it('IntentResult supports alternatives field', () => {
    const result: IntentResult = {
      intent: 'book_hotel',
      confidence: 0.92,
      source: 'fast',
      alternatives: [{ intent: 'check_availability', confidence: 0.65 }],
    };
    expect(result.alternatives).toHaveLength(1);
  });

  it('MultiIntentResult contains primary + alternatives + relationships', () => {
    const result: MultiIntentResult = {
      primary: { intent: 'book_hotel', confidence: 0.92, source: 'fast' },
      alternatives: [{ intent: 'rent_car', confidence: 0.85, source: 'fast' }],
      relationships: {
        type: 'independent',
        reasoning: 'Both are travel tasks but neither depends on the other',
      },
    };
    expect(result.primary.intent).toBe('book_hotel');
    expect(result.alternatives).toHaveLength(1);
    expect(result.relationships.type).toBe('independent');
  });

  it('IntentRelationship supports all relationship types', () => {
    const types: IntentRelationship['type'][] = ['independent', 'dependent', 'ambiguous'];
    types.forEach((t) => {
      const rel: IntentRelationship = { type: t, reasoning: '' };
      expect(rel.type).toBe(t);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/nlu/multi-intent-types.test.ts
```

Expected: FAIL — `MultiIntentResult` and `IntentRelationship` not exported

**Step 3: Add types to NLU types**

In `packages/compiler/src/platform/nlu/types.ts`, add:

```typescript
/** Relationship between detected intents */
export interface IntentRelationship {
  type: 'independent' | 'dependent' | 'ambiguous';
  reasoning: string;
}

/** Full multi-intent detection result */
export interface MultiIntentResult {
  primary: IntentResult;
  alternatives: IntentResult[];
  relationships: IntentRelationship;
}
```

Ensure the existing `IntentResult` interface still has the `alternatives` field (it should already exist around line 258).

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/nlu/multi-intent-types.test.ts
```

Expected: All PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/nlu/types.ts packages/compiler/src/__tests__/nlu/multi-intent-types.test.ts
git commit -m "[ABLP-2] feat(compiler): add MultiIntentResult and IntentRelationship types"
```

---

## Task 3: Update LLM intent detection prompt for multi-intent

**Files:**

- Modify: `packages/compiler/src/platform/nlu/tasks/intent-detector.ts`
- Test: `packages/compiler/src/__tests__/nlu/intent-detector-multi.test.ts`

**Step 1: Write tests for multi-intent LLM prompt**

```typescript
// packages/compiler/src/__tests__/nlu/intent-detector-multi.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Multi-Intent LLM Detection', () => {
  it('parses multi-intent JSON response', () => {
    const response = JSON.stringify({
      intents: [
        { intent: 'book_hotel', confidence: 0.92 },
        { intent: 'rent_car', confidence: 0.85 },
      ],
      relationships: {
        type: 'independent',
        reasoning: 'Both are travel tasks but independent',
      },
    });

    const parsed = JSON.parse(response);
    expect(parsed.intents).toHaveLength(2);
    expect(parsed.relationships.type).toBe('independent');
  });

  it('handles single-intent response (backward compatible)', () => {
    const response = JSON.stringify({
      intent: 'book_hotel',
      confidence: 0.92,
    });

    const parsed = JSON.parse(response);
    // Single-intent format should still work
    expect(parsed.intent).toBe('book_hotel');
    expect(parsed.intents).toBeUndefined();
  });

  it('respects max_intents cap', () => {
    const maxIntents = 3;
    const rawIntents = [
      { intent: 'a', confidence: 0.9 },
      { intent: 'b', confidence: 0.8 },
      { intent: 'c', confidence: 0.7 },
      { intent: 'd', confidence: 0.6 },
      { intent: 'e', confidence: 0.5 },
    ];

    const capped = rawIntents.sort((a, b) => b.confidence - a.confidence).slice(0, maxIntents);

    expect(capped).toHaveLength(3);
    expect(capped[0].intent).toBe('a');
  });

  it('filters by confidence threshold', () => {
    const threshold = 0.6;
    const intents = [
      { intent: 'a', confidence: 0.9 },
      { intent: 'b', confidence: 0.7 },
      { intent: 'c', confidence: 0.4 }, // below threshold
    ];

    const filtered = intents.filter((i) => i.confidence >= threshold);
    expect(filtered).toHaveLength(2);
  });
});
```

**Step 2: Run test**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/nlu/intent-detector-multi.test.ts
```

Expected: All PASS (these are pure logic tests)

**Step 3: Update the intent detector prompt**

In `packages/compiler/src/platform/nlu/tasks/intent-detector.ts`, modify the `detectIntentWithLLM()` method's system prompt to request multiple intents:

Change the prompt from:

```
Classify the user message into one of the following intents.
Return JSON: { "intent": "...", "confidence": 0.0-1.0 }
```

To:

```
Classify the user message into ALL matching intents from the following list.
Return JSON:
{
  "intents": [
    { "intent": "intent_name", "confidence": 0.0-1.0 },
    ...
  ],
  "relationships": {
    "type": "independent" | "dependent" | "ambiguous",
    "reasoning": "brief explanation of how the intents relate"
  }
}

If only one intent matches, return a single entry in the intents array.
Only include intents with confidence >= 0.5.
```

Add a response parser that handles both old single-intent format and new multi-intent format:

```typescript
function parseIntentResponse(
  json: Record<string, unknown>,
  maxIntents: number,
  threshold: number,
): MultiIntentResult {
  // Handle new multi-intent format
  if (Array.isArray(json.intents)) {
    const intents = (json.intents as Array<{ intent: string; confidence: number }>)
      .filter((i) => i.confidence >= threshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxIntents);

    const primary = intents[0]
      ? { intent: intents[0].intent, confidence: intents[0].confidence, source: 'fast' as const }
      : { intent: null, confidence: 0, source: 'fast' as const };

    return {
      primary,
      alternatives: intents.slice(1).map((i) => ({
        intent: i.intent,
        confidence: i.confidence,
        source: 'fast' as const,
      })),
      relationships: (json.relationships as IntentRelationship) ?? {
        type: 'ambiguous',
        reasoning: '',
      },
    };
  }

  // Handle legacy single-intent format (backward compatible)
  return {
    primary: {
      intent: (json.intent as string) ?? null,
      confidence: (json.confidence as number) ?? 0.8,
      source: 'fast',
    },
    alternatives: [],
    relationships: { type: 'ambiguous', reasoning: '' },
  };
}
```

**Step 4: Build**

```bash
pnpm --filter @agent-platform/compiler build
```

Expected: BUILD SUCCESS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/nlu/tasks/intent-detector.ts packages/compiler/src/__tests__/nlu/intent-detector-multi.test.ts
git commit -m "[ABLP-2] feat(compiler): update intent detector LLM prompt for multi-intent"
```

---

## Task 4: Wire matchTopN into embedding layer

**Files:**

- Modify: `packages/compiler/src/platform/nlu/engine.ts`

**Step 1: Update detectIntent to use matchTopN**

In `engine.ts`, find the `detectIntent()` method (around line 80-132). Where it currently calls `embeddingIntentIndex.match()` (line ~96), change to:

```typescript
// Use matchTopN instead of match for multi-intent support
if (this.embeddingIntentIndex) {
  const topMatches = await this.embeddingIntentIndex.matchTopN(
    ctx.message,
    multiIntentConfig?.max_intents ?? 3,
  );

  if (topMatches.length > 0 && topMatches[0].score >= (this.config.embeddings?.threshold ?? 0.85)) {
    const primary: IntentResult = {
      intent: topMatches[0].label,
      confidence: topMatches[0].score,
      source: 'embedding',
      alternatives: topMatches
        .slice(1)
        .filter((m) => m.score >= (multiIntentConfig?.confidence_threshold ?? 0.6))
        .map((m) => ({ intent: m.label, confidence: m.score })),
    };
    return primary;
  }
}
```

**Step 2: Build and test**

```bash
pnpm --filter @agent-platform/compiler build && pnpm --filter @agent-platform/compiler test
```

Expected: All PASS

**Step 3: Commit**

```bash
git add packages/compiler/src/platform/nlu/engine.ts
git commit -m "[ABLP-2] feat(compiler): wire matchTopN into embedding layer for multi-intent"
```

---

## Task 5: Create intent queue module

**Files:**

- Create: `apps/runtime/src/services/execution/intent-queue.ts`
- Test: `apps/runtime/src/__tests__/intent-queue.test.ts`

**Step 1: Write failing tests**

```typescript
// apps/runtime/src/__tests__/intent-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IntentQueue,
  createIntentQueue,
  enqueueIntents,
  dequeueNext,
  pruneExpired,
  peekNext,
} from '../services/execution/intent-queue.js';

describe('IntentQueue', () => {
  let queue: IntentQueue;

  beforeEach(() => {
    queue = createIntentQueue();
  });

  it('creates empty queue', () => {
    expect(queue.pending).toEqual([]);
  });

  it('enqueues intents sorted by confidence', () => {
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.7, original_message: 'msg' },
      { intent: 'b', confidence: 0.9, original_message: 'msg' },
    ]);
    expect(queue.pending[0].intent).toBe('b');
    expect(queue.pending[1].intent).toBe('a');
  });

  it('dequeues highest confidence first', () => {
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.7, original_message: 'msg' },
      { intent: 'b', confidence: 0.9, original_message: 'msg' },
    ]);
    const next = dequeueNext(queue);
    expect(next!.intent).toBe('b');
    expect(queue.pending).toHaveLength(1);
  });

  it('returns null when queue is empty', () => {
    expect(dequeueNext(queue)).toBeNull();
  });

  it('peeks without removing', () => {
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.9, original_message: 'msg' }]);
    const peeked = peekNext(queue);
    expect(peeked!.intent).toBe('a');
    expect(queue.pending).toHaveLength(1);
  });

  it('prunes expired entries', () => {
    queue.pending = [
      {
        intent: 'old',
        confidence: 0.8,
        original_message: 'msg',
        detected_at: new Date(Date.now() - 700_000).toISOString(), // 11+ min ago
      },
      {
        intent: 'fresh',
        confidence: 0.8,
        original_message: 'msg',
        detected_at: new Date().toISOString(),
      },
    ];

    pruneExpired(queue, 600_000); // 10 min max age
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].intent).toBe('fresh');
  });

  it('prevents duplicate intents', () => {
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.7, original_message: 'msg' }]);
    enqueueIntents(queue, [{ intent: 'a', confidence: 0.9, original_message: 'msg2' }]);
    // Should update confidence, not duplicate
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].confidence).toBe(0.9);
  });
});
```

**Step 2: Run test to verify failure**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/intent-queue.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement intent queue**

```typescript
// apps/runtime/src/services/execution/intent-queue.ts
/**
 * Intent queue for multi-intent primary_queue strategy.
 * Stores secondary intents detected in a message for processing after primary intent completes.
 */

export interface QueuedIntent {
  intent: string;
  confidence: number;
  original_message: string;
  detected_at: string; // ISO timestamp
}

export interface IntentQueue {
  pending: QueuedIntent[];
}

export function createIntentQueue(): IntentQueue {
  return { pending: [] };
}

export function enqueueIntents(
  queue: IntentQueue,
  intents: Array<{ intent: string; confidence: number; original_message: string }>,
): void {
  for (const incoming of intents) {
    const existing = queue.pending.findIndex((q) => q.intent === incoming.intent);
    if (existing >= 0) {
      // Update confidence if higher
      if (incoming.confidence > queue.pending[existing].confidence) {
        queue.pending[existing].confidence = incoming.confidence;
        queue.pending[existing].original_message = incoming.original_message;
        queue.pending[existing].detected_at = new Date().toISOString();
      }
    } else {
      queue.pending.push({
        ...incoming,
        detected_at: new Date().toISOString(),
      });
    }
  }
  // Sort by confidence descending
  queue.pending.sort((a, b) => b.confidence - a.confidence);
}

export function dequeueNext(queue: IntentQueue): QueuedIntent | null {
  return queue.pending.shift() ?? null;
}

export function peekNext(queue: IntentQueue): QueuedIntent | null {
  return queue.pending[0] ?? null;
}

export function pruneExpired(queue: IntentQueue, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  queue.pending = queue.pending.filter((q) => new Date(q.detected_at).getTime() > cutoff);
}
```

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/intent-queue.test.ts
```

Expected: All PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/intent-queue.ts apps/runtime/src/__tests__/intent-queue.test.ts
git commit -m "[ABLP-2] feat(runtime): add intent queue for multi-intent primary_queue strategy"
```

---

## Task 6: Create multi-intent strategy resolver

**Files:**

- Create: `apps/runtime/src/services/execution/multi-intent-strategy.ts`
- Test: `apps/runtime/src/__tests__/multi-intent-strategy.test.ts`

**Step 1: Write failing tests**

```typescript
// apps/runtime/src/__tests__/multi-intent-strategy.test.ts
import { describe, it, expect } from 'vitest';
import { resolveStrategy } from '../services/execution/multi-intent-strategy.js';

describe('resolveStrategy', () => {
  describe('explicit strategy', () => {
    it('returns declared strategy for supervisor', () => {
      expect(resolveStrategy('parallel', 'supervisor', 'independent')).toBe('parallel');
    });

    it('returns declared strategy for scripted', () => {
      expect(resolveStrategy('sequential', 'scripted', 'independent')).toBe('sequential');
    });

    it('downgrades parallel to sequential for non-supervisor', () => {
      expect(resolveStrategy('parallel', 'scripted', 'independent')).toBe('sequential');
      expect(resolveStrategy('parallel', 'reasoning', 'independent')).toBe('sequential');
    });

    it('allows parallel for supervisor', () => {
      expect(resolveStrategy('parallel', 'supervisor', 'independent')).toBe('parallel');
    });
  });

  describe('auto strategy', () => {
    it('auto + independent + supervisor → parallel', () => {
      expect(resolveStrategy('auto', 'supervisor', 'independent')).toBe('parallel');
    });

    it('auto + independent + scripted → sequential (downgraded)', () => {
      expect(resolveStrategy('auto', 'scripted', 'independent')).toBe('sequential');
    });

    it('auto + independent + reasoning → sequential (downgraded)', () => {
      expect(resolveStrategy('auto', 'reasoning', 'independent')).toBe('sequential');
    });

    it('auto + dependent + any → sequential', () => {
      expect(resolveStrategy('auto', 'supervisor', 'dependent')).toBe('sequential');
      expect(resolveStrategy('auto', 'scripted', 'dependent')).toBe('sequential');
    });

    it('auto + ambiguous + any → disambiguate', () => {
      expect(resolveStrategy('auto', 'supervisor', 'ambiguous')).toBe('disambiguate');
      expect(resolveStrategy('auto', 'scripted', 'ambiguous')).toBe('disambiguate');
    });
  });

  describe('primary_queue', () => {
    it('always allowed for all agent types', () => {
      expect(resolveStrategy('primary_queue', 'scripted', 'independent')).toBe('primary_queue');
      expect(resolveStrategy('primary_queue', 'reasoning', 'dependent')).toBe('primary_queue');
      expect(resolveStrategy('primary_queue', 'supervisor', 'ambiguous')).toBe('primary_queue');
    });
  });

  describe('disambiguate', () => {
    it('always allowed for all agent types', () => {
      expect(resolveStrategy('disambiguate', 'scripted', 'independent')).toBe('disambiguate');
    });
  });
});
```

**Step 2: Run test to verify failure**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/multi-intent-strategy.test.ts
```

Expected: FAIL

**Step 3: Implement strategy resolver**

```typescript
// apps/runtime/src/services/execution/multi-intent-strategy.ts
/**
 * Multi-intent strategy resolution.
 * Resolves the declared (or auto) strategy based on agent type and intent relationships.
 * Enforces restrictions: parallel is supervisor-only.
 */
import { createLogger } from '@abl/compiler/platform';
import type {
  MultiIntentStrategy,
  IntentRelationshipType,
} from '@abl/compiler/platform/ir/schema.js';

const log = createLogger('multi-intent-strategy');

type AgentType = 'scripted' | 'reasoning' | 'supervisor';

const SUPERVISOR_ONLY_STRATEGIES: MultiIntentStrategy[] = ['parallel'];

export function resolveStrategy(
  declared: MultiIntentStrategy,
  agentType: AgentType,
  relationship: IntentRelationshipType,
): MultiIntentStrategy {
  // Auto mode: LLM-assessed relationship determines strategy
  if (declared === 'auto') {
    return resolveAutoStrategy(agentType, relationship);
  }

  // Explicit strategy: enforce agent type restrictions
  if (SUPERVISOR_ONLY_STRATEGIES.includes(declared) && agentType !== 'supervisor') {
    log.warn('Strategy downgraded', {
      from: declared,
      to: 'sequential',
      agentType,
      reason: `${declared} is supervisor-only`,
    });
    return 'sequential';
  }

  return declared;
}

function resolveAutoStrategy(
  agentType: AgentType,
  relationship: IntentRelationshipType,
): MultiIntentStrategy {
  switch (relationship) {
    case 'independent':
      if (agentType === 'supervisor') return 'parallel';
      log.debug('Auto strategy downgraded parallel → sequential', { agentType });
      return 'sequential';

    case 'dependent':
      return 'sequential';

    case 'ambiguous':
      return 'disambiguate';

    default:
      return 'disambiguate';
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/multi-intent-strategy.test.ts
```

Expected: All PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/multi-intent-strategy.ts apps/runtime/src/__tests__/multi-intent-strategy.test.ts
git commit -m "[ABLP-2] feat(runtime): add multi-intent strategy resolver with agent type restrictions"
```

---

## Task 7: Wire multi-intent dispatch into routing executor

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Step 1: Add multi-intent dispatch to routing executor**

In `routing-executor.ts`, add a new method `handleMultiIntent()` that:

1. Receives the `MultiIntentResult` from detection
2. Resolves the strategy via `resolveStrategy()`
3. Dispatches based on strategy:
   - `primary_queue`: Route primary intent normally, enqueue alternatives
   - `sequential`: Create ordered plan, execute intents one-by-one
   - `parallel`: Build fan-out tasks, call existing `handleFanOut()`
   - `disambiguate`: Generate disambiguation prompt, wait for user choice
   - `auto`: Resolved in step 2 — never reaches dispatch directly

```typescript
async handleMultiIntent(
  session: RuntimeSession,
  multiResult: MultiIntentResult,
  agentIR: AgentIR,
): Promise<ExecutionResult> {
  const config = agentIR.intent_handling?.multi_intent;
  const agentType = agentIR.execution.mode === 'supervisor' ? 'supervisor'
    : agentIR.execution.mode === 'scripted' ? 'scripted' : 'reasoning';

  const strategy = resolveStrategy(
    config?.strategy ?? 'primary_queue',
    agentType,
    multiResult.relationships.type,
  );

  // Emit trace event
  this.emitTrace({
    type: 'decision',
    data: {
      decision: 'multi_intent_strategy',
      strategy,
      intents: [multiResult.primary, ...multiResult.alternatives],
      relationships: multiResult.relationships,
      agentType,
    },
  });

  switch (strategy) {
    case 'primary_queue':
      return this.handlePrimaryQueue(session, multiResult);
    case 'sequential':
      return this.handleSequentialIntents(session, multiResult, agentIR);
    case 'parallel':
      return this.handleParallelIntents(session, multiResult, agentIR);
    case 'disambiguate':
      return this.handleDisambiguate(session, multiResult);
    default:
      return this.handlePrimaryQueue(session, multiResult);
  }
}
```

**Step 2: Implement each strategy handler**

`handlePrimaryQueue`: Route primary intent as normal, call `enqueueIntents()` for alternatives. After primary flow completes, check queue and prompt user.

`handleSequentialIntents`: Create an execution plan `[intent1, intent2, ...]`, execute first, on completion automatically trigger next.

`handleParallelIntents`: Build fan-out task array from alternatives, call existing `handleFanOut()`.

`handleDisambiguate`: Generate a message listing detected intents, add to response, wait for user choice.

**Step 3: Wire into flow-step-executor**

In `flow-step-executor.ts`, after intent detection (in the ON_INPUT section and digression section), check if multi-intent is enabled and alternatives exist. If so, call `routingExecutor.handleMultiIntent()`.

**Step 4: Build and test**

```bash
pnpm --filter @agent-platform/runtime build && pnpm --filter @agent-platform/runtime test
```

Expected: All PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire multi-intent strategy dispatch into routing executor"
```

---

## Task 8: Add post-completion intent queue surfacing

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Step 1: After primary flow completes, check intent queue**

Find the section where a flow completes (step transitions to completion/end). Add:

```typescript
// After primary flow completes, check intent queue
if (session.intentQueue?.pending?.length) {
  pruneExpired(session.intentQueue, config?.queue_max_age_ms ?? 600_000);

  const next = peekNext(session.intentQueue);
  if (next) {
    // Append prompt to response
    const surfaceMessage = `You also mentioned wanting to ${next.intent.replace(/_/g, ' ')}. Shall I help with that?`;
    // Add to execution result as a follow-up prompt
    result.messages.push({ role: 'assistant', content: surfaceMessage });
    result.waitingForInput = true;
  }
}
```

**Step 2: Handle user response to queued intent**

When user responds "yes" to the surfaced intent, dequeue it and route to the appropriate flow/agent.

**Step 3: Build and test**

```bash
pnpm --filter @agent-platform/runtime build && pnpm --filter @agent-platform/runtime test
```

Expected: All PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): add post-completion intent queue surfacing"
```

---

## Task 9: Write comprehensive multi-intent integration tests

**Files:**

- Create: `apps/runtime/src/__tests__/multi-intent-integration.test.ts`

**Step 1: Write tests**

```typescript
// apps/runtime/src/__tests__/multi-intent-integration.test.ts
import { describe, it, expect } from 'vitest';
import { resolveStrategy } from '../services/execution/multi-intent-strategy.js';
import {
  createIntentQueue,
  enqueueIntents,
  dequeueNext,
  pruneExpired,
} from '../services/execution/intent-queue.js';
import type { MultiIntentResult } from '@abl/compiler/platform/nlu/types.js';

describe('Multi-Intent Integration', () => {
  describe('end-to-end: detection → strategy → queue', () => {
    it('primary_queue: primary routed, alternatives queued', () => {
      const result: MultiIntentResult = {
        primary: { intent: 'book_hotel', confidence: 0.92, source: 'fast' },
        alternatives: [{ intent: 'rent_car', confidence: 0.85, source: 'fast' }],
        relationships: { type: 'independent', reasoning: '' },
      };

      const strategy = resolveStrategy('primary_queue', 'scripted', result.relationships.type);
      expect(strategy).toBe('primary_queue');

      // Queue alternatives
      const queue = createIntentQueue();
      enqueueIntents(
        queue,
        result.alternatives.map((a) => ({
          intent: a.intent!,
          confidence: a.confidence,
          original_message: 'Book a hotel and rent a car',
        })),
      );

      expect(queue.pending).toHaveLength(1);
      expect(queue.pending[0].intent).toBe('rent_car');
    });

    it('auto + supervisor + independent → parallel', () => {
      const strategy = resolveStrategy('auto', 'supervisor', 'independent');
      expect(strategy).toBe('parallel');
    });

    it('auto + scripted + independent → sequential (downgraded)', () => {
      const strategy = resolveStrategy('auto', 'scripted', 'independent');
      expect(strategy).toBe('sequential');
    });

    it('queue expires old intents', () => {
      const queue = createIntentQueue();
      queue.pending = [
        {
          intent: 'stale',
          confidence: 0.8,
          original_message: '',
          detected_at: new Date(Date.now() - 700_000).toISOString(),
        },
        {
          intent: 'fresh',
          confidence: 0.8,
          original_message: '',
          detected_at: new Date().toISOString(),
        },
      ];

      pruneExpired(queue, 600_000);
      expect(queue.pending).toHaveLength(1);
      expect(queue.pending[0].intent).toBe('fresh');
    });

    it('single intent: no alternatives, no queue', () => {
      const result: MultiIntentResult = {
        primary: { intent: 'book_hotel', confidence: 0.92, source: 'fast' },
        alternatives: [],
        relationships: { type: 'ambiguous', reasoning: '' },
      };

      // No alternatives to queue
      const queue = createIntentQueue();
      enqueueIntents(queue, []);
      expect(queue.pending).toHaveLength(0);
    });
  });

  describe('strategy restriction enforcement', () => {
    it('parallel blocked for scripted agents', () => {
      expect(resolveStrategy('parallel', 'scripted', 'independent')).toBe('sequential');
    });

    it('parallel blocked for reasoning agents', () => {
      expect(resolveStrategy('parallel', 'reasoning', 'independent')).toBe('sequential');
    });

    it('parallel allowed for supervisor agents', () => {
      expect(resolveStrategy('parallel', 'supervisor', 'independent')).toBe('parallel');
    });

    it('all strategies allowed for all types except parallel', () => {
      const types: Array<'scripted' | 'reasoning' | 'supervisor'> = [
        'scripted',
        'reasoning',
        'supervisor',
      ];
      const safeStrategies: Array<'sequential' | 'primary_queue' | 'disambiguate'> = [
        'sequential',
        'primary_queue',
        'disambiguate',
      ];

      for (const t of types) {
        for (const s of safeStrategies) {
          expect(resolveStrategy(s, t, 'independent')).toBe(s);
        }
      }
    });
  });
});
```

**Step 2: Run tests**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/multi-intent-integration.test.ts
```

Expected: All PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/multi-intent-integration.test.ts
git commit -m "[ABLP-2] test(runtime): add multi-intent integration tests"
```

---

## Review Pass 1 — Addendum Tasks

The following tasks were identified as missing during completeness review.

---

## Task 10: Add MULTI_INTENT DSL parser support

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts`
- Modify: `packages/core/src/types/agent-based.ts`
- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/core/src/__tests__/parser/multi-intent-parse.test.ts`

**Step 1: Add MultiIntentConfig to parser types**

In `packages/core/src/types/agent-based.ts`, add after the `NLUDefinition` interface (around line 1066):

```typescript
/** Multi-intent configuration (parsed from MULTI_INTENT: section) */
export interface MultiIntentConfig {
  strategy?: string; // 'sequential' | 'parallel' | 'primary_queue' | 'disambiguate' | 'auto'
  max_intents?: number; // default: 3
  confidence_threshold?: number; // default: 0.6
  queue_max_age_ms?: number; // default: 600000
  enabled?: boolean; // default: true
}
```

Add to `AgentBasedDocument`:

```typescript
multiIntent?: MultiIntentConfig;
```

**Step 2: Add MULTI_INTENT section to parser**

In `packages/core/src/parser/agent-based-parser.ts`, in the section dispatch block (around lines 250-380), add a new case:

```typescript
} else if (line === 'MULTI_INTENT:') {
  doc.multiIntent = parseMultiIntentSection(state);
```

Add the parser function:

```typescript
function parseMultiIntentSection(state: ParserState): MultiIntentConfig {
  state.currentLine++; // skip "MULTI_INTENT:" header
  const config: MultiIntentConfig = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine].trim();
    if (!line || isTopLevelSection(line)) break;

    const propMatch = line.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key) {
        case 'strategy':
          config.strategy = value;
          break;
        case 'max_intents':
          config.max_intents = parseInt(value, 10);
          break;
        case 'confidence_threshold':
          config.confidence_threshold = parseFloat(value);
          break;
        case 'queue_max_age_ms':
          config.queue_max_age_ms = parseInt(value, 10);
          break;
        case 'enabled':
          config.enabled = value === 'true';
          break;
      }
    }
    state.currentLine++;
  }

  return config;
}
```

Also add `'MULTI_INTENT:'` to the `topLevelSections` set (around line 379) so other section parsers know to stop.

**Step 3: Wire into compiler**

In `packages/compiler/src/platform/ir/compiler.ts`, in `compileAgentToIR` (around line 407), after the NLU compilation (line 478), add:

```typescript
// Multi-intent config → AgentIR.intent_handling
if (doc.multiIntent) {
  agentIR.intent_handling = {
    multi_intent: {
      enabled: doc.multiIntent.enabled ?? true,
      strategy: (doc.multiIntent.strategy ?? 'primary_queue') as MultiIntentStrategy,
      max_intents: doc.multiIntent.max_intents ?? 3,
      confidence_threshold: doc.multiIntent.confidence_threshold ?? 0.6,
      queue_max_age_ms: doc.multiIntent.queue_max_age_ms ?? 600_000,
    },
  };
}
```

**Step 4: Write tests**

```typescript
// packages/core/src/__tests__/parser/multi-intent-parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../../parser/agent-based-parser.js';

describe('MULTI_INTENT parsing', () => {
  it('parses MULTI_INTENT section with all fields', () => {
    const dsl = `AGENT booking_assistant:
  GOAL: Help with bookings
  MODE: reasoning
  MULTI_INTENT:
    strategy: auto
    max_intents: 5
    confidence_threshold: 0.7
    enabled: true`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent).toBeDefined();
    expect(result.document?.multiIntent?.strategy).toBe('auto');
    expect(result.document?.multiIntent?.max_intents).toBe(5);
    expect(result.document?.multiIntent?.confidence_threshold).toBe(0.7);
    expect(result.document?.multiIntent?.enabled).toBe(true);
  });

  it('parses MULTI_INTENT with minimal config', () => {
    const dsl = `AGENT test:
  GOAL: Test
  MODE: reasoning
  MULTI_INTENT:
    strategy: primary_queue`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent?.strategy).toBe('primary_queue');
    expect(result.document?.multiIntent?.max_intents).toBeUndefined();
  });

  it('handles missing MULTI_INTENT section gracefully', () => {
    const dsl = `AGENT test:
  GOAL: Test
  MODE: reasoning`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document?.multiIntent).toBeUndefined();
  });
});
```

**Step 5: Build and test**

```bash
pnpm --filter @abl/core build && pnpm --filter @abl/core test
pnpm --filter @agent-platform/compiler build && pnpm --filter @agent-platform/compiler test
```

Expected: All PASS

**Step 6: Commit**

```bash
git add packages/core/src/parser/agent-based-parser.ts packages/core/src/types/agent-based.ts packages/compiler/src/platform/ir/compiler.ts packages/core/src/__tests__/parser/multi-intent-parse.test.ts
git commit -m "[ABLP-2] feat(core): add MULTI_INTENT DSL parser and compiler wiring"
```

---

## Task 11: Add intentQueue field to RuntimeSession

**Files:**

- Modify: `apps/runtime/src/services/execution/types.ts`

**Step 1: Add intentQueue field**

In `apps/runtime/src/services/execution/types.ts`, add import:

```typescript
import type { IntentQueue } from './intent-queue.js';
```

In the `AgentThread` interface (around line 40), add:

```typescript
  /** Queued secondary intents for multi-intent primary_queue strategy */
  intentQueue?: IntentQueue;
```

Or if `intentQueue` lives on the session level rather than the thread level, add to the `RuntimeSession` interface instead (check which makes more sense for cross-step persistence).

**Step 2: Build**

```bash
pnpm --filter @agent-platform/runtime build
```

Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add apps/runtime/src/services/execution/types.ts
git commit -m "[ABLP-2] feat(runtime): add intentQueue field to session types"
```

---

## Notes

- **Task 3 tests** operate on raw JSON (not the actual module). During execution, add a test that imports `parseIntentResponse` from the actual `intent-detector.ts` module and exercises it.
- **Task 7 handler implementations** (`handlePrimaryQueue`, `handleSequentialIntents`, `handleParallelIntents`, `handleDisambiguate`) are described as prose. During execution, the implementer should write these as full methods with dedicated unit tests before the integration test (Task 9).
- **Design doc Rules 1-3** (ON_INPUT priority, supervisor-only routing, reasoning agent tool chaining) should be covered by integration tests during execution if not added here.
- **Inline string in Task 8** ("You also mentioned wanting to...") should be moved to a platform constants module per CLAUDE.md rules.

---

## Review Corrections (from Review Pass 2 & 3)

### CRITICAL — Task 3: Tests must exercise `parseIntentResponse`, not raw JSON

Task 3 tests currently `JSON.parse()` raw strings instead of calling the actual `parseIntentResponse` function. The implementer MUST replace these tests with ones that:

1. Import `parseIntentResponse` from `intent-detector.ts`
2. Call it with mock LLM JSON output
3. Assert the returned `MultiIntentResult` object

Example fix for the first test:

```typescript
it('parses multi-intent JSON response', () => {
  const json = {
    intents: [
      { intent: 'book_hotel', confidence: 0.92 },
      { intent: 'rent_car', confidence: 0.85 },
    ],
    relationships: { type: 'independent', reasoning: 'Both are travel tasks' },
  };

  const result = parseIntentResponse(json, 3, 0.6);
  expect(result.primary.intent).toBe('book_hotel');
  expect(result.alternatives).toHaveLength(1);
  expect(result.relationships.type).toBe('independent');
});
```

### CRITICAL — Tasks 7 & 8: Must have unit tests for new methods

Tasks 7 and 8 introduce 5 new methods in routing-executor (`handleMultiIntent`, `handlePrimaryQueue`, `handleSequentialIntents`, `handleParallelIntents`, `handleDisambiguate`) plus the queue surfacing logic. These are untested. The implementer MUST create:

- `apps/runtime/src/__tests__/routing-executor-multi-intent.test.ts` with tests for each strategy handler
- Each handler test should verify: trace event emission, correct delegation, error handling
- `handlePrimaryQueue` test must verify: primary routes normally, alternatives enqueued
- `handleDisambiguate` test must verify: disambiguation message generated, user choice awaited

### IMPORTANT — Multi-intent config resolution order

Phase 2 adds `intent_handling.multi_intent` on AgentIR (from DSL `MULTI_INTENT:` section). Phase 1 adds `project_runtime_config.multi_intent` (from ProjectRuntimeConfig DB model). Both can exist simultaneously. Use this resolution order at runtime:

```typescript
const multiIntentConfig =
  agentIR.intent_handling?.multi_intent ?? // agent-level (from DSL MULTI_INTENT: section)
  agentIR.project_runtime_config?.multi_intent ?? // project-level (from DB)
  PLATFORM_DEFAULTS.multi_intent; // platform fallback
```

### IMPORTANT — Task 10 parser line numbers

Task 10 references "section dispatch block (around lines 250-380)" but the actual `topLevelSections` array in `packages/core/src/parser/agent-based-parser.ts` is at line 2002, with section dispatch at line 2027. The implementer must use the actual line numbers.

### MINOR — Task 8 inline string extraction

The surface message in Task 8 (`"You also mentioned wanting to ${next.intent}..."`) must be extracted to a platform constants module. Do not inline it in flow-step-executor. Example location: `packages/compiler/src/platform/constants/messages.ts`.
