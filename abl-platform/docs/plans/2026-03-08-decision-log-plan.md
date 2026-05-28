# Decision Log Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-session Decision Log that captures causal reasoning at 11 runtime decision points, gated by trace verbosity, and consolidate Observatory UI from 10 tabs to 5.

**Architecture:** Single `appendDecision()` function called at 11 sites in the runtime. Decision log lives on the session object (in-memory), persisted to MongoDB on session save. Studio Observatory tabs consolidated from 10 to 5, with a new DecisionTreeView component rendering the causal tree.

**Tech Stack:** TypeScript, Vitest, React, Zustand, Framer Motion, Lucide icons

---

## Part 1: Runtime — Decision Log

### Task 1: Add DecisionEntry types and decisionLog field to RuntimeSession

**Files:**

- Modify: `apps/runtime/src/services/execution/types.ts:66-180`

**Step 1: Add DecisionEntry types after SessionDataStore (around line 35)**

Add these types after the `SessionDataStore` interface:

```typescript
/**
 * A single decision log entry — captures WHY a runtime decision was made.
 * Emitted only when session.traceVerbosity >= 'verbose'.
 */
export interface DecisionEntry {
  turn: number;
  timestamp: number;
  type: DecisionType;
  outcome: string;
  condition?: string;
  matched: boolean;
  trigger?: Record<string, unknown>;
  candidates?: string[];
  selectedReason?: string;
  field?: string;
  violation?: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: string;
}

export type DecisionType =
  | 'handoff'
  | 'flow_transition'
  | 'constraint_check'
  | 'completion'
  | 'escalation'
  | 'delegation'
  | 'gather_extraction'
  | 'field_validation'
  | 'guardrail_check'
  | 'correction'
  | 'data_mutation';
```

**Step 2: Add decisionLog field to RuntimeSession (after traceVerbosity, around line 162)**

```typescript
  /** Decision log — causal chain of runtime decisions, gated by traceVerbosity */
  decisionLog?: DecisionEntry[];
```

**Step 3: Run type check**

Run: `cd apps/runtime && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/types.ts
git commit -m "[ABLP-2] feat(runtime): add DecisionEntry types and decisionLog field to RuntimeSession"
```

---

### Task 2: Create appendDecision() helper with verbosity gating

**Files:**

- Create: `apps/runtime/src/services/execution/decision-log.ts`
- Test: `apps/runtime/src/__tests__/decision-log.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/decision-log.test.ts
import { describe, test, expect } from 'vitest';
import { appendDecision, shouldLogDecisions } from '../services/execution/decision-log';
import { createBaseSession } from './pre-refactor/helpers/test-session-factory';

describe('shouldLogDecisions', () => {
  test('returns false for undefined verbosity', () => {
    expect(shouldLogDecisions(undefined)).toBe(false);
  });

  test('returns false for minimal', () => {
    expect(shouldLogDecisions('minimal')).toBe(false);
  });

  test('returns false for standard', () => {
    expect(shouldLogDecisions('standard')).toBe(false);
  });

  test('returns true for verbose', () => {
    expect(shouldLogDecisions('verbose')).toBe(true);
  });

  test('returns true for debug', () => {
    expect(shouldLogDecisions('debug')).toBe(true);
  });
});

describe('appendDecision', () => {
  test('does nothing when verbosity is standard', () => {
    const session = createBaseSession({ traceVerbosity: 'standard' });
    appendDecision(session, {
      type: 'handoff',
      outcome: 'Billing',
      matched: true,
    });
    expect(session.decisionLog).toBeUndefined();
  });

  test('appends entry when verbosity is verbose', () => {
    const session = createBaseSession({
      traceVerbosity: 'verbose',
      conversationHistory: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'book a flight' },
      ],
    });

    appendDecision(session, {
      type: 'handoff',
      outcome: 'Booking_Agent',
      matched: true,
      condition: "intent == 'booking'",
      candidates: ['Booking_Agent', 'Support_Agent'],
      trigger: { intent: 'booking' },
    });

    expect(session.decisionLog).toHaveLength(1);
    expect(session.decisionLog![0].turn).toBe(2);
    expect(session.decisionLog![0].type).toBe('handoff');
    expect(session.decisionLog![0].outcome).toBe('Booking_Agent');
    expect(session.decisionLog![0].timestamp).toBeGreaterThan(0);
  });

  test('appends multiple entries', () => {
    const session = createBaseSession({ traceVerbosity: 'debug' });

    appendDecision(session, {
      type: 'gather_extraction',
      outcome: 'destination=Paris',
      matched: true,
    });
    appendDecision(session, {
      type: 'field_validation',
      outcome: 'pass',
      matched: true,
      field: 'destination',
    });

    expect(session.decisionLog).toHaveLength(2);
  });

  test('includes data_mutation with old/new values', () => {
    const session = createBaseSession({ traceVerbosity: 'verbose' });

    appendDecision(session, {
      type: 'data_mutation',
      outcome: 'set',
      matched: true,
      field: 'priority',
      oldValue: undefined,
      newValue: 'high',
      source: 'lifecycle_hook:before_turn',
    });

    expect(session.decisionLog![0].field).toBe('priority');
    expect(session.decisionLog![0].oldValue).toBeUndefined();
    expect(session.decisionLog![0].newValue).toBe('high');
    expect(session.decisionLog![0].source).toBe('lifecycle_hook:before_turn');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run --reporter=verbose decision-log 2>&1 | tail -20`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// apps/runtime/src/services/execution/decision-log.ts
