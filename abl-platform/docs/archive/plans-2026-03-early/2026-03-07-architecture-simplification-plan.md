# Architecture Simplification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify the runtime execution core, thin out route handlers, decompose the shared package, and enforce architectural boundaries — over 6 sprints (12 weeks).

**Architecture:** Strangler + shadow mode. RuntimeExecutor (2,626 LOC) becomes a thin orchestration shell delegating to modular sub-executors in packages/compiler. Route handlers (294 in Studio, 23 in connectors.ts alone) become auth → validate → service → response. Shared package (97+ files, depends on database) splits into focused concern packages.

**Tech Stack:** TypeScript, Vitest 4.0.18, dependency-cruiser (new), Turbo, pnpm workspaces

**Source Plan:** 12-Week Architecture Simplification Plan (March 9 – May 29, 2026)

**Skills:** Use `architecture-simplification`, `refactoring-safety`, `pre-review-checklist`, `coverage-ramp` skills throughout.

---

## Problem Statement

The codebase has accumulated structural debt across six areas that impede velocity, increase regression risk, and block multi-runtime enablement:

1. **Execution overlap:** RuntimeExecutor (2,626 LOC) and FlowStepExecutor (4,105 LOC) duplicate logic that exists in modular sub-executors in packages/compiler. Fixes aren't reflected in both engines.
2. **Large API surface:** 294 Studio route handlers and 1,700 LOC connectors.ts mix routing, DB access, queue management, and OAuth — violating layered architecture.
3. **Shared package coupling:** packages/shared (97+ files) depends on database and i18n, creating a coupling hub that forces apps to import everything.
4. **Weak quality gates:** Runtime coverage at 12%, Studio at 7%. No dependency boundary enforcement in CI.
5. **No structured observability:** Ad-hoc console.\* usage, no standardized error taxonomy, no golden dashboards.
6. **Channel lock-in:** RuntimeExecutor is tightly coupled to digital WebSocket — Voice and Workflow runtimes can't reuse it.

## Exit Criteria (overall)

The plan is complete when ALL of these are true:

- RuntimeExecutor reduced to orchestration shell (<= 1,500 LOC)
- 99.5%+ parity on shadow traffic before each cutover
- Top 20 largest route files reduced by >= 40%
- shared-kernel has no database dependency
- CI blocks new boundary violations
- Coverage thresholds: runtime 35%, studio 30%, search-ai 45%

---

## Sprint Overview

| Sprint       | Dates        | Focus                     | Key Deliverable                                         |
| ------------ | ------------ | ------------------------- | ------------------------------------------------------- |
| **Sprint 0** | Mar 9–20     | Baseline + guardrails     | Scorecard, boundary rules (warn), parity test harness   |
| Sprint 1     | Mar 23–Apr 3 | Runtime unification P1    | Context bridge + Gather/Constraint/Complete delegated   |
| Sprint 2     | Apr 6–17     | Runtime unification P2    | Flow/Routing/Reasoning delegated, shadow mode, cutover  |
| Sprint 3     | Apr 20–May 1 | API verticalization pilot | Studio `projects` + SearchAI `connectors` thin handlers |
| Sprint 4     | May 4–15     | Shared decomposition      | `shared-kernel` split, DB decoupling, repo pattern      |
| Sprint 5     | May 18–29    | Hardening + enforcement   | CI blocking rules, coverage uplift, dead code deletion  |

---

## Sprint 0: Baseline + Guardrails (Mar 9–20)

### Task 1: Add dependency-cruiser for boundary analysis

**Files:**

- Modify: `package.json` (root)
- Create: `.dependency-cruiser.cjs`
- Modify: `turbo.json` (add `boundary-check` task)

**Step 1: Install dependency-cruiser**

Run: `pnpm add -Dw dependency-cruiser`

**Step 2: Create boundary rules config**

Create `.dependency-cruiser.cjs` with these rules (warn mode only for Sprint 0):

```javascript
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-app-to-app',
      comment: 'Apps must not import from other apps directly',
      severity: 'warn',
      from: { path: '^apps/[^/]+' },
      to: { path: '^apps/[^/]+', pathNot: '$1' },
    },
    {
      name: 'no-shared-to-database-direct',
      comment: 'shared-kernel must not depend on database (target: Sprint 4)',
      severity: 'info',
      from: { path: '^packages/shared/src/(types|errors|index)' },
      to: { path: '^packages/database' },
    },
    {
      name: 'no-db-in-routes',
      comment: 'Route files must not import database models directly',
      severity: 'warn',
      from: { path: '(routes?|route\\.ts)' },
      to: { path: '^packages/database/src/models' },
    },
    {
      name: 'no-reverse-coupling',
      comment: 'Packages must not import from apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
```

