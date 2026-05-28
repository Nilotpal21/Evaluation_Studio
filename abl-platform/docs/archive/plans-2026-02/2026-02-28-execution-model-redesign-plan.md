# Execution Model Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the shared-mutable-session execution model with isolated child sessions per agent invocation, enabling parallel fan-out via `Promise.allSettled`, cancellation via AbortSignal, and a clean Restate integration seam.

**Architecture:** New `packages/execution/` package defines `ExecutionRuntime`, `ExecutionPlan`, and `Semaphore` types. `InProcessExecutionRuntime` implements parallel execution with `Promise.allSettled`. `handleFanOut` in `routing-executor.ts` is refactored to use the runtime interface. Lifecycle streaming works through the existing `onTraceEvent` callback with `executionId` added to event data.

**Tech Stack:** TypeScript, Vitest (pool: forks), pnpm workspace package, AbortController/AbortSignal (Node.js native)

**Key Simplification:** No event bus in Phase 1. The existing `onTraceEvent` callback already flows from child executions to the WebSocket handler. Adding `executionId` to trace event `data` is sufficient for the client to render parallel progress views. A dedicated `ExecutionEventBus` is only needed in Phase 2 (per-child text streaming) or Phase 3 (Restate cross-process relay).

---

## Task 1: Create `packages/execution/` Package Scaffold

**Files:**

- Create: `packages/execution/package.json`
- Create: `packages/execution/tsconfig.json`
- Create: `packages/execution/vitest.config.ts`
- Create: `packages/execution/src/index.ts`
- Create: `packages/execution/src/types.ts`

**Step 1: Create package directory**

Run: `mkdir -p packages/execution/src`

**Step 2: Create `package.json`**

Create `packages/execution/package.json`:

```json
{
  "name": "@agent-platform/execution",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Execution runtime abstractions for parallel agent execution",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  }
}
```

**Step 3: Create `tsconfig.json`**

Create `packages/execution/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

**Step 4: Create `vitest.config.ts`**

Create `packages/execution/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    testTimeout: 10_000,
  },
});
```

**Step 5: Create core types in `src/types.ts`**

Create `packages/execution/src/types.ts`:

```typescript
/**
 * Execution Model Types
 *
 * Core types for the execution runtime, execution plan, and semaphore
 * abstractions. Intentionally decoupled from runtime-specific types
 * (RuntimeSession, AgentThread) — uses generics where needed.
 *
 * NOTE: ExecutionEventBus is deferred to Phase 2. Phase 1 uses the
 * existing onTraceEvent callback with executionId in event data.
 */

// =============================================================================
// EXECUTION PLAN & RUNTIME
// =============================================================================

export interface ExecutionUnit {
  agentName: string;
  message: string;
  context?: Record<string, unknown>;
  timeout: number;
}

export interface ExecutionPlan {
  type: 'parallel' | 'sequential' | 'single';
  units: ExecutionUnit[];
  timeout: number;
  onPartialFailure: 'continue' | 'cancel-remaining' | 'fail-all';
}

export interface ExecutionUnitResult {
  agentName: string;
  status: 'completed' | 'error' | 'cancelled' | 'timeout';
  response?: string;
  error?: string;
  gatheredData?: Record<string, unknown>;
  durationMs: number;
}

/**
 * ExecutionRuntime — pluggable backend for executing agent work.
 *
 * Phase 1: InProcessExecutionRuntime (Promise.allSettled)
 * Phase 3: RestateExecutionRuntime (durable execution)
 */
export interface ExecutionRuntime {
  execute(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]>;
}

// =============================================================================
// COUNTING SEMAPHORE
// =============================================================================

export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  readonly available: number;
  readonly capacity: number;
}

// =============================================================================
// EXECUTION CONFIG (for future ExecutionContext in Phase 2)
// =============================================================================

export interface ExecutionConfig {
  timeoutMs: number;
  maxIterations: number;
  traceVerbosity: 'minimal' | 'standard' | 'verbose' | 'debug';
  executionMode: 'in-process' | 'durable';
  maxConcurrentLLMCalls?: number;
  maxConcurrentToolCalls?: number;
}

// =============================================================================
// SUSPENSION SEAM (interface only — not implemented until Phase 3)
// =============================================================================

export type SuspensionReason =
  | { type: 'async_tool'; toolName: string; callbackId: string; timeout: number }
  | { type: 'human_approval'; prompt: string; timeout: number }
  | { type: 'remote_handoff'; target: string; correlationId: string };

export interface ResumeData {
  type: string;
  payload: unknown;
}
```

**Step 6: Create barrel `src/index.ts`**

Create `packages/execution/src/index.ts`:

```typescript
export type {
  ExecutionUnit,
  ExecutionPlan,
  ExecutionUnitResult,
  ExecutionRuntime,
  Semaphore,
  ExecutionConfig,
  SuspensionReason,
  ResumeData,
} from './types.js';
```

**Step 7: Install dependencies and verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install && pnpm --filter @agent-platform/execution build`
Expected: Build succeeds, `dist/` created with type declarations.

**Step 8: Commit**

```bash
git add packages/execution/
git commit -m "feat(execution): scaffold @agent-platform/execution package with core types"
```

---

## Task 2: Implement Counting Semaphore

**Files:**

- Create: `packages/execution/src/semaphore.ts`
- Create: `packages/execution/src/__tests__/semaphore.test.ts`
- Modify: `packages/execution/src/index.ts`

**Step 1: Write the failing test**

