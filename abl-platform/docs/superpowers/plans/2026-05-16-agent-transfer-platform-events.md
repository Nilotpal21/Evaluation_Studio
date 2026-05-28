# Agent Transfer → Platform Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Agent Transfer lifecycle events, user/human-agent transcript messages, and ACW completions to `abl_platform.platform_events` (ClickHouse) via a composite TraceStore + EventStore adapter, leaving all existing MongoDB/Redis writes intact.

**Architecture:** A new `createEventStoreTraceAdapter` function in `apps/runtime/src/` wraps the existing `createTraceStoreAdapter` — it calls `traceStore.addEvent()` unchanged, then fire-and-forgets to `emitToEventStore()`. The `transferTraceEmitter` singleton is rewired to this composite adapter at boot. Lifecycle events are emitted at existing `AgentEvent` handler sites; transcript messages are emitted after `persistMessageRecord` succeeds; ACW completion is emitted via the composite adapter after the Redis session update.

**Tech Stack:** TypeScript, Zod, Vitest, `emitToEventStore` (runtime-internal), `TraceEventEmitter` + `TraceStoreHandle` (agent-transfer package)

---

## File Map

| File                                                                   | Action                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-kernel/src/constants/trace-event-registry.ts`         | Add `AGENT_TRANSFER_TRACE_EVENT_TYPES`, extend `TRACE_EVENT_GROUPS`, `ALL_TRACE_EVENT_TYPES`, `TRACE_EVENT_REGISTRY`               |
| `packages/observatory/src/schema/trace-event-mappings.ts`              | Add 7 `TRACE_TO_PLATFORM_TYPE` entries                                                                                             |
| `packages/eventstore/src/schema/events/agent-events.ts`                | Register 7 `agent.transfer.*` Zod schemas                                                                                          |
| `apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts` | **New file** — composite `TraceEventEmitter`                                                                                       |
| `apps/runtime/src/services/agent-transfer/index.ts`                    | Rewire adapter at boot; add `agent_connected`, `agent_disconnected`, `transfer_completed`, `csat_completed`, `acw_completed` emits |
| `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`   | Add DI constructor param; add `user_message` / `agent_response` EventStore emit after `persistMessageRecord`                       |
| `apps/runtime/src/services/execution/transfer-tool-executor.ts`        | Add `transfer_initiated` emit before `transferTool.execute()`; enrich `transfer_failed` with `runtimeSessionId`                    |

---

## Task 1: Extend Shared-Kernel Trace Event Registry

**Files:**

- Modify: `packages/shared-kernel/src/constants/trace-event-registry.ts`
- Test run: `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts` (existing — verifies no drift)

The `trace-event-mappings.test.ts` in observatory checks that every key in `TRACE_TO_PLATFORM_TYPE` is in `ALL_TRACE_EVENT_TYPES`. This task adds the new types there first so the observatory test stays green.

- [ ] **Step 1: Run the contract test to establish a green baseline**

```bash
pnpm build --filter=@agent-platform/shared-kernel
pnpm test --filter=@agent-platform/shared-kernel -- --run
```

Expected: All tests pass.

- [ ] **Step 2: Add `AGENT_TRANSFER_TRACE_EVENT_TYPES` constant and type**

In `packages/shared-kernel/src/constants/trace-event-registry.ts`, after the `AGENT_ASSIST_TRACE_EVENT_TYPES` block (~line 294):

```ts
export const AGENT_TRANSFER_TRACE_EVENT_TYPES = [
  'agent_transfer.transfer_initiated',
  'agent_transfer.agent_connected',
  'agent_transfer.transfer_completed',
  'agent_transfer.transfer_failed',
  'agent_transfer.agent_disconnected',
  'agent_transfer.csat_completed',
  'agent_transfer.acw_completed',
] as const;
export type AgentTransferTraceEventType = (typeof AGENT_TRANSFER_TRACE_EVENT_TYPES)[number];
```

- [ ] **Step 3: Add `agent_transfer` domain to `TRACE_EVENT_GROUPS`**

In `TRACE_EVENT_GROUPS` (currently ends with `agent_assist: AGENT_ASSIST_TRACE_EVENT_TYPES`), add:

```ts
agent_assist: AGENT_ASSIST_TRACE_EVENT_TYPES,
agent_transfer: AGENT_TRANSFER_TRACE_EVENT_TYPES,
```

- [ ] **Step 4: Spread into `ALL_TRACE_EVENT_TYPES`**

In the `ALL_TRACE_EVENT_TYPES` array (currently ends with `...AGENT_ASSIST_TRACE_EVENT_TYPES`), add:

```ts
  ...AGENT_ASSIST_TRACE_EVENT_TYPES,
  ...AGENT_TRANSFER_TRACE_EVENT_TYPES,
```

- [ ] **Step 5: Add to `TRACE_EVENT_REGISTRY`**

In the `TRACE_EVENT_REGISTRY = Object.freeze(Object.fromEntries([...]))` block (currently ends with `...registryEntriesForDomain('agent_assist', AGENT_ASSIST_TRACE_EVENT_TYPES)`), add:

```ts
    ...registryEntriesForDomain('agent_assist', AGENT_ASSIST_TRACE_EVENT_TYPES),
    ...registryEntriesForDomain('agent_transfer', AGENT_TRANSFER_TRACE_EVENT_TYPES),
```

- [ ] **Step 6: Build and run the contract test**

```bash
pnpm build --filter=@agent-platform/shared-kernel
pnpm test --filter=@agent-platform/shared-kernel -- --run
```

Expected: All tests pass, including `covers every canonical trace event with registry metadata`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared-kernel/src/constants/trace-event-registry.ts
git commit -m "[ABLP-511] feat(shared-kernel): register agent_transfer trace event types"
```

---

## Task 2: Add TRACE_TO_PLATFORM_TYPE Mappings

**Files:**

- Modify: `packages/observatory/src/schema/trace-event-mappings.ts`
- Test run: `packages/observatory/src/__tests__/trace-event-mappings.test.ts` (existing)