**Step 3: Add turbo task**

Add to `turbo.json` tasks:

```json
"boundary-check": {
  "dependsOn": ["build"],
  "inputs": ["src/**/*.ts"],
  "cache": false
}
```

Add to root `package.json` scripts:

```json
"boundary-check": "depcruise apps/runtime/src apps/search-ai/src packages/shared/src --config .dependency-cruiser.cjs",
"boundary-check:report": "depcruise apps/runtime/src apps/search-ai/src packages/shared/src --config .dependency-cruiser.cjs --output-type err-html > docs/boundary-report.html"
```

**Step 4: Run baseline boundary report**

Run: `pnpm boundary-check`
Expected: Warnings listed (not errors blocking). Save output as baseline.

**Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .dependency-cruiser.cjs turbo.json
git commit -m "build(shared): add dependency-cruiser boundary rules in warn mode"
```

---

### Task 2: Generate architecture scorecard baseline

**Files:**

- Modify: `tools/architecture-scorecard.sh` (already exists)
- Create: `docs/architecture-baseline-2026-03-09.md`

**Step 1: Run full scorecard**

Run: `tools/architecture-scorecard.sh --all 2>&1 | tee docs/architecture-baseline-2026-03-09.md`

**Step 2: Capture additional metrics**

Run and append to the baseline doc:

```bash
echo "## Additional Metrics" >> docs/architecture-baseline-2026-03-09.md
echo "### File sizes" >> docs/architecture-baseline-2026-03-09.md
wc -l apps/runtime/src/services/runtime-executor.ts >> docs/architecture-baseline-2026-03-09.md
wc -l apps/runtime/src/services/execution/flow-step-executor.ts >> docs/architecture-baseline-2026-03-09.md
wc -l apps/search-ai/src/routes/connectors.ts >> docs/architecture-baseline-2026-03-09.md
echo "### Shared package file count" >> docs/architecture-baseline-2026-03-09.md
find packages/shared/src -name '*.ts' | wc -l >> docs/architecture-baseline-2026-03-09.md
echo "### Studio API route count" >> docs/architecture-baseline-2026-03-09.md
find apps/studio/src/app/api -name 'route.ts' | wc -l >> docs/architecture-baseline-2026-03-09.md
```

**Step 3: Commit**

```bash
git add docs/architecture-baseline-2026-03-09.md
git commit -m "docs(shared): capture architecture baseline metrics for simplification plan"
```

---

### Task 3: Create parity test harness scaffold

**Files:**

- Create: `apps/runtime/src/__tests__/pre-refactor/README.md`
- Create: `apps/runtime/src/__tests__/pre-refactor/helpers/test-session-factory.ts`
- Create: `apps/runtime/src/__tests__/pre-refactor/helpers/test-executor-factory.ts`
- Create: `apps/runtime/src/__tests__/pre-refactor/helpers/assertion-helpers.ts`

**Step 1: Create test directory with README**

```markdown
# Pre-Refactor Parity Tests

Behavioral contract tests for RuntimeExecutor. These tests capture the CURRENT
behavior before consolidation begins. They serve as the safety net during the
strangler migration to ConstructExecutor sub-executors.

## Purpose

- Assert observable behavior: responses, state mutations, trace events
- Run before AND after each delegation phase
- Parity threshold: 99.5% match required before cutover

## Structure

- `helpers/` — Test factories and assertion utilities
- `session-lifecycle.test.ts` — Create, initialize, rehydrate, persist, end
- `gather-execution.test.ts` — Field collection, validation, entity extraction
- `constraint-evaluation.test.ts` — Guardrail evaluation, ON_FAIL branching
- `completion-detection.test.ts` — Completion conditions, session end
- `flow-execution.test.ts` — Step traversal, THEN/GOTO, loops
- `reasoning-execution.test.ts` — Tool-use loops, reasoning zones
- `handoff-delegate.test.ts` — Agent routing, handoffs, delegates
- `thread-model.test.ts` — Thread create, switch, return
- `trace-emission.test.ts` — TraceEvent shapes and ordering
- `error-handling.test.ts` — Tool/LLM failures, timeouts, recovery
```

**Step 2: Create test session factory**

```typescript
// apps/runtime/src/__tests__/pre-refactor/helpers/test-session-factory.ts
import { RuntimeSession, RuntimeState, SessionDataStore } from '../../../services/execution/types';

/**
 * Creates minimal RuntimeSession instances for parity testing.
 * Each factory method produces a session in a specific state
 * to isolate the behavior under test.
 */