Create `packages/execution/src/__tests__/semaphore.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { CountingSemaphore } from '../semaphore.js';

describe('CountingSemaphore', () => {
  test('acquire succeeds immediately when permits available', async () => {
    const sem = new CountingSemaphore(3);
    expect(sem.available).toBe(3);

    await sem.acquire();
    expect(sem.available).toBe(2);
  });

  test('release restores a permit', async () => {
    const sem = new CountingSemaphore(2);
    await sem.acquire();
    expect(sem.available).toBe(1);

    sem.release();
    expect(sem.available).toBe(2);
  });

  test('acquire blocks when no permits and unblocks on release', async () => {
    const sem = new CountingSemaphore(1);
    await sem.acquire(); // takes the only permit

    let acquired = false;
    const promise = sem.acquire().then(() => {
      acquired = true;
    });

    // Yield to microtask queue — should still be blocked
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);

    sem.release();
    await promise;
    expect(acquired).toBe(true);
  });

  test('FIFO ordering: waiters are unblocked in order', async () => {
    const sem = new CountingSemaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  test('capacity property returns initial count', () => {
    const sem = new CountingSemaphore(5);
    expect(sem.capacity).toBe(5);
  });

  test('release does not exceed capacity', () => {
    const sem = new CountingSemaphore(2);
    sem.release(); // spurious release
    expect(sem.available).toBe(2); // capped at capacity
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution test`
Expected: FAIL — `Cannot find module '../semaphore.js'`

**Step 3: Implement CountingSemaphore**

Create `packages/execution/src/semaphore.ts`:

```typescript
import type { Semaphore } from './types.js';

/**
 * Counting semaphore for limiting concurrent operations.
 *
 * Used to cap LLM/tool concurrency within a fan-out to prevent
 * one fan-out from consuming all global permits.
 *
 * FIFO: waiters are unblocked in acquisition order.
 */
export class CountingSemaphore implements Semaphore {
  private _available: number;
  private readonly _capacity: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this._capacity = capacity;
    this._available = capacity;
  }

  get available(): number {
    return this._available;
  }

  get capacity(): number {
    return this._capacity;
  }

  acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      // Resolve on next microtick to avoid stack overflow with many waiters
      queueMicrotask(next);
    } else if (this._available < this._capacity) {
      this._available++;
    }
  }
}
```

**Step 4: Update barrel export**

Add to `packages/execution/src/index.ts`:

```typescript
export { CountingSemaphore } from './semaphore.js';
```

**Step 5: Build and run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution build && pnpm --filter @agent-platform/execution test`
Expected: All 6 semaphore tests PASS.

**Step 6: Commit**

```bash
git add packages/execution/src/semaphore.ts packages/execution/src/__tests__/semaphore.test.ts packages/execution/src/index.ts
git commit -m "feat(execution): implement CountingSemaphore for LLM concurrency control"
```

---

## Task 3: Implement InProcessExecutionRuntime

**Files:**

- Create: `packages/execution/src/in-process-runtime.ts`
- Create: `packages/execution/src/__tests__/in-process-runtime.test.ts`
- Modify: `packages/execution/src/index.ts`

**Step 1: Write the failing test**

Create `packages/execution/src/__tests__/in-process-runtime.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { InProcessExecutionRuntime } from '../in-process-runtime.js';
import type { ExecutionPlan, ExecutionUnit, ExecutionUnitResult } from '../types.js';

function makeUnit(name: string, timeout = 5000): ExecutionUnit {
  return { agentName: name, message: 'test', timeout };
}

function makeResult(
  name: string,
  overrides: Partial<ExecutionUnitResult> = {},
): ExecutionUnitResult {
  return {
    agentName: name,
    status: 'completed',
    response: `${name} done`,
    durationMs: 10,
    ...overrides,
  };
}

describe('InProcessExecutionRuntime', () => {
  test('parallel plan executes all units concurrently', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B'), makeUnit('C')],
      timeout: 10000,
      onPartialFailure: 'continue',
    };

    const executionOrder: string[] = [];
    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      executionOrder.push(`start:${unit.agentName}`);
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push(`end:${unit.agentName}`);
      return makeResult(unit.agentName);
    });

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // All started before any ended (parallel)
    const startIndices = executionOrder.filter((e) => e.startsWith('start:')).map((_, i) => i);
    const firstEnd = executionOrder.findIndex((e) => e.startsWith('end:'));
    expect(startIndices.every((i) => i < firstEnd)).toBe(true);
  });

  test('parallel plan with continue strategy tolerates partial failure', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'continue',
    };

    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      if (unit.agentName === 'B') throw new Error('B failed');
      return makeResult(unit.agentName);
    });

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.agentName === 'A')?.status).toBe('completed');
    expect(results.find((r) => r.agentName === 'B')?.status).toBe('error');
  });

  test('sequential plan executes units in order', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'sequential',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'fail-all',
    };

    const executionOrder: string[] = [];
    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      executionOrder.push(unit.agentName);
      return makeResult(unit.agentName);
    });

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(2);
    expect(executionOrder).toEqual(['A', 'B']);
  });

  test('sequential plan with fail-all stops on first failure', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'sequential',
      units: [makeUnit('A'), makeUnit('B'), makeUnit('C')],
      timeout: 10000,
      onPartialFailure: 'fail-all',
    };

    const executeUnit = vi.fn(async (unit: ExecutionUnit) => {
      if (unit.agentName === 'B') throw new Error('B failed');
      return makeResult(unit.agentName);
    });

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('error');
    expect(executeUnit).toHaveBeenCalledTimes(2); // C never executed
  });

  test('single plan executes one unit', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'single',
      units: [makeUnit('A')],
      timeout: 10000,
      onPartialFailure: 'fail-all',
    };

    const executeUnit = vi.fn(async () => makeResult('A'));
    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('completed');
  });

  test('per-unit timeout produces timeout result', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A', 50)],
      timeout: 10000,
      onPartialFailure: 'continue',
    };

    const executeUnit = vi.fn(async (_unit: ExecutionUnit, signal: AbortSignal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return makeResult('A');
    });

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('timeout');
  });

  test('parent signal cancellation aborts all children', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'continue',
    };

    const parentController = new AbortController();

    const executeUnit = vi.fn(async (unit: ExecutionUnit, signal: AbortSignal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return makeResult(unit.agentName);
    });

    // Cancel after 50ms
    setTimeout(() => parentController.abort(), 50);

    const results = await runtime.execute(plan, executeUnit, parentController.signal);

    expect(results.every((r) => r.status === 'cancelled' || r.status === 'timeout')).toBe(true);
  });

  test('cancel-remaining aborts siblings on first failure', async () => {
    const runtime = new InProcessExecutionRuntime();
    const plan: ExecutionPlan = {
      type: 'parallel',
      units: [makeUnit('A'), makeUnit('B')],
      timeout: 10000,
      onPartialFailure: 'cancel-remaining',
    };

    const executeUnit = vi.fn(async (unit: ExecutionUnit, signal: AbortSignal) => {
      if (unit.agentName === 'A') {
        throw new Error('A failed immediately');
      }
      // B waits and should get cancelled
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Cancelled'));
        });
      });
      return makeResult(unit.agentName);
    });

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results.find((r) => r.agentName === 'A')?.status).toBe('error');
    expect(results.find((r) => r.agentName === 'B')?.status).toBe('cancelled');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution build && pnpm --filter @agent-platform/execution test`
Expected: FAIL — `Cannot find module '../in-process-runtime.js'`

**Step 3: Implement InProcessExecutionRuntime**

Create `packages/execution/src/in-process-runtime.ts`:

```typescript
import type {
  ExecutionRuntime,
  ExecutionPlan,
  ExecutionUnit,
  ExecutionUnitResult,
} from './types.js';