- [ ] **Step 1: Run the mappings test to establish a green baseline**

```bash
pnpm build --filter=@agent-platform/observatory
pnpm test --filter=@agent-platform/observatory -- --run
```

Expected: All tests pass.

- [ ] **Step 2: Add 7 entries to `TRACE_TO_PLATFORM_TYPE`**

In `packages/observatory/src/schema/trace-event-mappings.ts`, inside the `TRACE_TO_PLATFORM_TYPE` object (currently ends before `error: 'system.error'`), add after the last `voice_*` entry:

```ts
  voice_config_resolved: 'agent.voice.config_resolved',
  error: 'system.error',
  // ... existing entries ...
  action_handler_executed: 'flow.action_handler.executed',
  'agent_transfer.transfer_initiated': 'agent.transfer.initiated',
  'agent_transfer.agent_connected': 'agent.transfer.agent_connected',
  'agent_transfer.transfer_completed': 'agent.transfer.completed',
  'agent_transfer.transfer_failed': 'agent.transfer.failed',
  'agent_transfer.agent_disconnected': 'agent.transfer.agent_disconnected',
  'agent_transfer.csat_completed': 'agent.transfer.csat_completed',
  'agent_transfer.acw_completed': 'agent.transfer.acw_completed',
```

Place them at the end of the object, just before the closing `}`:

```ts
  action_handler_executed: 'flow.action_handler.executed',
  'agent_transfer.transfer_initiated': 'agent.transfer.initiated',
  'agent_transfer.agent_connected': 'agent.transfer.agent_connected',
  'agent_transfer.transfer_completed': 'agent.transfer.completed',
  'agent_transfer.transfer_failed': 'agent.transfer.failed',
  'agent_transfer.agent_disconnected': 'agent.transfer.agent_disconnected',
  'agent_transfer.csat_completed': 'agent.transfer.csat_completed',
  'agent_transfer.acw_completed': 'agent.transfer.acw_completed',
});
```

- [ ] **Step 3: Build and run the mappings test**

```bash
pnpm build --filter=@agent-platform/observatory
pnpm test --filter=@agent-platform/observatory -- --run
```

Expected: All tests pass. The `contains only canonical trace event types plus documented legacy aliases` test now passes because the new keys are in `ALL_TRACE_EVENT_TYPES` (added in Task 1). The `covers every expected platform category` test still passes because `agent.transfer.*` resolves to the `agent` category, already in the expected set.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write packages/observatory/src/schema/trace-event-mappings.ts
git add packages/observatory/src/schema/trace-event-mappings.ts
git commit -m "[ABLP-511] feat(observatory): map agent_transfer trace types to platform events"
```

---

## Task 3: Register Agent Transfer Event Schemas

**Files:**

- Modify: `packages/eventstore/src/schema/events/agent-events.ts`
- Create: `packages/eventstore/src/__tests__/agent-transfer-event-registration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/eventstore/src/__tests__/agent-transfer-event-registration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eventRegistry } from '../schema/index.js';