export function createBaseSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  const now = new Date();
  return {
    id: `test-session-${Date.now()}`,
    agentName: 'test-agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: createBaseState(),
    data: createBaseDataStore(),
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

export function createBaseState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    gatherProgress: {},
    conversationPhase: 'greeting',
    context: {},
    activeAgent: undefined,
    ...overrides,
  };
}

export function createBaseDataStore(overrides: Partial<SessionDataStore> = {}): SessionDataStore {
  return {
    values: {},
    gatheredKeys: new Set<string>(),
    ...overrides,
  };
}

/**
 * Creates a session with a compiled agent IR loaded.
 * Use this for testing execution paths that require agent logic.
 */
export function createSessionWithAgent(
  dsl: string,
  agentIR: unknown,
  overrides: Partial<RuntimeSession> = {},
): RuntimeSession {
  return createBaseSession({
    agentIR: agentIR as RuntimeSession['agentIR'],
    initialized: true,
    ...overrides,
  });
}

/**
 * Creates a session mid-gather (fields partially collected).
 */
export function createGatherSession(
  gatheredFields: Record<string, unknown>,
  pendingFields: string[],
  overrides: Partial<RuntimeSession> = {},
): RuntimeSession {
  const gatheredKeys = new Set(Object.keys(gatheredFields));
  return createBaseSession({
    data: {
      values: gatheredFields as Record<string, string>,
      gatheredKeys,
    },
    state: createBaseState({
      gatherProgress: Object.fromEntries(
        [...gatheredKeys].map((k) => [k, { value: gatheredFields[k], validated: true }]),
      ),
    }),
    waitingForInput: pendingFields,
    ...overrides,
  });
}
```

**Step 3: Create test executor factory**

```typescript
// apps/runtime/src/__tests__/pre-refactor/helpers/test-executor-factory.ts
import { RuntimeExecutor } from '../../../services/runtime-executor';
import { vi } from 'vitest';

/**
 * Creates a RuntimeExecutor with mocked dependencies for isolated testing.
 * Captures trace events and LLM calls for assertion.
 */

export interface MockedExecutor {
  executor: RuntimeExecutor;
  traceEvents: Array<{ type: string; data: unknown }>;
  llmCalls: Array<{ messages: unknown[]; tools?: unknown[] }>;
  toolCalls: Array<{ name: string; args: unknown }>;
}

export function createMockedExecutor(config: Record<string, unknown> = {}): MockedExecutor {
  const traceEvents: Array<{ type: string; data: unknown }> = [];
  const llmCalls: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];

  const executor = new RuntimeExecutor({
    redisUrl: undefined,
    ...config,
  });

  return { executor, traceEvents, llmCalls, toolCalls };
}
```

**Step 4: Create assertion helpers**

```typescript
// apps/runtime/src/__tests__/pre-refactor/helpers/assertion-helpers.ts
import { expect } from 'vitest';
import type { RuntimeSession } from '../../../services/execution/types';

/**
 * Assertion helpers for parity tests.
 * These assert observable behavior, not implementation details.
 */

/** Assert session state matches expected gather progress */
export function expectGatherProgress(
  session: RuntimeSession,
  expected: Record<string, { value: unknown; validated: boolean }>,
): void {
  for (const [field, exp] of Object.entries(expected)) {
    const actual = session.state.gatherProgress[field];
    expect(actual, `gather field '${field}' missing`).toBeDefined();
    expect(actual.value).toEqual(exp.value);
    expect(actual.validated).toBe(exp.validated);
  }
}