/**
 * In-process execution runtime using Promise.allSettled for parallel execution.
 *
 * No crash recovery — if the pod dies, the caller retries.
 * Cancellation via AbortSignal (per-unit timeout + parent cancel).
 */
export class InProcessExecutionRuntime implements ExecutionRuntime {
  async execute(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]> {
    switch (plan.type) {
      case 'parallel':
        return this.executeParallel(plan, executeUnit, parentSignal);
      case 'sequential':
        return this.executeSequential(plan, executeUnit, parentSignal);
      case 'single':
        return this.executeSingle(plan, executeUnit, parentSignal);
      default:
        throw new Error(`Unknown execution plan type: ${(plan as ExecutionPlan).type}`);
    }
  }

  private async executeParallel(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]> {
    const childControllers = plan.units.map(() => new AbortController());

    // Link parent signal to all children
    const onParentAbort = () => {
      for (const controller of childControllers) {
        controller.abort(parentSignal.reason);
      }
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const promises = plan.units.map((unit, i) => {
      const controller = childControllers[i];
      const unitTimeout = setTimeout(() => controller.abort('timeout'), unit.timeout);

      const startTime = Date.now();
      return executeUnit(unit, controller.signal)
        .then((result) => {
          clearTimeout(unitTimeout);
          return result;
        })
        .catch((err) => {
          clearTimeout(unitTimeout);
          const durationMs = Date.now() - startTime;
          const isTimeout = controller.signal.aborted && controller.signal.reason === 'timeout';
          const isCancelled = controller.signal.aborted && !isTimeout;

          const result: ExecutionUnitResult = {
            agentName: unit.agentName,
            status: isTimeout ? 'timeout' : isCancelled ? 'cancelled' : 'error',
            error: err instanceof Error ? err.message : String(err),
            durationMs,
          };

          // cancel-remaining: abort siblings on first failure
          if (plan.onPartialFailure === 'cancel-remaining' && !isCancelled) {
            for (let j = 0; j < childControllers.length; j++) {
              if (j !== i) childControllers[j].abort('sibling-failed');
            }
          }

          return result;
        });
    });

    const settled = await Promise.allSettled(promises);
    parentSignal.removeEventListener('abort', onParentAbort);

    return settled.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            agentName: 'unknown',
            status: 'error' as const,
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
            durationMs: 0,
          },
    );
  }

  private async executeSequential(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]> {
    const results: ExecutionUnitResult[] = [];

    for (const unit of plan.units) {
      if (parentSignal.aborted) {
        results.push({
          agentName: unit.agentName,
          status: 'cancelled',
          error: 'Parent cancelled',
          durationMs: 0,
        });
        break;
      }

      const controller = new AbortController();
      const unitTimeout = setTimeout(() => controller.abort('timeout'), unit.timeout);

      const onParentAbort = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', onParentAbort, { once: true });

      const startTime = Date.now();
      try {
        const result = await executeUnit(unit, controller.signal);
        clearTimeout(unitTimeout);
        parentSignal.removeEventListener('abort', onParentAbort);
        results.push(result);
      } catch (err) {
        clearTimeout(unitTimeout);
        parentSignal.removeEventListener('abort', onParentAbort);
        const durationMs = Date.now() - startTime;
        const isTimeout = controller.signal.aborted && controller.signal.reason === 'timeout';

        results.push({
          agentName: unit.agentName,
          status: isTimeout ? 'timeout' : 'error',
          error: err instanceof Error ? err.message : String(err),
          durationMs,
        });

        if (plan.onPartialFailure === 'fail-all') {
          break;
        }
      }
    }

    return results;
  }

  private async executeSingle(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]> {
    const unit = plan.units[0];
    if (!unit) return [];

    const singlePlan: ExecutionPlan = {
      ...plan,
      type: 'sequential',
      units: [unit],
    };
    return this.executeSequential(singlePlan, executeUnit, parentSignal);
  }
}
```

**Step 4: Update barrel export**

Add to `packages/execution/src/index.ts`:

```typescript
export { InProcessExecutionRuntime } from './in-process-runtime.js';
```

**Step 5: Build and run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution build && pnpm --filter @agent-platform/execution test`
Expected: All 8 runtime tests PASS + 6 semaphore tests still PASS.

**Step 6: Commit**