import type { RuntimeSession, DecisionEntry, DecisionType } from './types.js';

/**
 * Whether the current verbosity level enables decision logging.
 * Only 'verbose' and 'debug' produce decision log entries.
 */
export function shouldLogDecisions(verbosity: RuntimeSession['traceVerbosity']): boolean {
  return verbosity === 'verbose' || verbosity === 'debug';
}

/**
 * Append a decision entry to the session's decision log.
 * No-op if traceVerbosity < 'verbose'. Zero-cost in production.
 */
export function appendDecision(
  session: RuntimeSession,
  entry: Omit<DecisionEntry, 'turn' | 'timestamp'>,
): void {
  if (!shouldLogDecisions(session.traceVerbosity)) return;

  session.decisionLog ??= [];
  session.decisionLog.push({
    ...entry,
    turn: session.conversationHistory.filter((m) => m.role === 'user').length,
    timestamp: Date.now(),
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run --reporter=verbose decision-log 2>&1 | tail -20`
Expected: All tests pass

**Step 5: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/decision-log.ts apps/runtime/src/__tests__/decision-log.test.ts
git add apps/runtime/src/services/execution/decision-log.ts apps/runtime/src/__tests__/decision-log.test.ts
git commit -m "[ABLP-2] feat(runtime): add appendDecision() helper with verbosity gating"
```

---

### Task 3: Wire decision log at handoff evaluation

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:2429-2473`

**Step 1: Add import at top of routing-executor.ts**

```typescript
import { appendDecision } from './decision-log.js';
```

**Step 2: Add decision log entry inside the handoff condition loop**

In `checkHandoffConditions()` around line 2432-2444, after the condition is evaluated and before/after the trace event, add:

```typescript
// Inside the for loop, after condition evaluation:
appendDecision(session, {
  type: 'handoff',
  outcome: matches ? handoff.to : `skip:${handoff.to}`,
  condition: handoff.when ?? 'always',
  matched: matches,
  candidates: handoffs.map((h: any) => h.to),
  selectedReason: matches ? 'first_match' : undefined,
  trigger: handoff.when
    ? Object.fromEntries(
        Object.entries(session.data.values).filter(([k]) => handoff.when?.includes(k)),
      )
    : undefined,
});
```

Note: Emit one entry per candidate evaluated (not just the winner). This shows the full evaluation chain.

**Step 3: Run relevant tests**

Run: `cd apps/runtime && npx vitest run --reporter=verbose flow-handoff-threads 2>&1 | tail -20`
Expected: All 7 tests pass (decision log is not emitted at standard verbosity)

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/routing-executor.ts
git add apps/runtime/src/services/execution/routing-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire decision log at handoff condition evaluation"
```

---

### Task 4: Wire decision log at completion detection

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:2314-2352`

**Step 1: Add decision log entry in completion check loop**

In `checkAndMarkComplete()`, after the condition evaluation around line 2315-2327:

```typescript
appendDecision(session, {
  type: 'completion',
  outcome: isComplete ? 'complete' : 'not_complete',
  condition: condition.when,
  matched: isComplete,
  trigger: condition.when
    ? Object.fromEntries(Object.entries(context).filter(([k]) => condition.when?.includes(k)))
    : undefined,
});
```

**Step 2: Run tests and commit**

Run: `cd apps/runtime && npx vitest run --reporter=verbose reasoning-gather-handoff 2>&1 | tail -10`
Expected: All 60 pass

```bash
npx prettier --write apps/runtime/src/services/execution/routing-executor.ts
git add apps/runtime/src/services/execution/routing-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire decision log at completion detection"
```

---

### Task 5: Wire decision log at escalation, delegation

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:1412-1472` (escalation)
- Modify: `apps/runtime/src/services/execution/routing-executor.ts:1059-1080` (delegation)

**Step 1: Add escalation decision log entry**

In `handleEscalate()` around line 1449 (after `session.isEscalated = true`):

```typescript
appendDecision(session, {
  type: 'escalation',
  outcome: input.reason ?? 'unknown',
  matched: true,
  trigger: { priority: input.priority ?? 'medium', reason: input.reason },
});
```

**Step 2: Add delegation decision log entry**

In `handleDelegate()` / `executeDelegate()` around line 1061 (after WHEN condition evaluated):

```typescript
appendDecision(session, {
  type: 'delegation',
  outcome: matches ? delegateConfig.agent : `skip:${delegateConfig.agent}`,
  condition: delegateConfig.when ?? 'always',
  matched: matches,
  trigger: delegateConfig.when
    ? Object.fromEntries(Object.entries(evalCtx).filter(([k]) => delegateConfig.when?.includes(k)))
    : undefined,
});
```

**Step 3: Run tests and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/routing-executor.ts
git add apps/runtime/src/services/execution/routing-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire decision log at escalation and delegation"
```

---

### Task 6: Wire decision log at constraint check

**Files:**

- Modify: `apps/runtime/src/services/execution/constraint-checker.ts:64-99`

**Step 1: Add import**

```typescript
import { appendDecision } from './decision-log.js';
```

**Step 2: Add decision log entry after constraint evaluation**

In `checkFlatConstraints()` or `checkConstraints()`, after each constraint is evaluated (around lines 79-96):

```typescript
appendDecision(session, {
  type: 'constraint_check',
  outcome: info.passed ? 'pass' : (info.action ?? 'fail'),
  condition: info.condition,
  matched: info.passed,
  field: info.field,
  violation: info.passed ? undefined : info.severity,
});
```

Note: The constraint checker may not have a direct `session` reference — it may work with context objects. Check the function signature and pass session through if needed, or accept the evaluation context.

**Step 3: Run tests and commit**

Run: `cd apps/runtime && npx vitest run --reporter=verbose constraint-checker 2>&1 | tail -10`

```bash
npx prettier --write apps/runtime/src/services/execution/constraint-checker.ts
git add apps/runtime/src/services/execution/constraint-checker.ts
git commit -m "[ABLP-2] feat(runtime): wire decision log at constraint evaluation"
```

---

### Task 7: Wire decision log at flow transitions, gather extraction, field validation, correction

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

This is the largest file (4,105 LOC) with 5 emission points. All use the same pattern.

**Step 1: Add import at top**

```typescript
import { appendDecision } from './decision-log.js';
```

**Step 2: Flow transition (ON_INPUT branching, around lines 2883/3723)**

After `evaluateOnInput()` returns a matched branch:

```typescript
appendDecision(session, {
  type: 'flow_transition',
  outcome: matchedBranch.then ?? 'continue',
  condition: matchedBranch.when ?? 'else',
  matched: true,
  trigger: { input: currentMessage?.substring(0, 100) },
});
```

**Step 3: Gather extraction (strategy selection, around line 1198)**

After extraction strategy is resolved:

```typescript
appendDecision(session, {
  type: 'gather_extraction',
  outcome: Object.entries(result)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ')
    .substring(0, 200),
  matched: Object.keys(result).length > 0,
  trigger: { strategy: resolvedStrategy, fieldsRequested: fields },
});
```

**Step 4: Field validation (around line 1645-1720)**

After `validateField()` returns:

```typescript
appendDecision(session, {
  type: 'field_validation',
  outcome: validationError ? 'fail' : 'pass',
  matched: !validationError,
  field: gf.name,
  violation: validationError ?? undefined,
  trigger: { value: result[gf.name], rule: gf.validation?.type },
});
```

**Step 5: Correction detection (around line 2725)**

After correction is detected and applied:

```typescript
appendDecision(session, {
  type: 'correction',
  outcome: correctionField,
  matched: true,
  field: correctionField,
  oldValue: session.data.values[correctionField],
  newValue: correctionNewValue,
  source: correctionDetectionMethod,
});
```

**Step 6: Run tests and commit**

Run: `cd apps/runtime && npx vitest run --reporter=verbose reasoning-gather-handoff 2>&1 | tail -10`
Run: `cd apps/runtime && npx vitest run --reporter=verbose flow-handoff-threads 2>&1 | tail -10`

```bash
npx prettier --write apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire decision log at flow transitions, gather, validation, correction"
```

---

### Task 8: Wire decision log at guardrail evaluation and data mutations

**Files:**

- Modify: `apps/runtime/src/services/execution/output-guardrails.ts:59-87`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts` (SET/CALL mutations)

**Step 1: Guardrail evaluation**

In `checkOutputGuardrails()` after pipeline.execute returns:

```typescript
import { appendDecision } from './decision-log.js';

// After result = pipeline.execute(...)
if (session) {
  appendDecision(session, {
    type: 'guardrail_check',
    outcome: result.passed ? 'pass' : (result.primaryViolation?.action ?? 'block'),
    matched: !result.passed,
    trigger: result.primaryViolation
      ? { guardrail: result.primaryViolation.name, tier: result.primaryViolation.tier }
      : undefined,
  });
}
```

**Step 2: Data mutation via SET commands**

In `applySetValue()` (flow-step-executor.ts around line 117) or wherever SET is applied:

```typescript
appendDecision(session, {
  type: 'data_mutation',
  outcome: 'set',
  matched: true,
  field: key,
  oldValue: session.data.values[key],
  newValue: value,
  source: `set:${session.currentFlowStep ?? 'unknown'}`,
});
```

**Step 3: Data mutation via CALL results**

At lines 3677/3685 where `session.data.values[step.call_as] = callResult`:

```typescript
appendDecision(session, {
  type: 'data_mutation',
  outcome: 'call_result',
  matched: true,
  field: step.call_as,
  oldValue: session.data.values[step.call_as],
  newValue: callResult,
  source: `call:${step.call ?? 'unknown'}`,
});
```

**Step 4: Data mutation via lifecycle hooks**

At lines 863/865 where ON_START stores CALL results:

```typescript
appendDecision(session, {
  type: 'data_mutation',
  outcome: 'lifecycle',
  matched: true,
  field: key,
  oldValue: session.data.values[key],
  newValue: toolResult,
  source: 'lifecycle_hook:on_start',
});
```

**Step 5: Run tests and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/output-guardrails.ts apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/output-guardrails.ts apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire decision log at guardrails and data mutations"
```

---

### Task 9: Add decision log to MongoDB session persistence

**Files:**

- Modify: `apps/runtime/src/services/session/session-state-repo.ts:86-109`

**Step 1: Add decisionLog to the session document**

In the `upsert()` method, add `decisionLog` to the document being persisted (around line 109):

```typescript
decisionLog: session.decisionLog ?? [],
```

**Step 2: Add decisionLog to the session restore path**

In the restore/load method, ensure `decisionLog` is read back:

```typescript
session.decisionLog = doc.decisionLog ?? [];
```

**Step 3: Add MongoDB index**

Create or update the migration/index setup to add:

```typescript
{ projectId: 1, 'decisionLog.type': 1, updatedAt: -1 }
```

**Step 4: Run tests and commit**

```bash
npx prettier --write apps/runtime/src/services/session/session-state-repo.ts
git add apps/runtime/src/services/session/session-state-repo.ts
git commit -m "[ABLP-2] feat(runtime): persist decision log to MongoDB session document"
```

---

### Task 10: Integration test — full decision log capture

**Files:**

- Create: `apps/runtime/src/__tests__/decision-log-integration.test.ts`

**Step 1: Write integration test**

Test that a full execution with `traceVerbosity: 'debug'` produces the expected decision log entries:

```typescript
import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';
import {
  ValidatingMockAnthropicClient,
  injectValidatingMockClient,
} from './helpers/history-validation';
import { loadFixture } from './fixtures';

describe('Decision Log Integration', () => {
  let executor: RuntimeExecutor;
  let mockClient: ValidatingMockAnthropicClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectValidatingMockClient(executor);
  });

  test('captures gather_extraction entries for reasoning agent', async () => {
    const dsl = loadFixture('reasoning-gather');
    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'Sales_Chat'));
    // Enable decision logging
    session.traceVerbosity = 'debug';

    await executor.initializeSession(session.id);

    mockClient.setEntityExtractionResponse({ destination: 'Paris' });
    await executor.executeMessage(session.id, 'I want to go to Paris');

    const log = session.decisionLog ?? [];
    const gatherEntries = log.filter((e) => e.type === 'gather_extraction');
    expect(gatherEntries.length).toBeGreaterThanOrEqual(1);
    expect(gatherEntries[0].outcome).toContain('Paris');
  });

  test('captures no entries when verbosity is standard', async () => {
    const dsl = loadFixture('reasoning-gather');
    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'Sales_Chat'));
    // Default verbosity — no decision log
    session.traceVerbosity = 'standard';

    await executor.initializeSession(session.id);

    mockClient.setEntityExtractionResponse({ destination: 'Paris' });
    await executor.executeMessage(session.id, 'I want to go to Paris');

    expect(session.decisionLog).toBeUndefined();
  });

  test('captures handoff entries for supervisor', async () => {
    const supervisorDsl = loadFixture('supervisor-handoff');
    const salesDsl = loadFixture('reasoning-sales');

    executor.registerAgent('Sales_Agent', salesDsl);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl], 'Travel_Supervisor'),
    );
    session.traceVerbosity = 'debug';

    await executor.initializeSession(session.id);

    mockClient.setResponseHandler((sys, msgs, tools, opType) => {
      if (opType === 'extraction') {
        return {
          text: JSON.stringify({ intent: { category: 'travel_search' } }),
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: '{}' }],
        };
      }
      return {
        text: 'Let me connect you.',
        toolCalls: [
          { id: 'h1', name: '__handoff__', input: { target: 'Sales_Agent', context: {} } },
        ],
        stopReason: 'tool_use',
        rawContent: [
          { type: 'text', text: 'Let me connect you.' },
          {
            type: 'tool_use',
            id: 'h1',
            name: '__handoff__',
            input: { target: 'Sales_Agent', context: {} },
          },
        ],
      };
    });

    await executor.executeMessage(session.id, 'I want to search for flights');

    const log = session.decisionLog ?? [];
    const handoffEntries = log.filter((e) => e.type === 'handoff');
    expect(handoffEntries.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run test**

Run: `cd apps/runtime && npx vitest run --reporter=verbose decision-log-integration 2>&1 | tail -30`
Expected: All tests pass

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/decision-log-integration.test.ts
git add apps/runtime/src/__tests__/decision-log-integration.test.ts
git commit -m "[ABLP-2] test(runtime): add decision log integration tests"
```

---

## Part 2: Studio — Observatory Tab Consolidation

### Task 11: Refactor DebugTabs from 10 tabs to 5

**Files:**

- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx`
- Modify: `apps/studio/src/store/observatory-store.ts` (update DebugTab type)

**Step 1: Update the DebugTab type in observatory-store.ts**

Change from:

```typescript
type DebugTab =
  | 'context'
  | 'history'
  | 'ir'
  | 'logs'
  | 'timeline'
  | 'gather'
  | 'constraints'
  | 'llm'
  | 'analysis'
  | 'test-context';
```

To:

```typescript
type DebugTab = 'decisions' | 'data' | 'conversation' | 'performance' | 'ir';
```

Update the default tab from `'timeline'` to `'decisions'`.

**Step 2: Refactor DebugTabs.tsx tab definitions**

Replace the 10-tab array with 5 tabs:

```typescript
const tabs: Array<{ id: DebugTab; label: string; icon: React.ElementType }> = useMemo(
  () => [
    { id: 'decisions', label: t('tab_decisions'), icon: GitBranch },
    { id: 'data', label: t('tab_data'), icon: Database },
    { id: 'conversation', label: t('tab_conversation'), icon: MessageSquare },
    { id: 'performance', label: t('tab_performance'), icon: Activity },
    { id: 'ir', label: t('tab_ir'), icon: Code2 },
  ],
  [t],
);
```

**Step 3: Update tab content rendering**

Replace the 10 content blocks with 5:

```tsx
{
  debugPanelTab === 'decisions' && <DecisionsTab />;
}
{
  debugPanelTab === 'data' && <DataTab />;
}
{
  debugPanelTab === 'conversation' && <HistoryTab />;
}
{
  debugPanelTab === 'performance' && <PerformanceTab />;
}
{
  debugPanelTab === 'ir' && <AgentIRTab />;
}
```

**Step 4: Create inline composite tabs**

`DataTab` = GatherProgressPanel + ContextTab (existing components composed together):

```tsx
function DataTab() {
  return (
    <div className="h-full overflow-y-auto p-3 space-y-4">
      <GatherProgressPanel />
      <ContextTab />
    </div>
  );
}
```

`PerformanceTab` = LLMCallsTab + LogsTab:

```tsx
function PerformanceTab() {
  const logs = useObservatoryStore((s) => s.logs);
  const clearLogs = useObservatoryStore((s) => s.clearLogs);
  return (
    <div className="h-full overflow-y-auto space-y-4">
      <LLMCallsTab />
      <LogsTab logs={logs} onClear={clearLogs} />
    </div>
  );
}
```

`AgentIRTab` = IRTab + TestContextPanel:

```tsx
function AgentIRTab() {
  return (
    <div className="h-full overflow-y-auto space-y-4">
      <IRTab />
      <CollapsibleSection title="Test Context" defaultOpen={false}>
        <TestContextPanel />
      </CollapsibleSection>
    </div>
  );
}
```

`DecisionsTab` = placeholder that renders "No decision log" until Task 12.

**Step 5: Add i18n keys for new tab names**

Find the observatory translations file and add:

```json
"tab_decisions": "Decisions",
"tab_conversation": "Conversation",
"tab_performance": "Performance"
```

**Step 6: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/observatory-store.ts
git add apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/observatory-store.ts
git commit -m "[ABLP-2] refactor(studio): consolidate Observatory from 10 tabs to 5"
```

---

### Task 12: Create DecisionTreeView component

**Files:**

- Create: `apps/studio/src/components/observatory/DecisionTreeView.tsx`

**Step 1: Create the component**

Renders `session.decisionLog` grouped by conversation turn as a causal tree. Uses existing Observatory design patterns (colors from event-colors.ts, animation from springs).

The component:

1. Groups DecisionEntry[] by `turn` field
2. Renders each turn as a collapsible section with the user message as header
3. Within each turn, renders entries as tree nodes with icons and color per type
4. Expanding an entry shows trigger data as JSON
5. Shows latency summary at top (collapsible) from session timeline data
6. Shows diagnostic issues inline (from analysis patterns) as warnings on relevant turns

Entry type → icon + color mapping:

- handoff → GitBranch / blue
- completion → CheckCircle / green
- escalation → AlertTriangle / orange
- delegation → Share2 / purple
- gather_extraction → Search / cyan
- field_validation → ShieldCheck / green (pass) or red (fail)
- correction → RefreshCw / amber
- data_mutation → Edit3 / gray

**Step 2: Wire into DecisionsTab in DebugTabs.tsx**

Replace the placeholder with:

```tsx
function DecisionsTab() {
  const decisionLog = useSessionStore((s) => s.decisionLog);
  const messages = useSessionStore((s) => s.messages);

  return <DecisionTreeView entries={decisionLog ?? []} messages={messages ?? []} />;
}
```

**Step 3: Add decisionLog to session store**

In `apps/studio/src/store/session-store.ts`, add `decisionLog: DecisionEntry[]` to the session state and populate it from the session API response.

**Step 4: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/components/observatory/DecisionTreeView.tsx apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/session-store.ts
git add apps/studio/src/components/observatory/DecisionTreeView.tsx apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/session-store.ts
git commit -m "[ABLP-2] feat(studio): add DecisionTreeView component for Observatory Decisions tab"
```

---

### Task 13: Final verification

**Step 1: Build everything**

Run: `pnpm build 2>&1 | tail -20`
Expected: Clean build (ignore unrelated telco-noc lock issue)

**Step 2: Run all affected runtime tests**

Run: `cd apps/runtime && npx vitest run --reporter=verbose decision-log decision-log-integration reasoning-gather-handoff flow-handoff-threads 2>&1 | tail -30`
Expected: All tests pass

**Step 3: Type-check Studio**

Run: `cd apps/studio && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 4: Final commit if fixups needed**

```bash
git commit -m "[ABLP-2] fix(shared): alignment fixes after decision log + observatory refactor"
```