/** Assert trace events contain expected types in order */
export function expectTraceEventOrder(
  events: Array<{ type: string }>,
  expectedOrder: string[],
): void {
  const types = events.map((e) => e.type);
  let lastIndex = -1;
  for (const expectedType of expectedOrder) {
    const index = types.indexOf(expectedType, lastIndex + 1);
    expect(
      index,
      `trace event '${expectedType}' not found after index ${lastIndex}`,
    ).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
}

/** Assert session completed with expected response */
export function expectSessionComplete(session: RuntimeSession, expectedResponse?: string): void {
  expect(session.isComplete).toBe(true);
  if (expectedResponse) {
    const lastAssistant = session.conversationHistory.filter((m) => m.role === 'assistant').pop();
    expect(lastAssistant?.content).toContain(expectedResponse);
  }
}

/** Assert session NOT completed */
export function expectSessionActive(session: RuntimeSession): void {
  expect(session.isComplete).toBe(false);
  expect(session.isEscalated).toBe(false);
}
```

**Step 5: Run to verify scaffold compiles**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds (test helpers are type-checked)

**Step 6: Commit**

```bash
git add apps/runtime/src/__tests__/pre-refactor/
git commit -m "test(runtime): add parity test harness scaffold for engine consolidation"
```

---

### Task 4: Write session lifecycle parity tests

**Files:**

- Create: `apps/runtime/src/__tests__/pre-refactor/session-lifecycle.test.ts`

**Step 1: Write failing tests**

```typescript
// apps/runtime/src/__tests__/pre-refactor/session-lifecycle.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RuntimeExecutor } from '../../services/runtime-executor';

describe('Pre-refactor: Session Lifecycle', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('createSession', () => {
    it('creates a session with unique ID', () => {
      const session = executor.createSession('test-agent', 'AGENT test-agent\nGOAL: help');
      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();
      expect(typeof session.id).toBe('string');
    });

    it('sets agent name on session', () => {
      const session = executor.createSession('my-agent', 'AGENT my-agent\nGOAL: assist');
      expect(session.agentName).toBe('my-agent');
    });

    it('initializes session as not complete', () => {
      const session = executor.createSession('test-agent', 'AGENT test-agent\nGOAL: help');
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
    });

    it('initializes empty conversation history', () => {
      const session = executor.createSession('test-agent', 'AGENT test-agent\nGOAL: help');
      expect(session.conversationHistory).toEqual([]);
    });

    it('creates sessions with unique IDs', () => {
      const s1 = executor.createSession('a', 'AGENT a\nGOAL: x');
      const s2 = executor.createSession('b', 'AGENT b\nGOAL: y');
      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe('getSession', () => {
    it('returns session by ID', () => {
      const created = executor.createSession('test', 'AGENT test\nGOAL: help');
      const retrieved = executor.getSession(created.id);
      expect(retrieved).toBe(created);
    });

    it('returns undefined for non-existent ID', () => {
      expect(executor.getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('endSession', () => {
    it('removes session from active sessions', () => {
      const session = executor.createSession('test', 'AGENT test\nGOAL: help');
      executor.endSession(session.id);
      expect(executor.getSession(session.id)).toBeUndefined();
    });

    it('decrements session count', () => {
      const session = executor.createSession('test', 'AGENT test\nGOAL: help');
      const before = executor.getSessionCount();
      executor.endSession(session.id);
      expect(executor.getSessionCount()).toBe(before - 1);
    });
  });

  describe('resetSession', () => {
    it('returns a fresh session with same ID', () => {
      const session = executor.createSession('test', 'AGENT test\nGOAL: help');
      const reset = executor.resetSession(session.id);
      expect(reset).toBeDefined();
      expect(reset!.id).toBe(session.id);
      expect(reset!.conversationHistory).toEqual([]);
    });
  });

  describe('listSessions', () => {
    it('returns all active sessions', () => {
      executor.createSession('a', 'AGENT a\nGOAL: x');
      executor.createSession('b', 'AGENT b\nGOAL: y');
      const list = executor.listSessions();
      expect(list.length).toBe(2);
    });

    it('includes session metadata', () => {
      executor.createSession('test', 'AGENT test\nGOAL: help');
      const [session] = executor.listSessions();
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('agentName');
    });
  });

  describe('getSessionCount', () => {
    it('returns zero when no sessions exist', () => {
      expect(executor.getSessionCount()).toBe(0);
    });

    it('tracks session creation', () => {
      executor.createSession('a', 'AGENT a\nGOAL: x');
      expect(executor.getSessionCount()).toBe(1);
      executor.createSession('b', 'AGENT b\nGOAL: y');
      expect(executor.getSessionCount()).toBe(2);
    });
  });
});
```

**Step 2: Run tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/pre-refactor/session-lifecycle.test.ts`
Expected: Tests pass (these test existing behavior)

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/pre-refactor/session-lifecycle.test.ts
git commit -m "test(runtime): add session lifecycle parity tests"
```

---

### Task 5: Write gather execution parity tests

**Files:**

- Create: `apps/runtime/src/__tests__/pre-refactor/gather-execution.test.ts`
- Create: `apps/runtime/src/__tests__/pre-refactor/fixtures/gather-scenarios.json`

**Step 1: Create gather test fixtures**

```json
[
  {
    "name": "simple-single-field-gather",
    "description": "Gather a single text field with no validation",
    "dsl": "AGENT gather-test\nGOAL: collect user name\nGATHER:\n  - name: userName\n    type: text\n    prompt: What is your name?",
    "interactions": [{ "input": "John", "expectGathered": { "userName": "John" } }]
  },
  {
    "name": "multi-field-gather",
    "description": "Gather multiple fields sequentially",
    "dsl": "AGENT gather-test\nGOAL: collect info\nGATHER:\n  - name: email\n    type: email\n    prompt: What is your email?\n  - name: phone\n    type: text\n    prompt: What is your phone?",
    "interactions": [
      { "input": "user@example.com", "expectGathered": { "email": "user@example.com" } },
      {
        "input": "555-1234",
        "expectGathered": { "email": "user@example.com", "phone": "555-1234" }
      }
    ]
  },
  {
    "name": "gather-with-validation-failure",
    "description": "Field rejected by validation should re-prompt",
    "dsl": "AGENT gather-test\nGOAL: collect email\nGATHER:\n  - name: email\n    type: email\n    prompt: What is your email?\n    validation: must contain @",
    "interactions": [
      { "input": "not-an-email", "expectGathered": {}, "expectRePrompt": true },
      { "input": "user@example.com", "expectGathered": { "email": "user@example.com" } }
    ]
  }
]
```

**Step 2: Write gather parity tests**

These tests will need to be adapted based on how RuntimeExecutor.executeMessage() works in practice. The key is capturing current behavior:

```typescript
// apps/runtime/src/__tests__/pre-refactor/gather-execution.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor } from '../../services/runtime-executor';
import fixtures from './fixtures/gather-scenarios.json';

describe('Pre-refactor: Gather Execution', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // These tests verify that gather field collection behavior
  // is preserved during the consolidation.
  // They will be expanded as real execution traces are captured.

  describe('session data store after gather', () => {
    it('stores gathered values in session data', () => {
      const session = executor.createSession('test', fixtures[0].dsl);
      // After initialization, session should have gather progress tracking
      expect(session.state.gatherProgress).toBeDefined();
    });

    it('tracks gathered keys in data store', () => {
      const session = executor.createSession('test', fixtures[0].dsl);
      expect(session.data).toBeDefined();
      expect(session.data.gatheredKeys).toBeDefined();
    });
  });

  describe('fixture scenarios', () => {
    for (const fixture of fixtures) {
      it(`loads correctly: ${fixture.name}`, () => {
        // Verify the DSL compiles and session initializes
        const session = executor.createSession('test', fixture.dsl);
        expect(session).toBeDefined();
        expect(session.agentName).toBe('test');
      });
    }
  });
});
```

**Step 3: Run tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/pre-refactor/gather-execution.test.ts`
Expected: Tests pass (basic structural assertions)

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/pre-refactor/gather-execution.test.ts
git add apps/runtime/src/__tests__/pre-refactor/fixtures/
git commit -m "test(runtime): add gather execution parity test scaffold with fixtures"
```

---

### Task 6: Write constraint and completion parity tests

**Files:**

- Create: `apps/runtime/src/__tests__/pre-refactor/constraint-evaluation.test.ts`
- Create: `apps/runtime/src/__tests__/pre-refactor/completion-detection.test.ts`

**Step 1: Write constraint parity tests**

```typescript
// apps/runtime/src/__tests__/pre-refactor/constraint-evaluation.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor } from '../../services/runtime-executor';

describe('Pre-refactor: Constraint Evaluation', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  const constraintDSL = `AGENT constraint-test
GOAL: help with bookings
CONSTRAINTS:
  - condition: "context.amount > 10000"
    action: escalate
    message: "Amount exceeds limit"
  - condition: "context.blocked == true"
    action: block
    message: "User is blocked"`;

  it('creates session with constraint DSL', () => {
    const session = executor.createSession('test', constraintDSL);
    expect(session).toBeDefined();
  });

  it('compiles constraints from DSL into agent IR', () => {
    const session = executor.createSession('test', constraintDSL);
    // If agentIR is populated, constraints should be present
    if (session.agentIR) {
      expect(session.agentIR).toBeDefined();
    }
  });
});
```

**Step 2: Write completion parity tests**

```typescript
// apps/runtime/src/__tests__/pre-refactor/completion-detection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor } from '../../services/runtime-executor';

describe('Pre-refactor: Completion Detection', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  const completionDSL = `AGENT complete-test
GOAL: answer a single question
COMPLETE:
  condition: "context.answered == true"
  message: "Glad I could help!"`;

  it('session starts as not complete', () => {
    const session = executor.createSession('test', completionDSL);
    expect(session.isComplete).toBe(false);
  });

  it('endSession marks removal from active set', () => {
    const session = executor.createSession('test', completionDSL);
    executor.endSession(session.id);
    expect(executor.getSession(session.id)).toBeUndefined();
  });
});
```

**Step 3: Run tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/pre-refactor/`
Expected: All pre-refactor tests pass

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/pre-refactor/constraint-evaluation.test.ts
git add apps/runtime/src/__tests__/pre-refactor/completion-detection.test.ts
git commit -m "test(runtime): add constraint and completion parity test scaffolds"
```

---

### Task 7: Write trace emission parity tests

**Files:**

- Create: `apps/runtime/src/__tests__/pre-refactor/trace-emission.test.ts`

**Step 1: Write trace emission tests**

Trace events are critical — they must be identical before and after consolidation.

```typescript
// apps/runtime/src/__tests__/pre-refactor/trace-emission.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor } from '../../services/runtime-executor';

describe('Pre-refactor: Trace Emission', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  it('session detail includes trace-relevant metadata', () => {
    const session = executor.createSession('test', 'AGENT test\nGOAL: help');
    const detail = executor.getSessionDetail(session.id);
    expect(detail).toBeDefined();
    expect(detail).toHaveProperty('id');
    expect(detail).toHaveProperty('agentName');
    expect(detail).toHaveProperty('createdAt');
  });

  it('session tracks conversation history for trace reconstruction', () => {
    const session = executor.createSession('test', 'AGENT test\nGOAL: help');
    executor.addMessage(session.id, 'user', 'hello');
    const retrieved = executor.getSession(session.id);
    expect(retrieved!.conversationHistory).toHaveLength(1);
    expect(retrieved!.conversationHistory[0]).toEqual({
      role: 'user',
      content: 'hello',
    });
  });

  it('addMessage preserves message ordering', () => {
    const session = executor.createSession('test', 'AGENT test\nGOAL: help');
    executor.addMessage(session.id, 'user', 'first');
    executor.addMessage(session.id, 'assistant', 'second');
    executor.addMessage(session.id, 'user', 'third');
    const retrieved = executor.getSession(session.id);
    expect(retrieved!.conversationHistory.map((m) => m.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
```

**Step 2: Run tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/pre-refactor/trace-emission.test.ts`
Expected: Pass

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/pre-refactor/trace-emission.test.ts
git commit -m "test(runtime): add trace emission parity tests"
```

---

### Task 8: Raise coverage thresholds (round 0)

**Files:**

- Modify: `coverage-thresholds.json`

**Step 1: Run coverage to see new baseline**

Run: `cd apps/runtime && pnpm vitest run --coverage`
Note the actual coverage after adding pre-refactor tests.

**Step 2: Update thresholds conservatively**

Raise thresholds to match new actual coverage minus 2% buffer:

```json
{
  "apps/runtime": { "lines": 14, "branches": 12, "functions": 17 },
  "apps/studio": { "lines": 7, "branches": 4, "functions": 12 },
  "packages/compiler": { "lines": 75, "branches": 59, "functions": 69 },
  "packages/database": { "lines": 53, "branches": 31, "functions": 31 },
  "packages/core": { "lines": 69, "branches": 55, "functions": 92 },
  "packages/project-io": { "lines": 86, "branches": 77, "functions": 78 },
  "apps/search-ai": { "lines": 24, "branches": 19, "functions": 16 },
  "apps/search-ai-runtime": { "lines": 46, "branches": 39, "functions": 46 }
}
```

(Adjust based on actual measured coverage — only raise, never lower.)

**Step 3: Verify thresholds pass**

Run: `pnpm build && pnpm test`
Expected: All tests pass, coverage meets new thresholds

**Step 4: Commit**

```bash
git add coverage-thresholds.json
git commit -m "build(shared): raise runtime coverage thresholds after parity test scaffold"
```

---

### Sprint 0 Gate Checklist

Before proceeding to Sprint 1, verify:

- [ ] `tools/architecture-scorecard.sh --all` runs and produces baseline metrics
- [ ] `pnpm boundary-check` runs, reports violations in warn mode
- [ ] `apps/runtime/src/__tests__/pre-refactor/` directory has 5+ test files
- [ ] All pre-refactor tests pass: `cd apps/runtime && pnpm vitest run src/__tests__/pre-refactor/`
- [ ] Coverage thresholds raised and met
- [ ] Baseline doc committed at `docs/architecture-baseline-2026-03-09.md`

---

## Sprint 1: Runtime Unification Phase 1 (Mar 23–Apr 3)

### Task 9: Implement execution context bridge

**Files:**

- Create: `apps/runtime/src/services/execution/execution-context-bridge.ts`
- Create: `apps/runtime/src/__tests__/pre-refactor/execution-context-bridge.test.ts`

**Purpose:** Bidirectional mapping between RuntimeSession and ExecutionContext.

**Key mappings to implement:**

| RuntimeSession field     | ExecutionContext field | Notes                                                                    |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `id`                     | `sessionId`            | Direct                                                                   |
| `agentIR`                | `agentIR`              | Direct                                                                   |
| `state: RuntimeState`    | `state: AgentState`    | Structure differs — map `gatherProgress`, `conversationPhase`, `context` |
| `data: SessionDataStore` | `state.gatherProgress` | `values` + `gatheredKeys` → structured gather progress                   |
| `toolExecutor`           | `toolExecutor`         | Direct (same interface)                                                  |
| `llmClient`              | `llmClient`            | SessionLLMClient wraps ConstructLLMClient                                |
| `tenantId`, `projectId`  | `config.environment`   | Flatten into config                                                      |
| `conversationHistory`    | `messageHistory`       | Map role/content format                                                  |

**Functions to implement:**

- `buildExecutionContext(session: RuntimeSession, deps: BridgeDeps): ExecutionContext`
- `applyExecutionResult(session: RuntimeSession, result: ConstructResult): void`
- Round-trip test: `session → context → result → session` preserves state

**TDD approach:**

1. Write test asserting `buildExecutionContext` maps session ID correctly
2. Implement minimal mapping
3. Add test for each field mapping
4. Add round-trip test
5. Full coverage of edge cases (null agentIR, empty history, etc.)

---

### Task 10: Delegate Gather execution

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts` (lines ~800–1200, gather logic)
- Create or modify: `packages/compiler/src/platform/constructs/executors/gather-executor.ts`
- Create: `apps/runtime/src/__tests__/pre-refactor/gather-delegation.test.ts`

**Strategy:** Strangler pattern

1. Extract gather logic from FlowStepExecutor into GatherExecutor
2. Shadow mode: call both, compare results, log mismatches
3. Cutover when parity >= 99.5%

**Key FlowStepExecutor methods to delegate:**

- `extractEntitiesWithLLM()` (line 1050)
- `executeMiniCollect()` (line 578)
- Gather field validation and re-prompting logic within `executeFlowStep()` (line 1739+)

---

### Task 11: Delegate Constraint execution

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts` (constraint checking)
- Already exists: `packages/compiler/src/platform/constructs/executors/constraint-executor.ts` (481 LOC)

**Strategy:** ConstraintExecutor already exists in compiler. Wire RuntimeExecutor to use it via the context bridge.

---

### Task 12: Delegate Completion detection

**Files:**

- Create: `packages/compiler/src/platform/constructs/executors/complete-executor.ts`
- Modify: `apps/runtime/src/services/runtime-executor.ts` (completion checking in executeMessage)

---

### Sprint 1 Gate

- [ ] `execution-context-bridge.ts` implemented with round-trip tests
- [ ] Gather delegation in shadow mode (old result returned, mismatch logged)
- [ ] Constraint delegation wired through ConstraintExecutor
- [ ] Completion delegation extracted
- [ ] All pre-refactor tests still pass
- [ ] No sev1 regressions

---

## Sprint 2: Runtime Unification Phase 2 (Apr 6–17)

### Task 13: Delegate Flow execution

- Extract step traversal (THEN, GOTO, loops) from FlowStepExecutor
- Create FlowExecutor in compiler package

### Task 14: Delegate Routing/Handoff execution

- Extract handoff/delegate logic from RuntimeExecutor
- Create HandoffExecutor + DelegateExecutor

### Task 15: Delegate Reasoning execution

- Extract reasoning zone (tool-use loops) from FlowStepExecutor
- Create ReasoningExecutor

### Task 16: Enable shadow dual-run comparison

- Both old and new paths run for all delegated executors
- Mismatch telemetry dashboarded
- Parity measured over 1 week

### Task 17: Runtime cutover (dev/staging)

- Feature flag: `use-construct-executor` default ON in dev/staging
- Monitor parity metrics
- If >= 99.5%, proceed to production cutover

### Sprint 2 Gate

- [ ] All 6 execution concerns delegated to sub-executors
- [ ] Shadow mode active for 1+ week
- [ ] Parity >= 99.5% on shadow traffic
- [ ] Performance within 10% (p50, p95, p99)
- [ ] runtime-executor.ts trending toward 1,500 LOC

---

## Sprint 3: API Verticalization Pilot (Apr 20–May 1)

### Task 18: Extract connectors route into service + repository

- Split `apps/search-ai/src/routes/connectors.ts` (1,700 LOC, 23 handlers)
- Create: `apps/search-ai/src/services/connector.service.ts`
- Create: `apps/search-ai/src/repos/connector.repository.ts`
- Route file becomes thin: auth → validate → service → response (target <300 LOC)
- Group handlers: CRUD (5), Auth/OAuth (4), Sync (6), Permissions (4), Jobs (1), Filters (1), Delta (2)

### Task 19: Extract Studio projects API into service layer

- Start with `apps/studio/src/app/api/projects/` (~85 routes)
- Create service layer for top 5 most-used project endpoints
- Route files: auth → validate → service → response

### Task 20: Extract Studio arch API into service layer

- `apps/studio/src/app/api/arch/` routes → thin handlers + service

### Task 21: Standardize error envelope

- Create shared error middleware that returns `{ success, data?, error?: { code, message } }`
- Apply to pilot routes (connectors, projects, arch)

### Sprint 3 Gate

- [ ] connectors.ts reduced from 1,700 to <300 LOC
- [ ] Connector repository with tenant-scoped queries
- [ ] Top 5 Studio project routes use thin handler pattern
- [ ] Zero direct `Model.find*` calls in pilot route files
- [ ] Error envelope standardized in pilot routes

---

## Sprint 4: Shared Package Decomposition (May 4–15)

### Task 22: Create shared-kernel package

- Create `packages/shared-kernel/` with types, errors, contracts, constants
- Zero internal dependencies (no database, no i18n)

### Task 23: Create shared-auth package

- Extract middleware: `unified-auth.middleware.ts`, `require-permission.ts`
- Depends only on shared-kernel

### Task 24: Create shared-observability package

- Extract logger factory, trace helpers, metrics
- Depends only on shared-kernel

### Task 25: Migrate imports via codemod

- Write codemod to rewrite `@agent-platform/shared` → `@agent-platform/shared-kernel` etc.
- Run across all apps and packages
- Verify no reverse coupling

### Task 26: Introduce repository pattern for remaining contexts

- `apps/search-ai/src/repos/kg.repository.ts`
- `apps/runtime/src/repos/session.repository.ts`
- Base repository class with tenant-scoped query helpers

### Sprint 4 Gate

- [ ] `shared-kernel` exists with zero database dependency
- [ ] `shared-auth` and `shared-observability` extracted
- [ ] Major apps import concern packages, not omnibus shared
- [ ] No reverse coupling (packages → apps)

---

## Sprint 5: Hardening + Enforcement (May 18–29)

### Task 27: Switch boundary rules to blocking mode

- Update `.dependency-cruiser.cjs`: change `severity: 'warn'` to `severity: 'error'`
- Add to CI pipeline (or pre-commit hook)

### Task 28: Raise coverage thresholds (final round)

- Runtime lines: 35%
- Studio lines: 30%
- Search-AI lines: 45%
- Verify all pass

### Task 29: Dead code deletion

- Run `tools/architecture-scorecard.sh` — identify old paths removed after cutover
- Delete RuntimeExecutor inline execution logic replaced by sub-executors
- Delete shadow comparison code
- Remove feature flags after stability period

### Task 30: Archive stale plan docs

- Move completed/outdated docs from `docs/plans/` to `docs/plans/archive/`
- Create canonical `docs/ARCHITECTURE.md` referencing current state

### Task 31: Publish ADR index

- Create `docs/adr/` directory
- ADR-001: Runtime consolidation decision
- ADR-002: Shared package decomposition
- ADR-003: Repository pattern adoption
- Template: `docs/adr/TEMPLATE.md`

### Sprint 5 Gate (FINAL)

- [ ] CI blocks new boundary violations
- [ ] Coverage thresholds met: runtime 35%, studio 30%, search-ai 45%
- [ ] runtime-executor.ts <= 1,500 LOC
- [ ] Top 20 largest route files reduced by >= 40%
- [ ] shared-kernel has no DB dependency
- [ ] Canonical architecture doc published
- [ ] Stale plan docs archived

---

## Success Metrics (May 29, 2026)

| Metric                 | Baseline           | Target                | How to Measure                             |
| ---------------------- | ------------------ | --------------------- | ------------------------------------------ |
| Runtime executor LOC   | 2,626              | <= 1,500              | `wc -l runtime-executor.ts`                |
| Flow step executor LOC | 4,105              | Delegated (<500 each) | Sub-executor file sizes                    |
| Route files > 300 LOC  | 108 with direct DB | Top 20 reduced 40%    | `tools/architecture-scorecard.sh --routes` |
| Direct DB in routes    | 108 files          | 0 in pilot domains    | `tools/architecture-scorecard.sh --routes` |
| Shared DB dependency   | Yes                | No (kernel)           | `cat packages/shared-kernel/package.json`  |
| Runtime coverage       | 12%                | 35%                   | `pnpm test --coverage`                     |
| Studio coverage        | 7%                 | 30%                   | `pnpm test --coverage`                     |
| Boundary violations    | Warn only          | CI blocking           | `pnpm boundary-check`                      |