```bash
git add packages/execution/src/in-process-runtime.ts packages/execution/src/__tests__/in-process-runtime.test.ts packages/execution/src/index.ts
git commit -m "feat(execution): implement InProcessExecutionRuntime with Promise.allSettled"
```

---

## Task 4: Add `createChildSession` and `createExecutionId` Helpers

**Files:**

- Create: `packages/execution/src/child-session.ts`
- Create: `packages/execution/src/__tests__/child-session.test.ts`
- Modify: `packages/execution/src/index.ts`

**Step 1: Write the failing test**

Create `packages/execution/src/__tests__/child-session.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { createChildSession, createExecutionId } from '../child-session.js';

// Minimal RuntimeSession-like object for testing
function makeSession() {
  return {
    id: 'sess-1',
    agentName: 'Supervisor',
    agentIR: { metadata: { name: 'Supervisor' } },
    compilationOutput: null,
    conversationHistory: [{ role: 'user', content: 'hello' }],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: { existing: 'value' }, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    userId: 'user-1',
    channelType: 'sdk_websocket',
    callerContext: { customerId: 'c1' },
    toolExecutor: { execute: async () => ({}) },
    factStore: undefined,
    llmClient: { chat: async () => ({}) },
    initialized: true,
    threads: [
      {
        agentName: 'Supervisor',
        agentIR: { metadata: { name: 'Supervisor' } },
        conversationHistory: [{ role: 'user', content: 'hello' }],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        data: { values: {}, gatheredKeys: new Set<string>() },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active' as const,
      },
      {
        agentName: 'ChildAgent',
        agentIR: { metadata: { name: 'ChildAgent' } },
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        data: { values: { _fan_out_child: true }, gatheredKeys: new Set<string>() },
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active' as const,
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 1,
  };
}

describe('createChildSession', () => {
  test('child session has mutable fields from the child thread', () => {
    const parent = makeSession();
    const child = createChildSession(parent, 1);

    expect(child.agentName).toBe('ChildAgent');
    expect(child.conversationHistory).toBe(parent.threads[1].conversationHistory);
    expect(child.state).toBe(parent.threads[1].state);
    expect(child.data).toBe(parent.threads[1].data);
    expect(child.activeThreadIndex).toBe(1);
  });

  test('child session shares immutable identity from parent', () => {
    const parent = makeSession();
    const child = createChildSession(parent, 1);

    expect(child.id).toBe(parent.id);
    expect(child.tenantId).toBe(parent.tenantId);
    expect(child.projectId).toBe(parent.projectId);
    expect(child.callerContext).toBe(parent.callerContext);
    expect(child.channelType).toBe(parent.channelType);
    expect(child.compilationOutput).toBe(parent.compilationOutput);
    expect(child.toolExecutor).toBe(parent.toolExecutor);
  });

  test('child session has isComplete and isEscalated reset', () => {
    const parent = makeSession();
    parent.isComplete = true;
    parent.isEscalated = true;

    const child = createChildSession(parent, 1);

    expect(child.isComplete).toBe(false);
    expect(child.isEscalated).toBe(false);
  });

  test('child session shares same threads array (mutations visible to parent)', () => {
    const parent = makeSession();
    const child = createChildSession(parent, 1);

    expect(child.threads).toBe(parent.threads);
  });

  test('throws on invalid thread index', () => {
    const parent = makeSession();
    expect(() => createChildSession(parent, 99)).toThrow('Thread index 99 out of bounds');
  });
});

describe('createExecutionId', () => {
  test('returns a string with exec- prefix', () => {
    const id = createExecutionId();
    expect(id).toMatch(/^exec-/);
  });

  test('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createExecutionId()));
    expect(ids.size).toBe(100);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution build && pnpm --filter @agent-platform/execution test`
Expected: FAIL — `Cannot find module '../child-session.js'`

**Step 3: Implement createChildSession and createExecutionId**

Create `packages/execution/src/child-session.ts`:

```typescript
import crypto from 'crypto';

/**
 * Create a lightweight session clone for a child thread.
 *
 * The child session's mutable fields (agentName, agentIR, conversationHistory,
 * state, data, currentFlowStep) point to the child thread's data. Identity
 * fields (tenantId, projectId, callerContext, etc.) are shared from the parent.
 *
 * This preserves backward compatibility: buildSystemPrompt, buildTools, and all
 * executor code that reads session top-level fields continues working because
 * the child session's top-level fields point to the correct thread data.
 *
 * Generic: works with any session/thread shape via structural typing.
 */
export function createChildSession<
  TSession extends {
    threads: Array<{
      agentName: string;
      agentIR: unknown;
      conversationHistory: unknown[];
      state: unknown;
      data: unknown;
      currentFlowStep?: string;
      llmClient?: unknown;
    }>;
    [key: string]: unknown;
  },
>(parentSession: TSession, threadIndex: number): TSession {
  const thread = parentSession.threads[threadIndex];
  if (!thread) {
    throw new Error(
      `Thread index ${threadIndex} out of bounds (${parentSession.threads.length} threads)`,
    );
  }

  return {
    ...parentSession,
    agentName: thread.agentName,
    agentIR: thread.agentIR,
    conversationHistory: thread.conversationHistory,
    state: thread.state,
    data: thread.data,
    currentFlowStep: thread.currentFlowStep,
    activeThreadIndex: threadIndex,
    llmClient: thread.llmClient,
    isComplete: false,
    isEscalated: false,
  };
}

/**
 * Generate a unique execution ID.
 * Prefixed with `exec-` for easy identification in logs and traces.
 */
export function createExecutionId(): string {
  return `exec-${crypto.randomUUID()}`;
}
```

**Step 4: Update barrel export**

Add to `packages/execution/src/index.ts`:

```typescript
export { createChildSession, createExecutionId } from './child-session.js';
```

