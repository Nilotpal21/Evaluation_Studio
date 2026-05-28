# Agent Transfer Critical Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the 3 production-blocking items from the call-flow gap analysis: wire handleEscalate→agent-transfer, add auth middleware to unprotected routes, and fix Phase 1 false-done tasks (TOCTOU, leader election, auth refresh).

**Architecture:** Each fix is self-contained. Task 1 wires the runtime escalation handler to the agent-transfer package. Task 2 adds auth middleware + route registration to server.ts. Tasks 3-5 fix Redis atomicity and auth refresh stubs in the agent-transfer package.

**Tech Stack:** TypeScript, Redis Lua scripts, Express middleware, ioredis

---

## Task 1: Wire handleEscalate() → Agent-Transfer Package (SHOWSTOPPER)

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:2365-2385`
- Test: `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts` (create)

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock agent-transfer singletons BEFORE importing routing-executor
vi.mock('../../services/agent-transfer/index.js', () => ({
  getAdapterRegistry: vi.fn(),
  getTransferSessionStore: vi.fn(),
  isAgentTransferInitialized: vi.fn(),
}));

import { RoutingExecutor } from '../services/execution/routing-executor.js';
import {
  getAdapterRegistry,
  getTransferSessionStore,
  isAgentTransferInitialized,
} from '../services/agent-transfer/index.js';

function createMockSession(overrides = {}) {
  return {
    id: 'sess-1',
    agentName: 'test-agent',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    data: { values: {} },
    conversationHistory: [],
    initialized: true,
    traceVerbosity: 'standard',
    agentIR: {
      coordination: {
        escalation: {
          triggers: [],
          context_for_human: [],
          on_human_complete: [],
          routing: {
            connection: 'kore',
            queue: 'support',
            skills: ['billing'],
            priority: 3,
            post_agent: 'return',
          },
        },
      },
    },
    ...overrides,
  } as any;
}

describe('handleEscalate → agent-transfer wiring', () => {
  let executor: RoutingExecutor;
  const mockExecute = vi.fn();
  const mockCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new RoutingExecutor();

    // Default: agent-transfer initialized with working adapter + store
    (isAgentTransferInitialized as any).mockReturnValue(true);
    (getAdapterRegistry as any).mockReturnValue({
      get: vi.fn().mockReturnValue({
        name: 'kore',
        execute: mockExecute,
      }),
    });
    (getTransferSessionStore as any).mockReturnValue({
      create: mockCreate,
    });
    mockCreate.mockResolvedValue({ success: true, sessionKey: 'at:tenant-1:c1:chat' });
    mockExecute.mockResolvedValue({ success: true, status: 'queued', providerSessionId: 'prov-1' });
  });

  it('calls adapter.execute when routing is configured', () => {
    const session = createMockSession();
    const result = executor.handleEscalate(session, { reason: 'Customer needs billing help' });

    expect(result.success).toBe(true);
    // handleEscalate is sync but kicks off async transfer — check session state
    expect(session.isEscalated).toBe(true);
    expect(session.transferInitiated).toBe(true);
  });

  it('still succeeds when agent-transfer is not initialized (HITL fallback)', () => {
    (isAgentTransferInitialized as any).mockReturnValue(false);
    const session = createMockSession();
    const result = executor.handleEscalate(session, { reason: 'Needs human help' });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
    expect(session.transferInitiated).toBeUndefined();
  });

  it('still succeeds when routing config is absent (HITL fallback)', () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          escalation: {
            triggers: [],
            context_for_human: [],
            on_human_complete: [],
            // no routing
          },
        },
      },
    });
    const result = executor.handleEscalate(session, { reason: 'Basic escalation' });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
    expect(session.transferInitiated).toBeUndefined();
  });

  it('still succeeds when adapter is not found (HITL fallback)', () => {
    (getAdapterRegistry as any).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
    });
    const session = createMockSession();
    const result = executor.handleEscalate(session, { reason: 'Adapter missing' });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd apps/runtime && npx vitest run src/__tests__/escalation-transfer-wiring.test.ts`
