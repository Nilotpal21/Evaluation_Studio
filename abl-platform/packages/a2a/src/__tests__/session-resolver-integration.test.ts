/**
 * Session Resolver Integration Tests
 *
 * Covers:
 * - Multi-Turn Session Continuity (5 items)
 * - Session Resolver Lifecycle (4 items)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { MemoryA2ASessionResolver } from '../infrastructure/memory-a2a-session-resolver.js';
import { RedisA2ASessionResolver } from '../infrastructure/redis-a2a-session-resolver.js';
import {
  AgentExecutorAdapter,
  a2aContextStorage,
} from '../infrastructure/agent-executor-adapter.js';
import type {
  A2ATracingPort,
  AgentExecutionPort,
  A2ASessionResolverPort,
  A2ARequestContext,
} from '../domain/ports.js';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message } from '@a2a-js/sdk';

// =============================================================================
// HELPERS
// =============================================================================

const TENANT_ID = 'tenant-test';
const CONTEXT_ID = 'ctx-abc';
const SESSION_ID = 'session-123';

function makeRequestContext(text: string, contextId = CONTEXT_ID): RequestContext {
  return {
    userMessage: {
      kind: 'message',
      messageId: 'msg-1',
      role: 'user',
      parts: [{ kind: 'text', text }],
    } as Message,
    taskId: `task-${Date.now()}`,
    contextId,
  } as RequestContext;
}

function makeEventBus(): ExecutionEventBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  } as unknown as ExecutionEventBus;
}

function makeTracing(): A2ATracingPort {
  return {
    traceOutbound: vi.fn(),
    traceInbound: vi.fn(),
  };
}

function makeExecutionPort(overrides?: Partial<AgentExecutionPort>): AgentExecutionPort {
  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'Hello',
      action: { type: 'complete' },
    }),
    getSessionDetail: vi.fn().mockReturnValue(null),
    createSession: vi.fn().mockResolvedValue(SESSION_ID),
    ...overrides,
  } as AgentExecutionPort;
}

function makeA2AContext(tenantId = TENANT_ID): A2ARequestContext {
  return {
    tenantId,
    projectId: 'project-1',
    connectionId: 'conn-1',
  };
}

// =============================================================================
// MULTI-TURN SESSION CONTINUITY
// =============================================================================

describe('Multi-Turn Session Continuity', () => {
  let resolver: MemoryA2ASessionResolver;

  beforeEach(() => {
    resolver = new MemoryA2ASessionResolver({ ttlMs: 5000, cleanupIntervalMs: 60_000 });
  });

  afterEach(() => {
    resolver.destroy();
  });

  // Item 1: New session on first turn
  it('returns isNew: true on first resolve for a contextId', async () => {
    const result = await resolver.resolveSession(CONTEXT_ID, TENANT_ID);
    expect(result.isNew).toBe(true);
    expect(result.sessionId).toBe('');
  });

  // Item 2: Same session on follow-up turns
  it('returns isNew: false with same sessionId after register', async () => {
    // First turn: register
    await resolver.registerSession(CONTEXT_ID, TENANT_ID, SESSION_ID);

    // Follow-up turn: resolve returns existing session
    const result = await resolver.resolveSession(CONTEXT_ID, TENANT_ID);
    expect(result.isNew).toBe(false);
    expect(result.sessionId).toBe(SESSION_ID);
  });

  // Item 3: Terminal state cleanup — completed does NOT close sessions (multi-turn),
  //         only failed triggers closeSession
  it('completed tasks do NOT close session mapping (multi-turn support)', async () => {
    const executionPort = makeExecutionPort();
    const tracing = makeTracing();
    const eventBus = makeEventBus();
    const a2aContext = makeA2AContext();

    const adapter = new AgentExecutorAdapter({
      agentName: 'test-agent',
      executionPort,
      tracing,
      sessionResolver: resolver,
    });

    // Register a session mapping
    await resolver.registerSession(CONTEXT_ID, TENANT_ID, SESSION_ID);

    // Execute a task that completes successfully
    await a2aContextStorage.run(a2aContext, async () => {
      await adapter.execute(makeRequestContext('turn 1'), eventBus);
    });

    // Session mapping must still exist after completion
    const afterComplete = await resolver.resolveSession(CONTEXT_ID, TENANT_ID);
    expect(afterComplete.isNew).toBe(false);
    expect(afterComplete.sessionId).toBe(SESSION_ID);
  });

  it('failed tasks close session mapping via closeSession', async () => {
    const executionPort = makeExecutionPort({
      executeMessage: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const tracing = makeTracing();
    const eventBus = makeEventBus();
    const a2aContext = makeA2AContext();

    const adapter = new AgentExecutorAdapter({
      agentName: 'test-agent',
      executionPort,
      tracing,
      sessionResolver: resolver,
    });

    // Register a session mapping
    await resolver.registerSession(CONTEXT_ID, TENANT_ID, SESSION_ID);

    // Execute a task that fails — should close session
    await expect(
      a2aContextStorage.run(a2aContext, () =>
        adapter.execute(makeRequestContext('fail'), eventBus),
      ),
    ).rejects.toThrow('boom');

    // Session mapping should be removed after failure
    const afterFail = await resolver.resolveSession(CONTEXT_ID, TENANT_ID);
    expect(afterFail.isNew).toBe(true);
  });

  // Item 4: Session TTL expiry
  it('evicts session mapping after TTL, next resolve returns isNew: true', async () => {
    const shortTtlResolver = new MemoryA2ASessionResolver({
      ttlMs: 50,
      cleanupIntervalMs: 60_000,
    });

    try {
      await shortTtlResolver.registerSession(CONTEXT_ID, TENANT_ID, SESSION_ID);

      // Immediately resolvable
      const before = await shortTtlResolver.resolveSession(CONTEXT_ID, TENANT_ID);
      expect(before.isNew).toBe(false);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 80));

      // After TTL, should be treated as new
      const after = await shortTtlResolver.resolveSession(CONTEXT_ID, TENANT_ID);
      expect(after.isNew).toBe(true);
    } finally {
      shortTtlResolver.destroy();
    }
  });

  // Item 5: Streaming multi-turn — same contextId across multiple resolves preserves session
  it('same contextId across multiple resolves preserves session identity', async () => {
    await resolver.registerSession(CONTEXT_ID, TENANT_ID, SESSION_ID);

    // Simulate multiple turns resolving the same context
    for (let i = 0; i < 5; i++) {
      const result = await resolver.resolveSession(CONTEXT_ID, TENANT_ID);
      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe(SESSION_ID);
      await resolver.touchSession(CONTEXT_ID, TENANT_ID);
    }
  });
});

// =============================================================================
// SESSION RESOLVER LIFECYCLE
// =============================================================================

describe('Session Resolver Lifecycle', () => {
  // Item 6: Memory resolver at startup — handles resolution correctly
  it('MemoryA2ASessionResolver handles full resolve/register/touch/close lifecycle', async () => {
    const resolver = new MemoryA2ASessionResolver();
    try {
      // Resolve unknown context → isNew
      const r1 = await resolver.resolveSession('ctx-1', TENANT_ID);
      expect(r1.isNew).toBe(true);

      // Register
      await resolver.registerSession('ctx-1', TENANT_ID, 'sess-1');

      // Resolve again → existing
      const r2 = await resolver.resolveSession('ctx-1', TENANT_ID);
      expect(r2.isNew).toBe(false);
      expect(r2.sessionId).toBe('sess-1');

      // Touch (updates lastAccessed)
      await resolver.touchSession('ctx-1', TENANT_ID);

      // Close
      await resolver.closeSession('ctx-1', TENANT_ID);
      const r3 = await resolver.resolveSession('ctx-1', TENANT_ID);
      expect(r3.isNew).toBe(true);
    } finally {
      resolver.destroy();
    }
  });

  // Item 7: Redis upgrade — setSessionResolver swaps implementation
  it('setSessionResolver swaps resolver; new sessions use the new resolver', async () => {
    const memoryResolver = new MemoryA2ASessionResolver();
    const executionPort = makeExecutionPort();
    const tracing = makeTracing();

    const adapter = new AgentExecutorAdapter({
      agentName: 'test-agent',
      executionPort,
      tracing,
      sessionResolver: memoryResolver,
    });

    // Register session in memory resolver
    await memoryResolver.registerSession('ctx-mem', TENANT_ID, 'sess-mem');

    // Create a mock Redis resolver
    const redisResolver: A2ASessionResolverPort = {
      resolveSession: vi.fn().mockResolvedValue({ sessionId: 'sess-redis', isNew: false }),
      registerSession: vi.fn().mockResolvedValue(undefined),
      touchSession: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    // Swap to Redis
    adapter.setSessionResolver(redisResolver);

    // Now execute — should use the redis resolver, not memory
    const eventBus = makeEventBus();
    const a2aContext = makeA2AContext();

    await a2aContextStorage.run(a2aContext, async () => {
      await adapter.execute(makeRequestContext('hello', 'ctx-redis'), eventBus);
    });

    // Redis resolver should have been called
    expect(redisResolver.resolveSession).toHaveBeenCalledWith('ctx-redis', TENANT_ID);
    expect(redisResolver.touchSession).toHaveBeenCalledWith('ctx-redis', TENANT_ID);

    // Execution port should have received the redis session ID
    expect(executionPort.executeMessage).toHaveBeenCalledWith(
      'sess-redis',
      'hello',
      expect.objectContaining({ tenantId: TENANT_ID }),
    );

    memoryResolver.destroy();
  });

  // Item 8: Memory resolver eviction — when maxEntries hit, oldest entries are evicted
  it('evicts oldest entries when maxEntries is reached', async () => {
    const resolver = new MemoryA2ASessionResolver({
      maxEntries: 5,
      ttlMs: 60_000,
      cleanupIntervalMs: 60_000,
    });

    try {
      // Register 5 entries with staggered timestamps
      for (let i = 0; i < 5; i++) {
        await resolver.registerSession(`ctx-${i}`, TENANT_ID, `sess-${i}`);
      }

      // All 5 should exist
      for (let i = 0; i < 5; i++) {
        const r = await resolver.resolveSession(`ctx-${i}`, TENANT_ID);
        expect(r.isNew).toBe(false);
      }

      // Register a 6th entry — should trigger eviction of the oldest
      await resolver.registerSession('ctx-new', TENANT_ID, 'sess-new');

      // The newest should exist
      const rNew = await resolver.resolveSession('ctx-new', TENANT_ID);
      expect(rNew.isNew).toBe(false);
      expect(rNew.sessionId).toBe('sess-new');

      // At least one of the oldest should have been evicted
      // (evicts 10% = Math.max(1, floor(5 * 0.1)) = 1 entry)
      const allSessions = resolver.getAllSessions();
      expect(allSessions.size).toBeLessThanOrEqual(5);
    } finally {
      resolver.destroy();
    }
  });

  // Item 9: Redis resilience — transient Redis failure returns isNew: true, logs warning
  it('returns isNew: true on transient Redis failure (graceful degradation)', async () => {
    const mockRedis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      expire: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      del: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };

    const resolver = new RedisA2ASessionResolver({
      redis: mockRedis as any,
      ttlMinutes: 60,
    });

    // resolveSession should gracefully return isNew: true (not throw)
    const result = await resolver.resolveSession('ctx-fail', TENANT_ID);
    expect(result.isNew).toBe(true);
    expect(result.sessionId).toBe('');
  });

  it('Redis resolver registerSession throws on failure (write path is not silent)', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };

    const resolver = new RedisA2ASessionResolver({
      redis: mockRedis as any,
      ttlMinutes: 60,
    });

    // registerSession should throw (not silently fail) so the caller knows the write failed
    await expect(resolver.registerSession('ctx-x', TENANT_ID, 'sess-x')).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('Redis resolver touchSession and closeSession are resilient to failures', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue('sess-1'),
      set: vi.fn().mockResolvedValue('OK'),
      expire: vi.fn().mockRejectedValue(new Error('timeout')),
      del: vi.fn().mockRejectedValue(new Error('timeout')),
    };

    const resolver = new RedisA2ASessionResolver({
      redis: mockRedis as any,
      ttlMinutes: 60,
    });

    // These should NOT throw — they log warnings instead
    await expect(resolver.touchSession('ctx-x', TENANT_ID)).resolves.toBeUndefined();
    await expect(resolver.closeSession('ctx-x', TENANT_ID)).resolves.toBeUndefined();
  });
});

// =============================================================================
// ADAPTER + SESSION RESOLVER INTEGRATION
// =============================================================================

describe('Adapter resolveSessionId integration', () => {
  it('creates a new session via executionPort.createSession when resolver returns isNew', async () => {
    const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 60_000 });
    const newSessionId = 'new-sess-xyz';
    const executionPort = makeExecutionPort({
      createSession: vi.fn().mockResolvedValue(newSessionId),
    });
    const tracing = makeTracing();
    const eventBus = makeEventBus();
    const a2aContext = makeA2AContext();

    const adapter = new AgentExecutorAdapter({
      agentName: 'test-agent',
      executionPort,
      tracing,
      sessionResolver: resolver,
    });

    await a2aContextStorage.run(a2aContext, async () => {
      await adapter.execute(makeRequestContext('first turn', 'ctx-new-session'), eventBus);
    });

    // Should have called createSession
    expect(executionPort.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID }),
    );

    // Should have registered the new session
    const resolved = await resolver.resolveSession('ctx-new-session', TENANT_ID);
    expect(resolved.isNew).toBe(false);
    expect(resolved.sessionId).toBe(newSessionId);

    // Should have passed the new session ID to executeMessage
    expect(executionPort.executeMessage).toHaveBeenCalledWith(
      newSessionId,
      'first turn',
      expect.objectContaining({ tenantId: TENANT_ID }),
    );

    resolver.destroy();
  });

  it('falls back to taskId when no session resolver is configured', async () => {
    const executionPort = makeExecutionPort();
    const tracing = makeTracing();
    const eventBus = makeEventBus();
    const a2aContext = makeA2AContext();

    const adapter = new AgentExecutorAdapter({
      agentName: 'test-agent',
      executionPort,
      tracing,
      // No sessionResolver
    });

    const rc = makeRequestContext('no resolver');
    await a2aContextStorage.run(a2aContext, async () => {
      await adapter.execute(rc, eventBus);
    });

    // Should have used taskId as sessionId
    expect(executionPort.executeMessage).toHaveBeenCalledWith(
      rc.taskId,
      'no resolver',
      expect.objectContaining({ tenantId: TENANT_ID }),
    );
  });

  it('tenant isolation — same contextId different tenants get different sessions', async () => {
    const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 60_000 });

    try {
      await resolver.registerSession('ctx-shared', 'tenant-A', 'sess-A');
      await resolver.registerSession('ctx-shared', 'tenant-B', 'sess-B');

      const rA = await resolver.resolveSession('ctx-shared', 'tenant-A');
      expect(rA.sessionId).toBe('sess-A');

      const rB = await resolver.resolveSession('ctx-shared', 'tenant-B');
      expect(rB.sessionId).toBe('sess-B');
    } finally {
      resolver.destroy();
    }
  });
});