**Step 5: Build and run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution build && pnpm --filter @agent-platform/execution test`
Expected: All child-session tests PASS (6 tests) + previous tests still PASS.

**Step 6: Commit**

```bash
git add packages/execution/src/child-session.ts packages/execution/src/__tests__/child-session.test.ts packages/execution/src/index.ts
git commit -m "feat(execution): add createChildSession and createExecutionId helpers"
```

---

## Task 5: Add `llmClient` to `AgentThread`

**Files:**

- Modify: `apps/runtime/src/services/execution/types.ts:40-61` (AgentThread interface)

**Step 1: Add `llmClient` field to `AgentThread` interface**

In `apps/runtime/src/services/execution/types.ts`, add after line 60 (`status: 'active' | 'waiting' | 'completed' | 'escalated';`):

```typescript
  /** Per-thread LLM client — enables parallel execution without shared session.llmClient */
  llmClient?: import('../llm/session-llm-client.js').SessionLLMClient;
```

**Step 2: Verify Redis session store skips transient fields**

Read `apps/runtime/src/services/session/redis-session-store.ts` and verify that the thread serializer does not attempt to serialize `llmClient` (it's a runtime-only reference with functions, so JSON.stringify would skip it or produce `undefined`). If explicit exclusion is needed, add it to the serialization logic.

**Step 3: Build and run existing tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test`
Expected: All existing tests PASS (the new field is optional, no breakage).

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/types.ts
git commit -m "feat(execution): add optional llmClient to AgentThread for parallel execution"
```

---

## Task 6: Add `executionId` to TraceEvent

**Files:**

- Modify: `apps/runtime/src/types/index.ts` (add `executionId` and `parentExecutionId` to `TraceEventWithId`)

**Step 1: Find and read the TraceEvent type definition**

Run: `grep -n 'TraceEventWithId\|interface.*TraceEvent' apps/runtime/src/types/index.ts`

**Step 2: Add optional execution fields**

In the `TraceEventWithId` interface, add:

```typescript
  /** Execution context ID for correlating events within a fan-out */
  executionId?: string;
  /** Parent execution ID for parent-child correlation */
  parentExecutionId?: string;
```

**Step 3: Build and run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test`
Expected: All tests PASS (additive, optional fields).

**Step 4: Commit**

```bash
git add apps/runtime/src/types/index.ts
git commit -m "feat(runtime): add executionId and parentExecutionId to TraceEvent"
```

---

## Task 7: Wire `@agent-platform/execution` into Runtime — Refactor `handleFanOut`

This is the core refactoring task. It replaces the sequential `for` loop in `handleFanOut` (`routing-executor.ts:955-1059`) with `InProcessExecutionRuntime.execute()`.

**Files:**

- Modify: `apps/runtime/package.json` (add dependency)
- Modify: `apps/runtime/src/services/execution/routing-executor.ts:910-1110` (refactor `handleFanOut`)

**Step 1: Add workspace dependency**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter runtime add @agent-platform/execution@workspace:*`

**Step 2: Write the failing test for parallel fan-out**

Create `apps/runtime/src/__tests__/fan-out-parallel.test.ts`:

```typescript
/**
 * Parallel Fan-Out Tests
 *
 * Tests that fan-out uses Promise.allSettled for parallel execution,
 * child sessions are properly isolated, and partial failures are handled.
 */

import { describe, test, expect, vi } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';

// ---------------------------------------------------------------------------
// DSL Fixtures
// ---------------------------------------------------------------------------

const agentA = `
AGENT: Agent_A
MODE: reasoning
GOAL: "Agent A"
PERSONA: "A"
`;

const agentB = `
AGENT: Agent_B
MODE: reasoning
GOAL: "Agent B"
PERSONA: "B"
`;

const supervisorDsl = `
SUPERVISOR: Router

MODE: reasoning

GOAL: "Route requests"

HANDOFF:
  - TO: Agent_A
    WHEN: intent contains "a"
  - TO: Agent_B
    WHEN: intent contains "b"
`;

describe('Parallel Fan-Out', () => {
  test('fan-out children execute in parallel (not sequentially)', async () => {
    const executor = new RuntimeExecutor();
    executor.registerAgent('Agent_A', agentA);
    executor.registerAgent('Agent_B', agentB);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, agentA, agentB], 'Router'),
    );

    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    (executor as any).executeMessage = vi.fn(async (_sid: string, message: string) => {
      const agent = message.includes('A') ? 'Agent_A' : 'Agent_B';
      startTimes[agent] = Date.now();
      await new Promise((r) => setTimeout(r, 100));
      endTimes[agent] = Date.now();
      return { response: `${agent} done`, action: { type: 'none' } };
    });
    (executor as any).llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);

    const routing = (executor as any).routing;
    const result = await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);

    // Verify parallel: both started before either finished
    if (startTimes.Agent_A && startTimes.Agent_B) {
      const overlapMs =
        Math.min(endTimes.Agent_A, endTimes.Agent_B) -
        Math.max(startTimes.Agent_A, startTimes.Agent_B);
      expect(overlapMs).toBeGreaterThan(0);
    }
  });

  test('fan-out continues on partial failure', async () => {
    const executor = new RuntimeExecutor();
    executor.registerAgent('Agent_A', agentA);
    executor.registerAgent('Agent_B', agentB);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, agentA, agentB], 'Router'),
    );

    (executor as any).executeMessage = vi.fn(async (_sid: string, message: string) => {
      if (message.includes('A')) throw new Error('Agent_A crashed');
      return { response: 'B done', action: { type: 'none' } };
    });
    (executor as any).llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);

    const routing = (executor as any).routing;
    const result = await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(result.failedCount).toBe(1);
    expect(result.results.find((r: any) => r.target === 'Agent_A')?.status).toBe('error');
    expect(result.results.find((r: any) => r.target === 'Agent_B')?.status).toBe('completed');
  });

  test('parent session is restored after fan-out completes', async () => {
    const executor = new RuntimeExecutor();
    executor.registerAgent('Agent_A', agentA);
    executor.registerAgent('Agent_B', agentB);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, agentA, agentB], 'Router'),
    );

    (executor as any).executeMessage = vi.fn(async () => ({
      response: 'done',
      action: { type: 'none' },
    }));
    (executor as any).llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      {
        tasks: [
          { target: 'Agent_A', intent: 'do A stuff' },
          { target: 'Agent_B', intent: 'do B stuff' },
        ],
      },
      undefined,
      vi.fn(),
    );

    // Parent session is restored to supervisor
    expect(session.agentName).toBe('Router');
  });

  test('fan-out trace events include executionId', async () => {
    const executor = new RuntimeExecutor();
    executor.registerAgent('Agent_A', agentA);
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([supervisorDsl, agentA], 'Router'),
    );

    (executor as any).executeMessage = vi.fn(async () => ({
      response: 'done',
      action: { type: 'none' },
    }));
    (executor as any).llmWiring.wireLLMClient = vi.fn().mockResolvedValue(undefined);

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = vi.fn((event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    });

    const routing = (executor as any).routing;
    await routing.handleFanOut(
      session,
      { tasks: [{ target: 'Agent_A', intent: 'do A stuff' }] },
      undefined,
      onTraceEvent,
    );

    const startEvent = traceEvents.find((e) => e.type === 'fan_out_start');
    expect(startEvent?.data.executionId).toBeDefined();
    expect(typeof startEvent?.data.executionId).toBe('string');
  });
});
```

**Step 3: Run test to verify it fails (current sequential code won't show temporal overlap)**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && cd apps/runtime && npx vitest run src/__tests__/fan-out-parallel.test.ts`