Expected: FAIL — `session.transferInitiated` is undefined (wiring doesn't exist yet)

### Step 3: Implement the wiring

In `apps/runtime/src/services/execution/routing-executor.ts`, after line 2381 (the trace event block), add the agent-transfer wiring before the return statement at line 2384.

Add this import at the top of routing-executor.ts (near the other agent-transfer imports, or use inline import to avoid circular deps):

```typescript
import {
  isAgentTransferInitialized,
  getAdapterRegistry,
  getTransferSessionStore,
} from '../services/agent-transfer/index.js';
```

Replace the return at line 2384 with:

```typescript
// ─── Agent-Transfer Wiring ───────────────────────────────────────
// If routing config exists and agent-transfer is initialized, kick off
// the transfer asynchronously. The escalation still succeeds immediately
// (HITL fallback) — the transfer is best-effort on top.
const routing = escalationConfig.routing;
if (routing?.connection && isAgentTransferInitialized()) {
  const registry = getAdapterRegistry();
  const store = getTransferSessionStore();
  const adapter = registry?.get(routing.connection);

  if (adapter && store) {
    session.transferInitiated = true;

    // Fire-and-forget: create session + execute transfer
    // Errors are logged but don't fail the escalation
    void (async () => {
      try {
        const createResult = await store.create({
          tenantId: session.tenantId,
          contactId: session.id,
          channel: 'chat',
          provider: routing.connection,
          agentId: session.agentName,
          ownerPod: process.env.HOSTNAME || 'unknown',
          projectId: session.projectId,
          queue: routing.queue,
          skills: routing.skills,
          priority: routing.priority,
          postAgentConfig: routing.post_agent ? { action: routing.post_agent } : undefined,
          metadata: { reason, priority },
        });

        if (!createResult.success) {
          log.warn('Transfer session creation failed', {
            error: createResult.error,
            agentName: session.agentName,
            tenantId: session.tenantId,
          });
          return;
        }

        const transferResult = await adapter.execute({
          tenantId: session.tenantId,
          projectId: session.projectId || '',
          agentId: session.agentName,
          contactId: session.id,
          sessionId: createResult.sessionKey || '',
          channel: 'chat',
          queue: routing.queue,
          skills: routing.skills,
          priority: routing.priority,
          conversationHistory: session.conversationHistory.map(
            (m: { role: string; content: unknown }) => ({
              role: m.role as 'user' | 'assistant',
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            }),
          ),
          metadata: { reason, priority },
          postAgentAction: routing.post_agent,
        });

        if (onTraceEvent) {
          onTraceEvent({
            type: 'agent_transfer_initiated',
            data: {
              success: transferResult.success,
              status: transferResult.status,
              provider: routing.connection,
              sessionKey: createResult.sessionKey,
              providerSessionId: transferResult.providerSessionId,
              queue: routing.queue,
            },
          });
        }

        if (!transferResult.success) {
          log.warn('Agent transfer execution failed', {
            error: transferResult.error,
            provider: routing.connection,
            agentName: session.agentName,
          });
        }
      } catch (err) {
        log.error('Agent transfer wiring error', {
          error: err instanceof Error ? err.message : String(err),
          provider: routing.connection,
          agentName: session.agentName,
          tenantId: session.tenantId,
        });
      }
    })();
  }
}

return { success: true, message };
```

**IMPORTANT**: `handleEscalate` stays synchronous (returns `{ success, message }`). The transfer is fire-and-forget via void async IIFE. The escalation always succeeds immediately; the transfer runs in the background.

### Step 4: Run test to verify it passes

Run: `cd apps/runtime && npx vitest run src/__tests__/escalation-transfer-wiring.test.ts`
Expected: PASS

### Step 5: Run full runtime test suite

Run: `cd apps/runtime && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All existing tests still pass

### Step 6: Commit

```bash
npx prettier --write apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts
git add apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts
git commit -m "feat(runtime): wire handleEscalate to agent-transfer package

handleEscalate now reads escalationConfig.routing, resolves the adapter
from the registry, creates a transfer session, and calls adapter.execute()
as a fire-and-forget async operation. Falls back to HITL-only escalation
when agent-transfer is not initialized or adapter is missing."
```

---

## Task 2: Add Auth Middleware to Agent-Transfer Routes (SECURITY CRITICAL)

**Files:**

- Modify: `apps/runtime/src/routes/agent-transfer-sessions.ts:1-19`
- Modify: `apps/runtime/src/routes/agent-transfer-settings.ts:1-18`
- Modify: `apps/runtime/src/server.ts:378` (register routes)
- Test: `apps/runtime/src/__tests__/agent-transfer-routes-authz.test.ts` (create)

### Step 1: Write the failing authz test

Create `apps/runtime/src/__tests__/agent-transfer-routes-authz.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';

describe('agent-transfer routes auth', () => {
  it('GET /api/v1/agent-transfer/sessions returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/v1/agent-transfer/sessions')
      .set('X-Tenant-Id', 'tenant-1')
      .set('X-Project-Id', 'project-1');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/agent-transfer/settings returns 401 without auth', async () => {
    const res = await request(app)
      .get('/api/v1/agent-transfer/settings')
      .set('X-Tenant-Id', 'tenant-1')
      .set('X-Project-Id', 'project-1');
    expect(res.status).toBe(401);
  });

  it('PUT /api/v1/agent-transfer/settings returns 401 without auth', async () => {
    const res = await request(app)
      .put('/api/v1/agent-transfer/settings')
      .set('X-Tenant-Id', 'tenant-1')
      .set('X-Project-Id', 'project-1')
      .send({ defaultTtl: 300 });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/agent-transfer/sessions/:id/end returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/v1/agent-transfer/sessions/some-key/end')
      .set('X-Tenant-Id', 'tenant-1')
      .set('X-Project-Id', 'project-1');
    expect(res.status).toBe(401);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd apps/runtime && npx vitest run src/__tests__/agent-transfer-routes-authz.test.ts`
Expected: FAIL — routes return 400/503 instead of 401 (no auth middleware), or 404 (routes not registered)

### Step 3: Add auth middleware to sessions route

In `apps/runtime/src/routes/agent-transfer-sessions.ts`, add imports and middleware:

```typescript
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
```

After `const router = Router();` (line 18), add:

```typescript
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
```

Inside GET handler (after line 30, before `isAgentTransferInitialized` check):

```typescript
if (!(await requireProjectPermission(req, res, 'connection:read'))) return;
```

Inside POST /:id/end handler (after line 131, before `isAgentTransferInitialized` check):

```typescript
if (!(await requireProjectPermission(req, res, 'connection:write'))) return;
```

### Step 4: Add auth middleware to settings route

In `apps/runtime/src/routes/agent-transfer-settings.ts`, add imports and middleware:

```typescript
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
```

After `const router = Router();` (line 17), add:

```typescript
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
```

Inside GET handler (after line 25, first line of handler):

```typescript
if (!(await requireProjectPermission(req, res, 'connection:read'))) return;
```

Inside PUT handler (after line 74, first line of handler):

```typescript
if (!(await requireProjectPermission(req, res, 'connection:write'))) return;
```

### Step 5: Register routes in server.ts

In `apps/runtime/src/server.ts`, after line 378 (`app.use('/api/v1/agent-transfer/webhooks', ...)`), add:

```typescript
import agentTransferSessionsRouter from './routes/agent-transfer-sessions.js';
import agentTransferSettingsRouter from './routes/agent-transfer-settings.js';
app.use('/api/v1/agent-transfer/sessions', agentTransferSessionsRouter);
app.use('/api/v1/agent-transfer/settings', agentTransferSettingsRouter);
```

### Step 6: Add schema validation to PUT /settings

In `apps/runtime/src/routes/agent-transfer-settings.ts`, enhance the body validation in the PUT handler (after the existing `typeof body !== 'object'` check around line 100-105):

```typescript
if (body.defaultTtl !== undefined && typeof body.defaultTtl !== 'number') {
  return res.status(400).json({
    success: false,
    error: { code: 'INVALID_BODY', message: 'defaultTtl must be a number' },
  });
}
```

### Step 7: Run tests

Run: `cd apps/runtime && npx vitest run src/__tests__/agent-transfer-routes-authz.test.ts`
Expected: PASS

### Step 8: Commit

```bash
npx prettier --write apps/runtime/src/routes/agent-transfer-sessions.ts apps/runtime/src/routes/agent-transfer-settings.ts apps/runtime/src/server.ts apps/runtime/src/__tests__/agent-transfer-routes-authz.test.ts
git add apps/runtime/src/routes/agent-transfer-sessions.ts apps/runtime/src/routes/agent-transfer-settings.ts apps/runtime/src/server.ts apps/runtime/src/__tests__/agent-transfer-routes-authz.test.ts
git commit -m "fix(runtime): add auth middleware to agent-transfer sessions/settings routes

Routes were reachable without authentication. Add authMiddleware,
requireProjectPermission, and tenantRateLimit. Register routes in
server.ts (were previously unregistered). Add basic schema validation
to PUT /settings."
```

---

## Task 3: Fix Session update() TOCTOU with Lua Script (Phase 1, Task 1)

**Files:**

- Modify: `packages/agent-transfer/src/session/lua-scripts.ts` (add LUA_UPDATE_SESSION)
- Modify: `packages/agent-transfer/src/session/transfer-session-store.ts:164-213`
- Test: `packages/agent-transfer/src/__tests__/unit/session-update-toctou.test.ts` (create)

### Step 1: Write the failing test

Create `packages/agent-transfer/src/__tests__/unit/session-update-toctou.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('session update TOCTOU fix', () => {
  it('LUA_UPDATE_SESSION script exists and checks existence atomically', async () => {
    const { LUA_UPDATE_SESSION } = await import('../../session/lua-scripts.js');
    expect(LUA_UPDATE_SESSION).toBeDefined();
    expect(LUA_UPDATE_SESSION).toContain('EXISTS');
    expect(LUA_UPDATE_SESSION).toContain('HSET');
  });

  it('update() uses redis eval instead of separate exists+hmset', async () => {
    const mockRedis = {
      exists: vi.fn(),
      hmset: vi.fn(),
      // Redis eval for Lua scripts — standard atomic operation pattern
      eval: vi.fn().mockResolvedValue(1),
      defineCommand: vi.fn(),
    };
    const { TransferSessionStore } = await import('../../session/transfer-session-store.js');
    const store = new TransferSessionStore(mockRedis as any);

    await store.update('at:t:c:chat', { state: 'active' });

    // Should NOT call exists + hmset separately
    expect(mockRedis.exists).not.toHaveBeenCalled();
    expect(mockRedis.hmset).not.toHaveBeenCalled();
  });

  it('update() returns false when session was already deleted', async () => {
    const mockRedis = {
      // Redis eval returning 0 = session not found (Lua script result)
      eval: vi.fn().mockResolvedValue(0),
      defineCommand: vi.fn(),
    };
    const { TransferSessionStore } = await import('../../session/transfer-session-store.js');
    const store = new TransferSessionStore(mockRedis as any);

    const result = await store.update('at:t:c:chat', { state: 'active' });
    expect(result).toBe(false);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd packages/agent-transfer && npx vitest run src/__tests__/unit/session-update-toctou.test.ts`
Expected: FAIL — LUA_UPDATE_SESSION doesn't exist; update() still calls exists+hmset

### Step 3: Add LUA_UPDATE_SESSION to lua-scripts.ts

In `packages/agent-transfer/src/session/lua-scripts.ts`, add after `LUA_CLAIM_SESSION` (after line 147):

```typescript
/**
 * Atomic session update.
 *
 * Checks the session exists before updating, preventing TOCTOU race
 * where a session could be deleted between existence check and update.
 *
 * KEYS[1] = session hash key
 *
 * ARGV[1..N] = alternating field, value pairs for HSET
 *
 * Returns:
 *   1 = updated successfully
 *   0 = session not found (deleted between caller's intent and execution)
 */
export const LUA_UPDATE_SESSION = `
local sessionKey = KEYS[1]

-- Atomic check: session must exist
if redis.call('EXISTS', sessionKey) == 0 then
  return 0
end

-- Set all hash fields atomically
for i = 1, #ARGV, 2 do
  redis.call('HSET', sessionKey, ARGV[i], ARGV[i+1])
end

return 1
`;
```

### Step 4: Rewrite update() to use Lua script

In `packages/agent-transfer/src/session/transfer-session-store.ts`:

1. Add `LUA_UPDATE_SESSION` to the import from `./lua-scripts.js`
2. Replace the `update()` method (lines 164-213):

```typescript
  async update(key: string, fields: UpdateTransferSessionFields): Promise<boolean> {
    try {
      const updates: string[] = [];
      // Push field-value pairs as flat array for Lua ARGV
      updates.push('updatedAt', String(Date.now()));
      if (fields.state !== undefined) updates.push('state', fields.state);
      if (fields.metadata !== undefined) {
        const jsonMeta = JSON.stringify(fields.metadata);
        updates.push(
          'metadata',
          await this.encryptIfAvailable(jsonMeta, this.extractTenantIdFromKey(key)),
        );
      }
      if (fields.providerData !== undefined) {
        const jsonData = JSON.stringify(fields.providerData);
        updates.push(
          'providerData',
          await this.encryptIfAvailable(jsonData, this.extractTenantIdFromKey(key)),
        );
      }
      if (fields.lastHeartbeat !== undefined)
        updates.push('lastHeartbeat', String(fields.lastHeartbeat));
      if (fields.ownerPod !== undefined) updates.push('ownerPod', fields.ownerPod);
      if (fields.agentId !== undefined) updates.push('agentId', fields.agentId);
      if (fields.projectId !== undefined) updates.push('projectId', fields.projectId);
      if (fields.queue !== undefined) updates.push('queue', fields.queue);
      if (fields.skills !== undefined) updates.push('skills', JSON.stringify(fields.skills));
      if (fields.priority !== undefined) updates.push('priority', String(fields.priority));
      if (fields.postAgentConfig !== undefined)
        updates.push('postAgentConfig', JSON.stringify(fields.postAgentConfig));
      if (fields.csatSurveyType !== undefined)
        updates.push('csatSurveyType', fields.csatSurveyType);
      if (fields.csatDialogId !== undefined) updates.push('csatDialogId', fields.csatDialogId);
      if (fields.csatStartedAt !== undefined)
        updates.push('csatStartedAt', String(fields.csatStartedAt));
      if (fields.csatCompletedAt !== undefined)
        updates.push('csatCompletedAt', String(fields.csatCompletedAt));
      if (fields.dispositionCode !== undefined)
        updates.push('dispositionCode', fields.dispositionCode);
      if (fields.wrapUpNotes !== undefined) updates.push('wrapUpNotes', fields.wrapUpNotes);

      // Atomic check-and-update via Lua script (prevents TOCTOU race)
      const result = await withTimeout(
        this.redis.eval(LUA_UPDATE_SESSION, 1, key, ...updates),
        REDIS_TIMEOUT_MS,
      );
      return result === 1;
    } catch (err) {
      log.error('Failed to update transfer session', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
```

### Step 5: Run tests

Run: `cd packages/agent-transfer && npx vitest run src/__tests__/unit/session-update-toctou.test.ts`
Expected: PASS

### Step 6: Run full package tests

Run: `cd packages/agent-transfer && npx vitest run`
Expected: All pass

### Step 7: Commit

```bash
npx prettier --write packages/agent-transfer/src/session/lua-scripts.ts packages/agent-transfer/src/session/transfer-session-store.ts packages/agent-transfer/src/__tests__/unit/session-update-toctou.test.ts
git add packages/agent-transfer/src/session/lua-scripts.ts packages/agent-transfer/src/session/transfer-session-store.ts packages/agent-transfer/src/__tests__/unit/session-update-toctou.test.ts
git commit -m "fix(agent-transfer): replace session update EXISTS+HMSET with atomic Lua script

The update() method had a TOCTOU race: EXISTS check followed by separate
HMSET allowed a concurrent end() to delete the session between the two
calls. New LUA_UPDATE_SESSION script checks existence and updates fields
in a single atomic Redis operation."
```

---

## Task 4: Fix Leader Election TOCTOU (Phase 1, Task 2)

**Files:**

- Modify: `packages/agent-transfer/src/session/session-recovery-service.ts:159-183`
- Test: `packages/agent-transfer/src/__tests__/unit/leader-election-toctou.test.ts` (create)

### Step 1: Write the failing test

Create `packages/agent-transfer/src/__tests__/unit/leader-election-toctou.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('leader election TOCTOU fix', () => {
  it('renewal uses SET XX EX instead of separate EXPIRE call', async () => {
    const setCalls: Array<unknown[]> = [];
    const mockRedis = {
      set: vi.fn((...args: unknown[]) => {
        setCalls.push(args);
        // First call: NX fails (already leader from previous cycle)
        if (args.includes('NX')) return null;
        // Second call: XX succeeds (renewal)
        if (args.includes('XX')) return 'OK';
        return null;
      }),
      get: vi.fn().mockResolvedValue('pod-1'),
      expire: vi.fn(),
      smembers: vi.fn().mockResolvedValue([]),
    };

    const { SessionRecoveryService } = await import('../../session/session-recovery-service.js');

    const service = new SessionRecoveryService(
      mockRedis as any,
      null as any, // store
      {
        intervalMs: 30000,
        leaderTtlSeconds: 60,
        sessionTimeoutMs: 300000,
        maxRecoveriesPerCycle: 100,
      },
      'pod-1',
    );

    await service.tryBecomeLeader();

    // Should NOT use separate expire() for renewal
    expect(mockRedis.expire).not.toHaveBeenCalled();

    // Should use SET with XX for renewal
    const xxCall = setCalls.find((args) => args.includes('XX'));
    expect(xxCall).toBeDefined();
    expect(xxCall).toContain('EX');
  });

  it('yields leadership when another pod holds the key', async () => {
    const mockRedis = {
      set: vi.fn().mockResolvedValue(null), // NX fails
      get: vi.fn().mockResolvedValue('other-pod'), // Different pod is leader
      expire: vi.fn(),
      smembers: vi.fn().mockResolvedValue([]),
    };

    const { SessionRecoveryService } = await import('../../session/session-recovery-service.js');

    const service = new SessionRecoveryService(
      mockRedis as any,
      null as any,
      {
        intervalMs: 30000,
        leaderTtlSeconds: 60,
        sessionTimeoutMs: 300000,
        maxRecoveriesPerCycle: 100,
      },
      'pod-1',
    );

    await service.tryBecomeLeader();

    // Should not call SET XX (shouldn't try to renew someone else's leadership)
    const setCalls = (mockRedis.set as any).mock.calls;
    const xxCall = setCalls.find((args: unknown[]) => args.includes('XX'));
    expect(xxCall).toBeUndefined();
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd packages/agent-transfer && npx vitest run src/__tests__/unit/leader-election-toctou.test.ts`
Expected: FAIL — `expire` is called; no SET XX call exists

### Step 3: Fix tryBecomeLeader

In `packages/agent-transfer/src/session/session-recovery-service.ts`, replace the `tryBecomeLeader` method (lines 159-190):

```typescript
  async tryBecomeLeader(): Promise<void> {
    try {
      // Try to acquire leadership (NX = only if not exists)
      const acquired = await this.redis.set(
        RECOVERY_LEADER_KEY,
        this.hostname,
        'EX',
        this.config.leaderTtlSeconds,
        'NX',
      );

      if (acquired === 'OK') {
        this.isLeader = true;
        log.info('Acquired recovery leadership', { hostname: this.hostname });
        await this.recoverOrphanedSessions();
        return;
      }

      // NX failed — check if we are the current leader
      const currentLeader = await this.redis.get(RECOVERY_LEADER_KEY);
      if (currentLeader === this.hostname) {
        // Renew atomically: SET XX EX (only if key exists, with new TTL)
        // Single command replaces the old GET + separate EXPIRE pattern
        await this.redis.set(
          RECOVERY_LEADER_KEY,
          this.hostname,
          'EX',
          this.config.leaderTtlSeconds,
          'XX',
        );
        this.isLeader = true;
        await this.recoverOrphanedSessions();
      } else {
        this.isLeader = false;
      }
    } catch (err) {
      log.error('Leader election failed', {
        hostname: this.hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

### Step 4: Run tests

Run: `cd packages/agent-transfer && npx vitest run src/__tests__/unit/leader-election-toctou.test.ts`
Expected: PASS

### Step 5: Run full package tests

Run: `cd packages/agent-transfer && npx vitest run`
Expected: All pass

### Step 6: Commit

```bash
npx prettier --write packages/agent-transfer/src/session/session-recovery-service.ts packages/agent-transfer/src/__tests__/unit/leader-election-toctou.test.ts
git add packages/agent-transfer/src/session/session-recovery-service.ts packages/agent-transfer/src/__tests__/unit/leader-election-toctou.test.ts
git commit -m "fix(agent-transfer): replace leader election EXPIRE with SET XX EX

Leader TTL renewal used a separate EXPIRE call after GET, allowing the
key to expire or be taken over between the two calls. Now uses SET XX EX
for atomic TTL renewal in a single Redis command."
```

---

## Task 5: Implement Auth Token Refresh (Phase 1, Task 4)

**Files:**

- Modify: `packages/agent-transfer/src/adapters/auth/jwt.ts`
- Modify: `packages/agent-transfer/src/adapters/auth/oauth2-client.ts`
- Modify: `packages/agent-transfer/src/adapters/registry.ts:50-55` (fix invalidateAuth no-op)
- Existing test: `packages/agent-transfer/src/__tests__/unit/auth-refresh.test.ts` (already written, currently failing)

### Step 1: Run existing tests to see failures

Run: `cd packages/agent-transfer && npx vitest run src/__tests__/unit/auth-refresh.test.ts`
Expected: Multiple failures — tests expect refresh behavior but implementations return `existing` unchanged

### Step 2: Implement JWTAuth with tokenUrl support and refresh

Replace `packages/agent-transfer/src/adapters/auth/jwt.ts` entirely:

```typescript
import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';
import { assertAllowedUrl } from '../../security/ssrf-guard.js';

export class JWTAuth implements AuthProvider {
  cacheTTL = 55 * 60 * 1000;
  private storedConfig: ProviderConfig | null = null;

  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    this.storedConfig = config;

    const staticJwt = config.auth['jwt'];
    const tokenUrl = config.auth['tokenUrl'];

    if (staticJwt && typeof staticJwt === 'string') {
      return {
        type: 'jwt',
        token: staticJwt,
        headers: { authorization: `Bearer ${staticJwt}` },
        expiresAt: Date.now() + this.cacheTTL,
      };
    }

    if (tokenUrl && typeof tokenUrl === 'string') {
      return this.fetchToken(config);
    }

    throw new Error('JWTAuth requires auth.jwt or auth.tokenUrl');
  }

  async refresh(existing: AuthCredentials): Promise<AuthCredentials> {
    if (!this.storedConfig) return existing;

    const staticJwt = this.storedConfig.auth['jwt'];
    if (staticJwt && typeof staticJwt === 'string') {
      return {
        type: 'jwt',
        token: staticJwt,
        headers: { authorization: `Bearer ${staticJwt}` },
        expiresAt: Date.now() + this.cacheTTL,
      };
    }

    const tokenUrl = this.storedConfig.auth['tokenUrl'];
    if (tokenUrl && typeof tokenUrl === 'string') {
      return this.fetchToken(this.storedConfig);
    }

    return existing;
  }

  private async fetchToken(config: ProviderConfig): Promise<AuthCredentials> {
    const tokenUrl = config.auth['tokenUrl'] as string;
    await assertAllowedUrl(tokenUrl);

    const body: Record<string, string> = { grant_type: 'client_credentials' };
    if (config.auth['clientId']) body.client_id = config.auth['clientId'] as string;
    if (config.auth['clientSecret']) body.client_secret = config.auth['clientSecret'] as string;

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`JWT token request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      token?: string;
      expires_in?: number;
    };
    const token = data.access_token || data.token;
    if (!token) {
      throw new Error('JWT token endpoint returned no access_token or token field');
    }

    const expiresIn = data.expires_in ?? 3600;
    return {
      type: 'jwt',
      token,
      headers: { authorization: `Bearer ${token}` },
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}
```

### Step 3: Implement OAuth2ClientAuth refresh

Replace `packages/agent-transfer/src/adapters/auth/oauth2-client.ts` entirely:

```typescript
import type { ProviderConfig } from '../../config/schema.js';
import type { AuthCredentials } from '../../types.js';
import type { AuthProvider } from './interface.js';
import { assertAllowedUrl } from '../../security/ssrf-guard.js';

export class OAuth2ClientAuth implements AuthProvider {
  cacheTTL = 60 * 60 * 1000;
  private storedConfig: ProviderConfig | null = null;

  async authenticate(config: ProviderConfig): Promise<AuthCredentials> {
    this.storedConfig = config;
    return this.fetchToken(config);
  }

  async refresh(existing: AuthCredentials): Promise<AuthCredentials> {
    if (!this.storedConfig) return existing;
    return this.fetchToken(this.storedConfig);
  }

  private async fetchToken(config: ProviderConfig): Promise<AuthCredentials> {
    const clientId = config.auth['clientId'];
    const clientSecret = config.auth['clientSecret'];
    const tokenUrl = config.auth['tokenUrl'];
    if (!clientId || typeof clientId !== 'string')
      throw new Error('OAuth2ClientAuth requires auth.clientId');
    if (!clientSecret || typeof clientSecret !== 'string')
      throw new Error('OAuth2ClientAuth requires auth.clientSecret');
    if (!tokenUrl || typeof tokenUrl !== 'string')
      throw new Error('OAuth2ClientAuth requires auth.tokenUrl');

    await assertAllowedUrl(tokenUrl);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OAuth2 token request failed: ${response.status} ${body}`);
    }
    const data = (await response.json()) as { access_token: string; expires_in?: number };
    const expiresIn = data.expires_in ?? 3600;
    return {
      type: 'oauth2',
      token: data.access_token,
      headers: { authorization: `Bearer ${data.access_token}` },
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}
```

### Step 4: Fix AdapterRegistry.invalidateAuth no-op

In `packages/agent-transfer/src/adapters/registry.ts`, replace `invalidateAuth` method (lines 50-55):

```typescript
  invalidateAuth(providerName: string, tenantId: string): void {
    const adapter = this.adapters.get(providerName);
    if (!adapter) {
      log.warn('Cannot invalidate auth: adapter not found', { providerName });
      return;
    }
    if (typeof (adapter as any).invalidateAuth === 'function') {
      (adapter as any).invalidateAuth(tenantId);
    }
  }
```

### Step 5: Run existing tests

Run: `cd packages/agent-transfer && npx vitest run src/__tests__/unit/auth-refresh.test.ts`
Expected: ALL PASS (tests were pre-written for the intended behavior)

### Step 6: Run full package tests

Run: `cd packages/agent-transfer && npx vitest run`
Expected: All pass

### Step 7: Commit

```bash
npx prettier --write packages/agent-transfer/src/adapters/auth/jwt.ts packages/agent-transfer/src/adapters/auth/oauth2-client.ts packages/agent-transfer/src/adapters/registry.ts
git add packages/agent-transfer/src/adapters/auth/jwt.ts packages/agent-transfer/src/adapters/auth/oauth2-client.ts packages/agent-transfer/src/adapters/registry.ts
git commit -m "fix(agent-transfer): implement auth token refresh for JWT and OAuth2

JWTAuth now supports tokenUrl-based auth (fetch + refresh) alongside
static JWT (re-read + TTL renewal). OAuth2ClientAuth refresh re-fetches
from the token endpoint using stored config. AdapterRegistry.invalidateAuth
now actually delegates to the adapter instead of being a no-op."
```

---

## Verification

After all 5 tasks are complete:

1. **Build check**: `pnpm build` (from root)
2. **Runtime tests**: `cd apps/runtime && npx vitest run`
3. **Agent-transfer tests**: `cd packages/agent-transfer && npx vitest run`
4. **Compiler tests** (regression): `cd packages/compiler && npx vitest run`