describe('agent.transfer event registration', () => {
  it('registers all 7 agent.transfer lifecycle events', () => {
    const expected = [
      'agent.transfer.initiated',
      'agent.transfer.agent_connected',
      'agent.transfer.completed',
      'agent.transfer.failed',
      'agent.transfer.agent_disconnected',
      'agent.transfer.csat_completed',
      'agent.transfer.acw_completed',
    ];
    for (const type of expected) {
      expect(eventRegistry.has(type), `missing: ${type}`).toBe(true);
    }
  });

  it('validates agent.transfer.initiated data', () => {
    const meta = eventRegistry.get('agent.transfer.initiated')!;
    const result = meta.schema.safeParse({
      provider: 'smartassist',
      channel: 'chat',
      runtimeSessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('validates agent.transfer.acw_completed data with dispositionCode and reason', () => {
    const meta = eventRegistry.get('agent.transfer.acw_completed')!;
    const result = meta.schema.safeParse({
      acwCloseReason: 'agent_closed',
      acwTimedOut: false,
      dispositionCode: 'resolved',
      reason: 'Customer issue was resolved.',
      provider: 'smartassist',
      channel: 'chat',
      transferSessionId: 'agent_transfer:t-1:s-1:chat',
      runtimeSessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('validates agent.transfer.failed data', () => {
    const meta = eventRegistry.get('agent.transfer.failed')!;
    const result = meta.schema.safeParse({
      errorCode: 'NO_AGENTS_AVAILABLE',
      errorMessage: 'No agents available',
      provider: 'smartassist',
      runtimeSessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('marks all agent.transfer events as non-PII', () => {
    const transferEvents = [
      'agent.transfer.initiated',
      'agent.transfer.agent_connected',
      'agent.transfer.completed',
      'agent.transfer.failed',
      'agent.transfer.agent_disconnected',
      'agent.transfer.csat_completed',
      'agent.transfer.acw_completed',
    ];
    for (const type of transferEvents) {
      const meta = eventRegistry.get(type)!;
      expect(meta.containsPII, `${type} should not contain PII`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm build --filter=@abl/eventstore
pnpm test --filter=@abl/eventstore -- --run agent-transfer-event-registration
```

Expected: FAIL — `missing: agent.transfer.initiated` (schemas not registered yet).

- [ ] **Step 3: Add 7 Zod schemas to `agent-events.ts`**

At the end of `packages/eventstore/src/schema/events/agent-events.ts`, append:

```ts
// ─── agent.transfer.initiated ─────────────────────────────────────────────

export const AgentTransferInitiatedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    queue: z.string().optional(),
    skills: z.array(z.string()).optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferInitiatedData = z.infer<typeof AgentTransferInitiatedDataSchema>;

eventRegistry.register('agent.transfer.initiated', AgentTransferInitiatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent transfer to human agent was initiated',
});

// ─── agent.transfer.agent_connected ──────────────────────────────────────

export const AgentTransferAgentConnectedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    agentName: z.string().optional(),
    agent_name: z.string().optional(),
    waitTimeMs: z.number().optional(),
    wait_time_ms: z.number().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferAgentConnectedData = z.infer<typeof AgentTransferAgentConnectedDataSchema>;

eventRegistry.register('agent.transfer.agent_connected', AgentTransferAgentConnectedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Human agent connected to the transfer session',
});

// ─── agent.transfer.completed ─────────────────────────────────────────────

export const AgentTransferCompletedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    durationMs: z.number().optional(),
    duration_ms: z.number().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferCompletedData = z.infer<typeof AgentTransferCompletedDataSchema>;

eventRegistry.register('agent.transfer.completed', AgentTransferCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent transfer session completed',
});

// ─── agent.transfer.failed ────────────────────────────────────────────────

export const AgentTransferFailedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    errorCode: z.string().optional(),
    error_code: z.string().optional(),
    errorMessage: z.string().optional(),
    error_message: z.string().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferFailedData = z.infer<typeof AgentTransferFailedDataSchema>;

eventRegistry.register('agent.transfer.failed', AgentTransferFailedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'Agent transfer to human agent failed',
});

// ─── agent.transfer.agent_disconnected ───────────────────────────────────

export const AgentTransferAgentDisconnectedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    reason: z.string().optional(),
    durationMs: z.number().optional(),
    duration_ms: z.number().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferAgentDisconnectedData = z.infer<
  typeof AgentTransferAgentDisconnectedDataSchema
>;

eventRegistry.register(
  'agent.transfer.agent_disconnected',
  AgentTransferAgentDisconnectedDataSchema,
  {
    version: '1.0.0',
    category: EVENT_CATEGORIES.AGENT,
    containsPII: false,
    description: 'Human agent disconnected from the transfer session',
  },
);

// ─── agent.transfer.csat_completed ───────────────────────────────────────

export const AgentTransferCsatCompletedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    score: z.number().optional(),
    feedback: z.string().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferCsatCompletedData = z.infer<typeof AgentTransferCsatCompletedDataSchema>;

eventRegistry.register('agent.transfer.csat_completed', AgentTransferCsatCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'CSAT survey completed after an agent transfer session',
});

// ─── agent.transfer.acw_completed ─────────────────────────────────────────

export const AgentTransferAcwCompletedDataSchema = z
  .object({
    provider: z.string().optional(),
    channel: z.string().optional(),
    acwCloseReason: z.enum(['timeout', 'agent_closed']).optional(),
    acwTimedOut: z.boolean().optional(),
    dispositionCode: z.string().optional(),
    reason: z.string().optional(),
    transferSessionId: z.string().optional(),
    runtimeSessionId: z.string().optional(),
    contactId: z.string().optional(),
  })
  .passthrough();

export type AgentTransferAcwCompletedData = z.infer<typeof AgentTransferAcwCompletedDataSchema>;

eventRegistry.register('agent.transfer.acw_completed', AgentTransferAcwCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.AGENT,
  containsPII: false,
  description: 'After Contact Work completed following an agent transfer',
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm build --filter=@abl/eventstore
pnpm test --filter=@abl/eventstore -- --run agent-transfer-event-registration
```

Expected: All 5 tests pass.

- [ ] **Step 5: Run full eventstore test suite to check for regressions**

```bash
pnpm test --filter=@abl/eventstore -- --run
```

Expected: All tests pass.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write \
  packages/eventstore/src/schema/events/agent-events.ts \
  packages/eventstore/src/__tests__/agent-transfer-event-registration.test.ts
git add \
  packages/eventstore/src/schema/events/agent-events.ts \
  packages/eventstore/src/__tests__/agent-transfer-event-registration.test.ts
git commit -m "[ABLP-511] feat(eventstore): register agent.transfer.* event schemas"
```

---

## Task 4: Create Composite EventStore Trace Adapter

**Files:**

- Create: `apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts`
- Create: `apps/runtime/src/services/agent-transfer/__tests__/eventstore-trace-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/runtime/src/services/agent-transfer/__tests__/eventstore-trace-adapter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TraceStoreHandle } from '@agent-platform/agent-transfer';
import type { EventStoreServices } from '@abl/eventstore';

const { mockEmitToEventStore } = vi.hoisted(() => ({
  mockEmitToEventStore: vi.fn(),
}));

vi.mock('../../trace/emit-to-eventstore.js', () => ({
  emitToEventStore: (...args: unknown[]) => mockEmitToEventStore(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
}));

import { createEventStoreTraceAdapter } from '../eventstore-trace-adapter.js';

const makeTraceStore = (): TraceStoreHandle & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    addEvent(_sessionId: string, event: unknown) {
      calls.push(event);
    },
  };
};

const makeEventStore = (): EventStoreServices =>
  ({
    emitter: { emit: vi.fn() },
  }) as unknown as EventStoreServices;

describe('createEventStoreTraceAdapter', () => {
  beforeEach(() => {
    mockEmitToEventStore.mockReset();
  });

  it('always calls traceStore.addEvent with the correct event shape', () => {
    const traceStore = makeTraceStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => null);

    adapter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1700000000000,
      data: { tenantId: 'tenant-1', projectId: 'project-1', provider: 'smartassist' },
    });

    expect(traceStore.calls).toHaveLength(1);
    const stored = traceStore.calls[0] as Record<string, unknown>;
    expect(stored.type).toBe('agent_transfer.transfer_initiated');
    expect(stored.timestamp).toBeInstanceOf(Date);
    expect(stored.data).toMatchObject({ tenantId: 'tenant-1', provider: 'smartassist' });
  });

  it('calls emitToEventStore when EventStore is available and tenantId is present', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => eventStore);

    adapter.emit({
      type: 'agent_transfer.agent_connected',
      timestamp: 1700000000000,
      data: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        runtimeSessionId: 'sess-abc',
        provider: 'smartassist',
        channel: 'chat',
      },
    });

    expect(mockEmitToEventStore).toHaveBeenCalledOnce();
    const opts = mockEmitToEventStore.mock.calls[0][0] as Record<string, unknown>;
    const event = opts.event as Record<string, unknown>;
    expect(event.type).toBe('agent_transfer.agent_connected');
    expect(event.tenantId).toBe('tenant-1');
    expect(event.projectId).toBe('project-1');
    expect(event.sessionId).toBe('sess-abc');
  });

  it('falls back to contactId as session_id when runtimeSessionId is absent', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => eventStore);

    adapter.emit({
      type: 'agent_transfer.transfer_failed',
      timestamp: 1700000000000,
      data: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        contactId: 'contact-1',
        provider: 'smartassist',
        channel: 'chat',
      },
    });

    expect(mockEmitToEventStore).toHaveBeenCalledOnce();
    const opts = mockEmitToEventStore.mock.calls[0][0] as Record<string, unknown>;
    const event = opts.event as Record<string, unknown>;
    expect(event.sessionId).toBe('contact-1');
  });

  it('skips EventStore emit when tenantId is missing', () => {
    const traceStore = makeTraceStore();
    const eventStore = makeEventStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => eventStore);

    adapter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1700000000000,
      data: { provider: 'smartassist' }, // no tenantId
    });

    expect(traceStore.calls).toHaveLength(1); // TraceStore still gets the event
    expect(mockEmitToEventStore).not.toHaveBeenCalled();
  });

  it('skips EventStore emit when getEventStoreFn returns null', () => {
    const traceStore = makeTraceStore();
    const adapter = createEventStoreTraceAdapter(traceStore, () => null);

    adapter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: 1700000000000,
      data: { tenantId: 'tenant-1', projectId: 'project-1' },
    });

    expect(traceStore.calls).toHaveLength(1);
    expect(mockEmitToEventStore).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run eventstore-trace-adapter
```

Expected: FAIL — `Cannot find module '../eventstore-trace-adapter.js'`.

- [ ] **Step 3: Create the composite adapter file**

Create `apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts`:

```ts
import type { TraceEventEmitter, TraceStoreHandle } from '@agent-platform/agent-transfer';
import { emitToEventStore } from '../trace/emit-to-eventstore.js';
import type { EventStoreServices } from '@abl/eventstore';
import { getEventStore } from '../eventstore-singleton.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('agent-transfer:eventstore-adapter');

export function createEventStoreTraceAdapter(
  traceStore: TraceStoreHandle,
  getEventStoreFn: () => EventStoreServices | null = getEventStore,
): TraceEventEmitter {
  return {
    emit(event) {
      const storeEventId = `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const storeEvent = {
        id: storeEventId,
        sessionId: 'agent-transfer',
        type: event.type,
        timestamp: new Date(event.timestamp),
        data: event.data,
      };

      const traceResult = traceStore.addEvent('agent-transfer', storeEvent);

      const eventStore = getEventStoreFn();
      if (eventStore) {
        const tenantId = typeof event.data.tenantId === 'string' ? event.data.tenantId : '';
        if (tenantId) {
          emitToEventStore({
            eventStore,
            event: {
              id: storeEventId,
              type: event.type,
              tenantId,
              projectId: typeof event.data.projectId === 'string' ? event.data.projectId : '',
              sessionId:
                typeof event.data.runtimeSessionId === 'string'
                  ? event.data.runtimeSessionId
                  : typeof event.data.contactId === 'string'
                    ? event.data.contactId
                    : undefined,
              timestamp: new Date(event.timestamp),
              data: event.data,
            },
          });
        } else {
          log.debug('Skipping EventStore emit — tenantId missing from transfer trace event', {
            type: event.type,
          });
        }
      }

      return traceResult;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run eventstore-trace-adapter
```

Expected: All 5 tests pass.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write \
  apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts \
  apps/runtime/src/services/agent-transfer/__tests__/eventstore-trace-adapter.test.ts
git add \
  apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts \
  apps/runtime/src/services/agent-transfer/__tests__/eventstore-trace-adapter.test.ts
git commit -m "[ABLP-511] feat(runtime): composite EventStore trace adapter for agent transfer"
```

---

## Task 5: Wire Composite Adapter and Lifecycle Emits in index.ts

**Files:**

- Modify: `apps/runtime/src/services/agent-transfer/index.ts`

This task has no dedicated unit test — the adapter itself is tested in Task 4. Manual smoke testing is required post-deploy.

- [ ] **Step 1: Update the `@agent-platform/agent-transfer` import**

In `apps/runtime/src/services/agent-transfer/index.ts`, find the import block from `'@agent-platform/agent-transfer'` (lines ~14–36). Replace `createTraceStoreAdapter` with `emitTransferTraceEvent`:

```ts
// BEFORE (line ~23):
  createTraceStoreAdapter,
// AFTER:
  emitTransferTraceEvent,
```

The full updated import block becomes:

```ts
import {
  TransferSessionStore,
  AdapterRegistry,
  KoreAdapter,
  Five9Adapter,
  SessionRecoveryService,
  type AgentTransferConfig,
  type SmartAssistClient,
  type TransferSessionStoreHandle,
  type TraceEventEmitter,
  TenantScopedSessionEncryptor,
  type SessionFieldEncryptor,
  type AgentEventType,
  type TransferChannel,
  normalizeTransferChannel,
  resolveTransferSessionOwnerId,
  sessionKey,
  ACTIVE_SESSIONS_SET,
  CsatHandler,
  type SessionStoreHandle as CsatSessionStoreHandle,
  type UpdateTransferSessionFields,
  emitTransferTraceEvent,
} from '@agent-platform/agent-transfer';
```

- [ ] **Step 2: Add import for the composite adapter**

After the existing local imports (e.g., `import { buildProductionSessionLocator } from '../session/execution-scope.js';`), add:

```ts
import { createEventStoreTraceAdapter } from './eventstore-trace-adapter.js';
```

- [ ] **Step 3: Rewire the adapter at boot**

Around line 625, replace:

```ts
transferTraceEmitter = createTraceStoreAdapter(traceStore, 'agent-transfer');
```

with:

```ts
transferTraceEmitter = createEventStoreTraceAdapter(traceStore);
```

Also update the surrounding log message for clarity:

```ts
transferTraceEmitter = createEventStoreTraceAdapter(traceStore);
log.info('Transfer trace emitter wired (TraceStore + EventStore composite)');
```

- [ ] **Step 4: Add `agent_connected` emit**

After the existing `agent:connected` voice session state update block (~line 371), add:

```ts
if (event.type === 'agent:connected' && session.channel === 'voice') {
  // ... existing voice state update code ...
}

// Emit agent_connected trace (all channels)
if (event.type === 'agent:connected' && transferTraceEmitter) {
  void Promise.resolve(
    transferTraceEmitter.emit({
      type: 'agent_transfer.agent_connected',
      timestamp: Date.now(),
      data: {
        tenantId: session.tenantId,
        projectId: session.projectId ?? '',
        contactId: resolveTransferSessionOwnerId(session),
        provider: session.provider,
        channel: session.channel,
        runtimeSessionId,
        agentName: typeof event.data?.agentName === 'string' ? event.data.agentName : undefined,
        waitTimeMs: typeof event.data?.waitTimeMs === 'number' ? event.data.waitTimeMs : undefined,
      },
    }),
  ).catch((err) =>
    log.warn('Failed to emit agent_connected trace', {
      sessionId: runtimeSessionId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
```

Place this block immediately after the `agent:call_status` block (~line 396) and before `await bridge.routeAgentEvent(ablKey, ...)`.

- [x] **Step 5: Add `agent_disconnected`, `transfer_completed`, and ACW emit**

> **Post-implementation correction (2026-05-16):** The original design bundled `acw_completed`
> inside the `agent:disconnected` handler, assuming ACW data arrives with the disconnect signal.
> In practice, SmartAssist sends ACW data as a **separate `agent:message`** with `isACWEnabled: true`
> after the disconnect sequence completes. The implementation was corrected accordingly.

**`agent_disconnected` + `transfer_completed`** — emitted from `if (event.type === 'agent:disconnected')`,
guarded by `isFirstDisconnect` (session not yet `post_agent`). Selective SmartAssist fields are
extracted from `event.data` and included:

```ts
// Emit agent_disconnected (first disconnect only)
if (transferTraceEmitter && isFirstDisconnect) {
  const baseData = {
    tenantId: session.tenantId,
    projectId: session.projectId ?? '',
    contactId: resolveTransferSessionOwnerId(session),
    provider: session.provider,
    channel: session.channel,
    runtimeSessionId,
  };

  void Promise.resolve(
    transferTraceEmitter.emit({
      type: 'agent_transfer.agent_disconnected',
      timestamp: Date.now(),
      data: {
        ...baseData,
        originalType:
          typeof eventData?.originalType === 'string' ? eventData.originalType : undefined,
        syntheticDisconnect: eventData?.syntheticDisconnect === true ? true : undefined,
        isACWEnabled: eventData?.isACWEnabled === true || undefined,
        acwStartTime:
          typeof eventData?.acwStartTime === 'string' ? eventData.acwStartTime : undefined,
      },
    }),
  ).catch((err) =>
    log.warn('Failed to emit agent_disconnected trace', {
      sessionId: runtimeSessionId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  void Promise.resolve(
    transferTraceEmitter.emit({
      type: 'agent_transfer.transfer_completed',
      timestamp: Date.now(),
      data: { ...baseData, status: 'completed' },
    }),
  ).catch((err) =>
    log.warn('Failed to emit transfer_completed trace', {
      sessionId: runtimeSessionId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
```

**`acw_completed`** — emitted from a **separate `agent:message` handler** (not from `agent:disconnected`).
Guards: `isACWEnabled === true` + session `state === 'post_agent'` + `!acwCompletedEmitted` (exactly-once).
`acwCompletedEmitted` is written to Redis atomically before the emit.

```ts
// ACW data arrives as a separate agent:message after disconnect
if (event.type === 'agent:message' && transferTraceEmitter) {
  const msgData = event.data as Record<string, unknown> | undefined;
  if (msgData?.isACWEnabled === true) {
    const transferSession = await transferSessionStore!.get(ablKey);
    if (
      transferSession &&
      transferSession.channel !== 'voice' &&
      transferSession.state === 'post_agent' &&
      !transferSession.acwCompletedEmitted
    ) {
      const dispositionCode =
        typeof msgData.closeStatus === 'string' ? msgData.closeStatus : undefined;
      const wrapUpNotes =
        typeof msgData.closeRemarks === 'string' ? msgData.closeRemarks : undefined;
      const acwTimedOut = msgData.acwTimedOut === true;
      const acwCloseReason: 'timeout' | 'agent_closed' = acwTimedOut ? 'timeout' : 'agent_closed';
      const acwEventTimestamp =
        typeof msgData.timestamp === 'string' ? msgData.timestamp : undefined;

      await transferSessionStore!.update(ablKey, {
        acwEnabled: true,
        acwCompletedEmitted: true,
        acwTimedOut,
        acwCloseReason,
        acwEndedAt: Date.now(),
        ...(dispositionCode !== undefined ? { dispositionCode } : {}),
        ...(wrapUpNotes !== undefined ? { wrapUpNotes } : {}),
      });

      void Promise.resolve(
        transferTraceEmitter.emit({
          type: 'agent_transfer.acw_completed',
          timestamp: Date.now(),
          data: {
            tenantId: session.tenantId,
            projectId: session.projectId ?? '',
            contactId: resolveTransferSessionOwnerId(session),
            provider: session.provider,
            channel: session.channel,
            runtimeSessionId,
            acwCloseReason,
            acwTimedOut,
            dispositionCode,
            reason: wrapUpNotes,
            transferSessionId: ablKey,
            timestamp: acwEventTimestamp,
          },
        }),
      ).catch((err) =>
        log.warn('Failed to emit acw_completed trace', {
          sessionId: runtimeSessionId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
```

- [ ] **Step 6: Add `csat_completed` emit**

Inside the `bridge.setVoiceCsatRunner` callback, in the `onComplete` handler (~line 554):

```ts
        onComplete: (score) => {
          csatHandler.completeCsat(sessionId, sessionData, score).catch((err) => {
            log.error('CSAT completeCsat failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          // Emit csat_completed
          if (transferTraceEmitter) {
            const csatRuntimeSessionId =
              (voiceSession as { routing?: { runtimeSessionId?: string } }).routing
                ?.runtimeSessionId ?? sessionData.contactId;
            void Promise.resolve(
              transferTraceEmitter.emit({
                type: 'agent_transfer.csat_completed',
                timestamp: Date.now(),
                data: {
                  tenantId: event.tenantId,
                  projectId:
                    (voiceSession as { projectId?: string }).projectId ?? '',
                  contactId: csatData.userId,
                  provider: 'smartassist',
                  channel: csatData.channel,
                  runtimeSessionId: csatRuntimeSessionId,
                  score: typeof score === 'number' ? score : undefined,
                },
              }),
            ).catch((csatErr) =>
              log.warn('Failed to emit csat_completed trace', {
                sessionId,
                error: csatErr instanceof Error ? csatErr.message : String(csatErr),
              }),
            );
          }
        },
```

- [ ] **Step 7: Build and run the agent-transfer tests**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run
```

Expected: Existing tests still pass. No regressions.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/agent-transfer/index.ts
git add apps/runtime/src/services/agent-transfer/index.ts
git commit -m "[ABLP-511] feat(runtime): wire composite adapter and emit lifecycle events for agent transfer"
```

---

## Task 6: Add Message EventStore Emit in Transcript Persistence

**Files:**

- Modify: `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`
- Modify: `apps/runtime/src/services/agent-transfer/__tests__/transcript-persistence.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/runtime/src/services/agent-transfer/__tests__/transcript-persistence.test.ts`, after the existing mock setup blocks, add mocks for `getEventStore` and `emitToEventStore`:

```ts
const { mockGetEventStore, mockEmitToEventStore } = vi.hoisted(() => ({
  mockGetEventStore: vi.fn().mockReturnValue(null),
  mockEmitToEventStore: vi.fn(),
}));

vi.mock('../eventstore-singleton.js', () => ({
  getEventStore: () => mockGetEventStore(),
}));

vi.mock('../trace/emit-to-eventstore.js', () => ({
  emitToEventStore: (...args: unknown[]) => mockEmitToEventStore(...args),
}));
```

Then add the new test cases (after the existing `beforeEach`):

```ts
describe('EventStore emit for transfer messages', () => {
  const fakeEventStore = { emitter: { emit: vi.fn() } };

  beforeEach(() => {
    mockGetEventStore.mockReset().mockReturnValue(fakeEventStore);
    mockEmitToEventStore.mockReset();
    mockPersistMessageRecord.mockReset().mockResolvedValue(undefined);
    mockFindLatestMessageForSession.mockReset().mockResolvedValue(null);
  });

  const baseTransferSession = {
    tenantId: 'tenant-1',
    ownerId: 'runtime-1',
    contactId: 'contact-1',
    projectId: 'project-1',
    channel: 'chat' as const,
    provider: 'smartassist',
    providerSessionId: 'provider-1',
    state: 'active' as const,
    metadata: {},
    providerData: {},
    routing: {
      runtimeSessionId: 'runtime-1',
      conversationSessionId: 'conversation-1',
      resolvedContactId: 'contact-1',
      normalizedTransferChannel: 'chat' as const,
      sourceChannelType: 'sdk_websocket',
    },
  } as const;

  it('emits message.user.received (user_message trace type) to EventStore after user message persistence', async () => {
    const service = new AgentTransferTranscriptPersistenceService(() => fakeEventStore as any);
    await service.persistForwardedUserMessage({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: baseTransferSession as any,
      content: 'Hello, need help',
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledOnce();
    expect(mockEmitToEventStore).toHaveBeenCalledOnce();
    const opts = mockEmitToEventStore.mock.calls[0][0] as Record<string, unknown>;
    const event = opts.event as Record<string, unknown>;
    expect(event.type).toBe('user_message');
    expect(event.tenantId).toBe('tenant-1');
    expect(event.projectId).toBe('project-1');
    expect((event.data as Record<string, unknown>).contentLength).toBe(16);
    expect((event.data as Record<string, unknown>).source).toBe('agent-transfer');
    expect((event.data as Record<string, unknown>).participantType).toBe('user');
  });

  it('emits message.agent.sent (agent_response trace type) to EventStore after agent message persistence', async () => {
    const service = new AgentTransferTranscriptPersistenceService(() => fakeEventStore as any);
    await service.persistDeliveredAgentEvent({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: baseTransferSession as any,
      agentEvent: {
        type: 'agent:message',
        sessionId: 'provider-1',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: new Date().toISOString(),
        data: { message: 'Hi there, how can I help?' },
      },
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledOnce();
    expect(mockEmitToEventStore).toHaveBeenCalledOnce();
    const opts = mockEmitToEventStore.mock.calls[0][0] as Record<string, unknown>;
    const event = opts.event as Record<string, unknown>;
    expect(event.type).toBe('agent_response');
    expect((event.data as Record<string, unknown>).participantType).toBe('human_agent');
    expect((event.data as Record<string, unknown>).source).toBe('agent-transfer');
  });

  it('skips EventStore emit when EventStore is unavailable', async () => {
    const service = new AgentTransferTranscriptPersistenceService(() => null);
    await service.persistForwardedUserMessage({
      transferSessionId: 'agent_transfer:tenant-1:runtime-1:chat',
      transferSession: baseTransferSession as any,
      content: 'Hi',
    });

    expect(mockPersistMessageRecord).toHaveBeenCalledOnce();
    expect(mockEmitToEventStore).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run transcript-persistence
```

Expected: The 3 new tests FAIL because `AgentTransferTranscriptPersistenceService` doesn't yet accept a constructor parameter.

- [ ] **Step 3: Add imports to `transcript-persistence.ts`**

At the top of `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`, after the existing imports, add:

```ts
import { emitToEventStore } from '../trace/emit-to-eventstore.js';
import { getEventStore } from '../eventstore-singleton.js';
import type { EventStoreServices } from '@abl/eventstore';
```

- [ ] **Step 4: Add DI constructor parameter**

Change the class declaration from:

```ts
export class AgentTransferTranscriptPersistenceService {
  async persistForwardedUserMessage
```

to:

```ts
export class AgentTransferTranscriptPersistenceService {
  constructor(
    private readonly getEventStoreFn: () => EventStoreServices | null = getEventStore,
  ) {}

  async persistForwardedUserMessage
```

- [ ] **Step 5: Add EventStore emit after `persistMessageRecord`**

In the `persistTransferTranscriptMessage` private method, after the `await persistMessageRecord({...})` call (~line 432), add:

```ts
    await persistMessageRecord({
      dbSessionId: parentConversationSessionId,
      role: params.role,
      content: params.content,
      channel: resolveChannel(params.transferSession),
      tenantId,
      traceId: params.traceId,
      contactId: resolveContactId(params.transferSession),
      projectId: params.transferSession.projectId,
      messageTimestamp: params.messageTimestamp,
      metadata: params.metadata,
    });

    // Fire-and-forget: emit to EventStore (metadata only, no content)
    const eventStore = this.getEventStoreFn();
    if (eventStore) {
      emitToEventStore({
        eventStore,
        event: {
          id: `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: params.role === 'user' ? 'user_message' : 'agent_response',
          tenantId,
          projectId: params.transferSession.projectId ?? '',
          sessionId: parentConversationSessionId,
          timestamp: new Date(params.messageTimestamp ?? Date.now()),
          data: {
            contentLength: params.content.length,
            channel: resolveChannel(params.transferSession),
            participantType: params.role === 'user' ? 'user' : 'human_agent',
            source: 'agent-transfer',
            transferSessionId: params.transferSessionId,
            provider: params.transferSession.provider,
          },
        },
      });
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run transcript-persistence
```

Expected: All tests pass (existing + 3 new).

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write \
  apps/runtime/src/services/agent-transfer/transcript-persistence.ts \
  apps/runtime/src/services/agent-transfer/__tests__/transcript-persistence.test.ts
git add \
  apps/runtime/src/services/agent-transfer/transcript-persistence.ts \
  apps/runtime/src/services/agent-transfer/__tests__/transcript-persistence.test.ts
git commit -m "[ABLP-511] feat(runtime): emit message events to EventStore for agent transfer transcripts"
```

---

## Task 7: Add transfer_initiated Emit and Enrich transfer_failed

**Files:**

- Modify: `apps/runtime/src/services/execution/transfer-tool-executor.ts`
- Modify: `apps/runtime/src/__tests__/transfer-tool-executor.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/runtime/src/__tests__/transfer-tool-executor.test.ts`, add two new test cases (inside the existing `describe` block, after existing tests):

```ts
it('emits transfer_initiated trace event before executing the transfer tool', async () => {
  const mockEmitter = { emit: vi.fn().mockReturnValue(undefined) };
  const executor = createExecutorWithEmitter(mockEmitter);

  await executor.execute(
    'transfer_to_agent',
    { provider: 'smartassist', queueId: 'queue-1' },
    5000,
  );

  const initiatedCall = mockEmitter.emit.mock.calls.find(
    ([e]: [{ type: string }]) => e.type === 'agent_transfer.transfer_initiated',
  );
  expect(initiatedCall).toBeDefined();
  const data = initiatedCall[0].data as Record<string, unknown>;
  expect(data.runtimeSessionId).toBe('session-123'); // from context.sessionId
  expect(data.provider).toBe('smartassist');
});

it('includes runtimeSessionId in transfer_failed trace event data', async () => {
  mockTransferExecute.mockResolvedValueOnce({
    success: false,
    error: { code: 'NO_AGENTS', message: 'No agents available' },
  });
  const mockEmitter = { emit: vi.fn().mockReturnValue(undefined) };
  const executor = createExecutorWithEmitter(mockEmitter);

  await executor.execute('transfer_to_agent', { provider: 'smartassist' }, 5000);

  const failedCall = mockEmitter.emit.mock.calls.find(
    ([e]: [{ type: string }]) => e.type === 'agent_transfer.transfer_failed',
  );
  expect(failedCall).toBeDefined();
  const data = failedCall[0].data as Record<string, unknown>;
  expect(data.runtimeSessionId).toBe('session-123');
  expect(data.errorCode).toBe('NO_AGENTS');
});
```

Note: `createExecutorWithEmitter` is a test helper you'll define in the same describe block or as a local factory:

```ts
function createExecutorWithEmitter(emitter: { emit: ReturnType<typeof vi.fn> }) {
  return new TransferToolExecutor({
    resolveContext: async () => ({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      contactId: 'contact-1',
      sessionId: 'session-123',
      channel: 'chat',
      agentId: 'agent-1',
    }),
    traceEmitter: emitter as any,
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run transfer-tool-executor
```

Expected: The 2 new tests FAIL — `emits transfer_initiated` fails because no `transfer_initiated` event is emitted; `includes runtimeSessionId in transfer_failed` fails because `runtimeSessionId` is not in the failure event data.

- [ ] **Step 3: Add `transfer_initiated` emit before `transferTool.execute()`**

In `apps/runtime/src/services/execution/transfer-tool-executor.ts`, inside the `case 'transfer_to_agent':` block, after the log at ~line 305 and before the rate-limit check (~line 319), add:

```ts
log.info('Agent transfer initiated', {
  provider,
  tenantId: context.tenantId,
  // ... existing log fields ...
});

// Emit transfer_initiated trace
const initiatedEmitter = this.getTraceEmitter?.() ?? this.traceEmitter;
if (initiatedEmitter) {
  void Promise.resolve(
    initiatedEmitter.emit({
      type: 'agent_transfer.transfer_initiated',
      timestamp: Date.now(),
      data: {
        tenantId: context.tenantId,
        projectId: context.projectId ?? '',
        contactId: context.contactId,
        provider,
        channel: context.channel,
        runtimeSessionId: context.sessionId,
        queue: (params as Record<string, unknown>).queueId as string | undefined,
        skills: (params as Record<string, unknown>).skills as string[] | undefined,
      },
    }),
  ).catch((err) =>
    log.warn('Failed to emit transfer_initiated trace', {
      provider,
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

// Rate limit only the actual transfer, not pre-check tools
```

- [ ] **Step 4: Enrich `emitTransferFailedTrace` with `runtimeSessionId`**

Replace the `emitTransferTraceEvent` call inside `emitTransferFailedTrace` with a direct `.emit()` call that includes `runtimeSessionId`:

```ts
  private emitTransferFailedTrace(
    context: TransferToolContext,
    provider: string,
    error: { code: string; message: string },
  ): void {
    const emitter = this.getTraceEmitter?.() ?? this.traceEmitter;
    if (!emitter) {
      return;
    }

    try {
      const emitted = emitter.emit({
        type: 'agent_transfer.transfer_failed',
        timestamp: Date.now(),
        data: {
          tenantId: context.tenantId,
          projectId: context.projectId ?? '',
          contactId: context.contactId,
          provider,
          channel: context.channel,
          runtimeSessionId: context.sessionId,
          errorCode: error.code,
          errorMessage: error.message,
        },
      });

      void Promise.resolve(emitted).catch((err) => {
        log.warn('Failed to emit agent transfer failure trace', {
          provider,
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      log.warn('Failed to emit agent transfer failure trace', {
        provider,
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

With this change, `emitTransferTraceEvent` is no longer called from `emitTransferFailedTrace`. If it's not used anywhere else in the file, remove it from the import:

```ts
// REMOVE from import if no longer used:
  emitTransferTraceEvent,
```

Check if `emitTransferTraceEvent` is used elsewhere in the file before removing:

```bash
grep -n "emitTransferTraceEvent" apps/runtime/src/services/execution/transfer-tool-executor.ts
```

If it only appears in `emitTransferFailedTrace` (which you just replaced), remove it from the import.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run transfer-tool-executor
```

Expected: All tests pass, including the 2 new ones.

- [ ] **Step 6: Run the full runtime test suite**

```bash
pnpm test --filter=@agent-platform/runtime -- --run
```

Expected: All tests pass. No regressions.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write \
  apps/runtime/src/services/execution/transfer-tool-executor.ts \
  apps/runtime/src/__tests__/transfer-tool-executor.test.ts
git add \
  apps/runtime/src/services/execution/transfer-tool-executor.ts \
  apps/runtime/src/__tests__/transfer-tool-executor.test.ts
git commit -m "[ABLP-511] feat(runtime): emit transfer_initiated and enrich transfer_failed with runtimeSessionId"
```

---

## Final Verification

- [ ] **Build all touched packages**

```bash
pnpm build --filter=@agent-platform/shared-kernel \
           --filter=@agent-platform/observatory \
           --filter=@abl/eventstore \
           --filter=@agent-platform/runtime
```

Expected: No TypeScript errors across all packages.

- [ ] **Run all affected test suites**

```bash
pnpm test --filter=@agent-platform/shared-kernel -- --run
pnpm test --filter=@agent-platform/observatory -- --run
pnpm test --filter=@abl/eventstore -- --run
pnpm test --filter=@agent-platform/runtime -- --run
```

Expected: All tests pass.

---

## Self-Review Checklist

- [x] **Spec coverage**: All 3 categories from the spec are covered — lifecycle events (Task 4+5), message events (Task 6), ACW events (Task 5 Step 5).
- [x] **No placeholders**: Every step has complete code.
- [x] **Type consistency**: `runtimeSessionId` flows through all emitters consistently via `event.data.runtimeSessionId` — composite adapter reads it at line `typeof event.data.runtimeSessionId === 'string'`.
- [x] **No breaking changes**: All TraceStore and MongoDB writes are unchanged. EventStore writes are additive.
- [x] **PII guard**: `persistTransferTranscriptMessage` emits only `contentLength`, not the content itself.
- [x] **shared-kernel contract**: `TRACE_EVENT_REGISTRY` entries for all 7 new types added in Task 1, keeping `trace-event-contract.test.ts` green.
- [x] **agent-transfer package stays clean**: No EventStore dependency added to `packages/agent-transfer/`.
- [x] **DI pattern**: Both `createEventStoreTraceAdapter` and `AgentTransferTranscriptPersistenceService` accept `getEventStoreFn` for testability without module mocking.
- [x] **ACW architecture corrected**: `acw_completed` is emitted from a separate `agent:message` handler (not bundled in `agent:disconnected`). SmartAssist sends ACW disposition data as a subsequent `agent:message` with `isACWEnabled: true` after the disconnect sequence.
- [x] **Exactly-once ACW guard**: `acwCompletedEmitted` flag written to Redis before emit prevents duplicate `acw_completed` events across SmartAssist's triple-disconnect pattern.
- [x] **agent_disconnected selective fields**: `originalType`, `syntheticDisconnect`, `isACWEnabled`, `acwStartTime` (ISO string) extracted from SmartAssist event data and included in the event.
- [x] **acw_completed timestamp**: `timestamp` field sourced from `event.data.timestamp` (SmartAssist ISO string), not computed locally.
- [x] **EventStore schemas updated**: `AgentTransferAgentDisconnectedDataSchema` and `AgentTransferAcwCompletedDataSchema` in `packages/eventstore/src/schema/events/agent-events.ts` extended with all new fields.