**Step 4: Refactor `handleFanOut` in `routing-executor.ts`**

In `apps/runtime/src/services/execution/routing-executor.ts`:

Add imports at the top:

```typescript
import {
  InProcessExecutionRuntime,
  createChildSession,
  createExecutionId,
} from '@agent-platform/execution';
import type { ExecutionPlan, ExecutionUnit, ExecutionUnitResult } from '@agent-platform/execution';
```

Add private field to `RoutingExecutor` class:

```typescript
  private executionRuntime = new InProcessExecutionRuntime();
```

Replace the `handleFanOut` method body (lines 910-1110). The new implementation:

1. Validates and deduplicates tasks (unchanged)
2. Creates child threads (unchanged)
3. Builds an `ExecutionPlan` with `type: 'parallel'`
4. Defines `executeUnit` closure that creates a child session via `createChildSession`, wires LLM, calls `this.ctx.executeMessage`
5. Calls `this.executionRuntime.execute(plan, executeUnit, parentSignal)`
6. Maps `ExecutionUnitResult[]` back to `SubTaskResult[]` and stores in parent thread (unchanged)
7. Adds `executionId` to all `onTraceEvent` calls

The full replacement code for `handleFanOut`:

```typescript
  async handleFanOut(
    session: RuntimeSession,
    input: { tasks: Array<{ target: string; intent: string; context?: Record<string, unknown> }> },
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<FanOutResult> {
    const tasks = input.tasks;
    const currentThread = getActiveThread(session);
    const savedActiveIndex = session.activeThreadIndex;
    const results: SubTaskResult[] = [];
    const parentExecutionId = createExecutionId();

    // --- Validation (unchanged) ---
    const dedupedTasks = deduplicateFanOutTasks(tasks);
    const filteredTasks = dedupedTasks.filter((t) => t.target !== currentThread.agentName);
    const executableTasks: Array<{
      target: string;
      intent: string;
      context?: Record<string, unknown>;
    }> = [];
    for (const task of filteredTasks) {
      if (!this.ctx.agentRegistry[task.target]?.ir) {
        results.push({
          target: task.target,
          status: 'error',
          error: `Agent not found: ${task.target}`,
        });
      } else {
        executableTasks.push(task);
      }
    }

    if (executableTasks.length === 0) {
      return { success: false, results, failedCount: results.length };
    }

    // --- Build execution plan ---
    const timeoutMs = this.ctx.config.timeoutMs || 30000;

    onTraceEvent?.({
      type: 'fan_out_start',
      data: {
        executionId: parentExecutionId,
        taskCount: executableTasks.length,
        targets: executableTasks.map((t) => t.target),
        agentName: currentThread.agentName,
      },
    });

    const plan: ExecutionPlan = {
      type: 'parallel',
      units: executableTasks.map((task) => ({
        agentName: task.target,
        message: task.intent,
        context: task.context,
        timeout: timeoutMs,
      })),
      timeout: timeoutMs * 2,
      onPartialFailure: 'continue',
    };

    // --- Prepare child threads ---
    const childThreadIndices = new Map<string, number>();
    for (const task of executableTasks) {
      const targetInfo = this.ctx.agentRegistry[task.target];
      createThread(session, task.target, targetInfo.ir, {
        handoffFrom: currentThread.agentName,
        initialData: {
          ...task.context,
          _fan_out_intent: task.intent,
          _fan_out_child: true,
          delegate_from: currentThread.agentName,
        },
      });
      childThreadIndices.set(task.target, session.threads.length - 1);
    }

    // --- Execute in parallel via ExecutionRuntime ---
    const executeUnit = async (
      unit: ExecutionUnit,
      _signal: AbortSignal,
    ): Promise<ExecutionUnitResult> => {
      const childIndex = childThreadIndices.get(unit.agentName)!;
      const childThread = session.threads[childIndex];
      const targetInfo = this.ctx.agentRegistry[unit.agentName];
      const startTime = Date.now();

      onTraceEvent?.({
        type: 'fan_out_task_start',
        data: {
          executionId: parentExecutionId,
          index: executableTasks.findIndex((t) => t.target === unit.agentName),
          target: unit.agentName,
          intent: unit.message,
          agentName: currentThread.agentName,
        },
      });

      // Create isolated child session pointing to this child's thread
      const childSession = createChildSession(session, childIndex);

      // Wire LLM client for child agent
      if (targetInfo.ir) {
        await this.llmWiring
          .wireLLMClient(
            childSession,
            targetInfo.ir,
            session.tenantId,
            session.projectId,
            session.userId,
          )
          .catch((err) => {
            log.error('Failed to wire LLM client for fan-out child', {
              agent: unit.agentName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        // Store on thread for reference
        childThread.llmClient = childSession.llmClient;
      }

      // Temporarily swap session in the map so executeMessage finds the child session
      const originalSession = this.ctx.sessions.get(session.id);
      this.ctx.sessions.set(session.id, childSession);

      try {
        const result = await this.ctx.executeMessage(
          session.id,
          unit.message,
          undefined,
          onTraceEvent,
        );

        childThread.status = 'completed';
        childThread.endedAt = Date.now();

        return {
          agentName: unit.agentName,
          status: 'completed',
          response: result.response,
          gatheredData: Object.fromEntries(
            [...childThread.data.gatheredKeys].map((k) => [k, childThread.data.values[k]]),
          ),
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        childThread.status = 'completed';
        childThread.endedAt = Date.now();

        return {
          agentName: unit.agentName,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        };
      } finally {
        // Restore original session in the map
        if (originalSession) {
          this.ctx.sessions.set(session.id, originalSession);
        }
      }
    };

    const executionResults = await this.executionRuntime.execute(
      plan,
      executeUnit,
      AbortSignal.timeout(timeoutMs * 2),
    );

    // --- Restore parent state ---
    session.activeThreadIndex = savedActiveIndex;
    syncThreadToSession(session);

    // --- Map results ---
    for (const er of executionResults) {
      results.push({
        target: er.agentName,
        status: er.status === 'completed' ? 'completed' : 'error',
        response: er.response,
        error: er.error,
        gatheredData: er.gatheredData,
      });

      onTraceEvent?.({
        type: 'fan_out_task_complete',
        data: {
          executionId: parentExecutionId,
          target: er.agentName,
          status: er.status,
          durationMs: er.durationMs,
          error: er.error,
          agentName: currentThread.agentName,
        },
      });
    }

    // --- Store results (unchanged) ---
    const fanOutResult: FanOutResult = {
      success: results.some((r) => r.status === 'completed'),
      results,
      failedCount: results.filter((r) => r.status === 'error').length,
    };

    currentThread.data.values._last_fan_out = {
      timestamp: Date.now(),
      results: results.map((r) => ({
        target: r.target,
        status: r.status,
        response: r.response || r.error,
      })),
    };

    for (const r of results) {
      const key = `_fan_out_result_${r.target}`;
      currentThread.data.values[key] = r.status === 'completed' ? r.response : r.error;
    }

    for (const r of results) {
      if (r.status === 'completed' && r.response) {
        currentThread.conversationHistory.push({
          role: 'assistant',
          content: `[${r.target}]: ${r.response}`,
        });
      } else if (r.status === 'error') {
        currentThread.conversationHistory.push({
          role: 'assistant',
          content: `[${r.target}] ERROR: ${r.error}`,
        });
      }
    }

    syncThreadToSession(session);

    onTraceEvent?.({
      type: 'fan_out_complete',
      data: {
        executionId: parentExecutionId,
        taskCount: executableTasks.length,
        completedCount: results.filter((r) => r.status === 'completed').length,
        failedCount: fanOutResult.failedCount,
        agentName: currentThread.agentName,
      },
    });

    return fanOutResult;
  }
```

**Step 5: Build and run all fan-out tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && cd apps/runtime && npx vitest run src/__tests__/fan-out.test.ts src/__tests__/fan-out-parallel.test.ts`
Expected: All existing + new fan-out tests PASS.

**Step 6: Run full runtime test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test`
Expected: All tests PASS.

**Step 7: Commit**

```bash
git add apps/runtime/package.json apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/fan-out-parallel.test.ts pnpm-lock.yaml
git commit -m "feat(runtime): refactor handleFanOut to parallel execution via InProcessExecutionRuntime"
```

---

## Task 8: Integration Test — Full Parallel Fan-Out Flow

**Files:**

- Create: `apps/runtime/src/__tests__/execution-model-integration.test.ts`

**Step 1: Write integration test**

Create `apps/runtime/src/__tests__/execution-model-integration.test.ts`:

```typescript
/**
 * Execution Model Integration Tests
 *
 * Verifies the packages/execution primitives work end-to-end:
 * - InProcessExecutionRuntime dispatches units in parallel
 * - CountingSemaphore limits concurrency
 * - createChildSession produces isolated sessions
 * - createExecutionId generates unique IDs
 */

import { describe, test, expect } from 'vitest';
import {
  InProcessExecutionRuntime,
  CountingSemaphore,
  createChildSession,
  createExecutionId,
} from '@agent-platform/execution';
import type { ExecutionPlan, ExecutionUnit, ExecutionUnitResult } from '@agent-platform/execution';

describe('Execution Model Integration', () => {
  test('parallel execution with semaphore-limited concurrency', async () => {
    const runtime = new InProcessExecutionRuntime();
    const semaphore = new CountingSemaphore(2);

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const plan: ExecutionPlan = {
      type: 'parallel',
      units: Array.from({ length: 5 }, (_, i) => ({
        agentName: `Agent_${i}`,
        message: `task ${i}`,
        timeout: 5000,
      })),
      timeout: 10000,
      onPartialFailure: 'continue',
    };

    const executeUnit = async (unit: ExecutionUnit): Promise<ExecutionUnitResult> => {
      await semaphore.acquire();
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 30));
      currentConcurrent--;
      semaphore.release();

      return {
        agentName: unit.agentName,
        status: 'completed',
        response: `${unit.agentName} done`,
        durationMs: 30,
      };
    };

    const results = await runtime.execute(plan, executeUnit, AbortSignal.timeout(10000));

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test('createChildSession produces isolated session', () => {
    const parent = {
      id: 'sess-1',
      agentName: 'Supervisor',
      agentIR: { metadata: { name: 'Supervisor' } },
      conversationHistory: [{ role: 'user', content: 'hello' }],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      data: { values: {}, gatheredKeys: new Set<string>() },
      isComplete: false,
      isEscalated: false,
      tenantId: 'tenant-1',
      threads: [
        {
          agentName: 'Supervisor',
          agentIR: { metadata: { name: 'Supervisor' } },
          conversationHistory: [{ role: 'user', content: 'hello' }],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          data: { values: {}, gatheredKeys: new Set<string>() },
          status: 'active',
        },
        {
          agentName: 'Child',
          agentIR: { metadata: { name: 'Child' } },
          conversationHistory: [],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          data: { values: { _fan_out_child: true }, gatheredKeys: new Set<string>() },
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
    };

    const child = createChildSession(parent, 1);

    // Mutable fields point to child thread
    expect(child.agentName).toBe('Child');
    expect(child.data).toBe(parent.threads[1].data);

    // Identity shared from parent
    expect(child.tenantId).toBe('tenant-1');
    expect(child.id).toBe('sess-1');

    // Mutating child top-level doesn't affect parent
    child.agentName = 'Modified';
    expect(parent.agentName).toBe('Supervisor');

    // But data is same reference — mutations visible
    child.data.values.newKey = 'newValue';
    expect(parent.threads[1].data.values.newKey).toBe('newValue');
  });

  test('executionIds are unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createExecutionId()));
    expect(ids.size).toBe(1000);
  });
});
```

**Step 2: Run the integration test**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && cd apps/runtime && npx vitest run src/__tests__/execution-model-integration.test.ts`
Expected: All 3 integration tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/execution-model-integration.test.ts
git commit -m "test(runtime): add execution model integration tests for parallel fan-out"
```

---

## Task 9: Verify Existing Fan-Out Tests + Full Regression

**Files:**

- Possibly modify: `apps/runtime/src/__tests__/fan-out.test.ts` (only if tests fail)

**Step 1: Run existing fan-out tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && cd apps/runtime && npx vitest run src/__tests__/fan-out.test.ts`
Expected: All existing tests PASS.

**Step 2: If any tests fail, diagnose and fix**

Common issues:

- `session.agentName` mutation timing changed — child sessions now use `createChildSession` spread instead of direct field mutation
- `executeMessage` mock receives a child session in the map instead of the mutated parent — adjust mock expectations if needed

**Step 3: Run full runtime test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test`
Expected: All tests PASS.

**Step 4: Run full monorepo test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm test`
Expected: All packages PASS.

**Step 5: Verify no TypeScript errors**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/execution typecheck && pnpm --filter runtime typecheck`
Expected: No errors.

**Step 6: Commit (only if test fixes were needed)**

```bash
git add apps/runtime/src/__tests__/fan-out.test.ts
git commit -m "test(runtime): update existing fan-out tests for parallel execution model"
```

---

## Summary

| Task      | What                                   | New Files | Modified Files | Commits |
| --------- | -------------------------------------- | --------- | -------------- | ------- |
| 1         | Package scaffold + types               | 5         | —              | 1       |
| 2         | CountingSemaphore                      | 2         | 1              | 1       |
| 3         | InProcessExecutionRuntime              | 2         | 1              | 1       |
| 4         | createChildSession + createExecutionId | 2         | 1              | 1       |
| 5         | Add llmClient to AgentThread           | —         | 1              | 1       |
| 6         | Add executionId to TraceEvent          | —         | 1              | 1       |
| 7         | **Refactor handleFanOut** (core)       | 1 test    | 2              | 1       |
| 8         | Integration tests                      | 1 test    | —              | 1       |
| 9         | Regression verification                | —         | 0-1            | 0-1     |
| **Total** |                                        | **13**    | **7-8**        | **8-9** |

### What Was Removed (vs Previous Plan)

| Removed                                          | Why                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `InMemoryEventBus` (old Task 2)                  | `onTraceEvent` callback already streams events to WebSocket. No new infrastructure needed.         |
| `ExecutionEventBus` interface                    | Deferred to Phase 2 (per-child text streaming) or Phase 3 (Restate cross-process relay).           |
| `eventBus` field on `ExecutionContext`           | `ExecutionContext` type itself deferred — not used in Phase 1. Executors keep existing signatures. |
| Event emission in ReasoningExecutor (old Task 9) | `onTraceEvent` already emits from reasoning loop. Adding `executionId` to `data` is sufficient.    |

### What Streams in Phase 1 (via existing `onTraceEvent`)

| Event                   | Source                      | Client Can Render                         |
| ----------------------- | --------------------------- | ----------------------------------------- |
| `fan_out_start`         | handleFanOut                | "Starting parallel execution of 3 agents" |
| `fan_out_task_start`    | handleFanOut per child      | "Agent_A: started"                        |
| `llm_call`              | ReasoningExecutor per child | "Agent_A: calling LLM..."                 |
| `tool_call`             | ReasoningExecutor per child | "Agent_A: searching flights..."           |
| `fan_out_task_complete` | handleFanOut per child      | "Agent_A: completed (1.2s)"               |
| `fan_out_complete`      | handleFanOut                | "All agents finished: 2/3 succeeded"      |

All events carry `data.executionId` and `data.agentName` for client-side grouping.

### Phase 2 Preview (Not in This Plan)

- `ExecutionEventBus` for per-child text streaming (onChunk with agent identity)
- `ExecutionContext` parameter replacing `session` + `onChunk` + `onTraceEvent` in executor signatures
- Migrate delegate/handoff to use `ExecutionRuntime` (single-unit plans)
- Reasoning thought streaming via provider-specific extended_thinking
- `RestateExecutionRuntime` stub with awakeable seam
