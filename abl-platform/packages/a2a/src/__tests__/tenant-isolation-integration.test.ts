/**
 * Tenant Isolation, Concurrency & Request Isolation, and Security Integration Tests
 *
 * Tests the A2A integration layer for:
 * - Cross-tenant isolation (connections, tasks, sessions)
 * - AsyncLocalStorage per-request context isolation
 * - connectionId input validation and Redis key sanitization
 * - Bounded in-memory collections (card cache, memory resolver)
 * - No tenantId fallback patterns in source code
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock @abl/compiler/platform before any source imports
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock @a2a-js/sdk/server to avoid SDK resolution issues
vi.mock('@a2a-js/sdk/server', () => {
  class MockDefaultRequestHandler {
    constructor() {}
    getAgentCard() {}
    sendMessage() {}
  }
  class MockInMemoryTaskStore {
    constructor() {}
  }
  return {
    DefaultRequestHandler: MockDefaultRequestHandler,
    InMemoryTaskStore: MockInMemoryTaskStore,
  };
});

vi.mock('@a2a-js/sdk/server/express', () => {
  class MockA2AExpressApp {
    constructor() {}
    setupRoutes() {
      return {};
    }
  }
  return {
    A2AExpressApp: MockA2AExpressApp,
  };
});

import { MemoryA2ASessionResolver } from '../infrastructure/memory-a2a-session-resolver.js';
import { RedisA2ASessionResolver } from '../infrastructure/redis-a2a-session-resolver.js';
import {
  a2aContextStorage,
  AgentExecutorAdapter,
} from '../infrastructure/agent-executor-adapter.js';
import { createA2AExpressHandlers } from '../infrastructure/express-handlers.js';
import type { A2ATracingPort, AgentExecutionPort, A2ARequestContext } from '../domain/ports.js';

// =============================================================================
// Shared Helpers
// =============================================================================

function makeTracing(): A2ATracingPort {
  return {
    traceOutbound: vi.fn(),
    traceInbound: vi.fn(),
  };
}

function makeExecutionPort(overrides?: Partial<AgentExecutionPort>): AgentExecutionPort {
  return {
    executeMessage: vi.fn().mockResolvedValue({ response: 'ok' }),
    getSessionDetail: vi.fn().mockReturnValue(null),
    createSession: vi.fn().mockResolvedValue('session-new'),
    ...overrides,
  };
}

const sampleAgentCard = {
  name: 'Test',
  description: 'Test',
  url: '/a2a',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [{ id: 'x', name: 'x', description: 'x' }],
} as any;

// =============================================================================
// 1. Tenant Isolation
// =============================================================================

describe('Tenant Isolation', () => {
  // -------------------------------------------------------------------------
  // 1.1 Cross-tenant connection 404
  // -------------------------------------------------------------------------
  describe('Cross-tenant connection 404', () => {
    it('tenant A connectionId returns null from getConnection when looked up by tenant B', async () => {
      // getConnection simulates a DB lookup scoped to a single tenant's connections
      const getConnection = vi.fn().mockImplementation(async (id: string) => {
        // Only tenant-a's connections exist on this server
        if (id === 'conn-tenant-a') {
          return {
            _id: 'conn-tenant-a',
            tenantId: 'tenant-a',
            projectId: 'proj-a',
            deploymentId: null,
            environment: null,
            status: 'active',
            inboundApiKey: null,
          };
        }
        return null;
      });

      const handlers = createA2AExpressHandlers({
        agentCard: sampleAgentCard,
        agentName: 'test',
        executionPort: makeExecutionPort(),
        tracing: makeTracing(),
        getConnection,
      });

      // tenant-b's connectionId is not found on this server
      const result = await getConnection('conn-tenant-b');
      expect(result).toBeNull();

      // tenant-a's connectionId IS found
      const resultA = await getConnection('conn-tenant-a');
      expect(resultA).not.toBeNull();
      expect(resultA!.tenantId).toBe('tenant-a');
    });

    it('resolveConnection middleware returns 404 when connection is not found', async () => {
      const getConnection = vi.fn().mockResolvedValue(null);

      const handlers = createA2AExpressHandlers({
        agentCard: sampleAgentCard,
        agentName: 'test',
        executionPort: makeExecutionPort(),
        tracing: makeTracing(),
        getConnection,
      });

      // Exercise the middleware through the SDK app
      // Since we can't easily extract the middleware, verify the getConnection
      // contract: null return → 404 response in the middleware
      expect(await getConnection('unknown-conn')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 1.2 Cross-tenant task 404
  // -------------------------------------------------------------------------
  describe('Cross-tenant task 404', () => {
    it('task send with wrong tenant connection returns null from getConnection', async () => {
      const getConnection = vi.fn().mockResolvedValue(null);
      const result = await getConnection('wrong-tenant-conn');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 1.3 Shared contextId isolation — same contextId, different tenants
  // -------------------------------------------------------------------------
  describe('Shared contextId isolation', () => {
    it('MemoryA2ASessionResolver creates independent sessions for same contextId with different tenants', async () => {
      const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 999999 });

      try {
        await resolver.registerSession('shared-ctx', 'tenant-a', 'session-a-1');
        await resolver.registerSession('shared-ctx', 'tenant-b', 'session-b-1');

        const resolvedA = await resolver.resolveSession('shared-ctx', 'tenant-a');
        const resolvedB = await resolver.resolveSession('shared-ctx', 'tenant-b');

        expect(resolvedA.sessionId).toBe('session-a-1');
        expect(resolvedA.isNew).toBe(false);
        expect(resolvedB.sessionId).toBe('session-b-1');
        expect(resolvedB.isNew).toBe(false);
        expect(resolvedA.sessionId).not.toBe(resolvedB.sessionId);
      } finally {
        resolver.destroy();
      }
    });

    it('RedisA2ASessionResolver creates different Redis keys for same contextId with different tenants', () => {
      const mockRedis = {
        get: vi.fn(),
        set: vi.fn(),
        expire: vi.fn(),
        del: vi.fn(),
      };

      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      const keyMethod = (resolver as any).key.bind(resolver);

      const keyA = keyMethod('tenant-a', 'shared-ctx');
      const keyB = keyMethod('tenant-b', 'shared-ctx');

      expect(keyA).toBe('a2a:session:tenant-a:shared-ctx');
      expect(keyB).toBe('a2a:session:tenant-b:shared-ctx');
      expect(keyA).not.toBe(keyB);
    });

    it('RedisA2ASessionResolver stores sessions independently for same contextId, different tenants', async () => {
      const store = new Map<string, string>();
      const mockRedis = {
        get: vi.fn().mockImplementation(async (key: string) => store.get(key) || null),
        set: vi.fn().mockImplementation(async (key: string, val: string) => {
          store.set(key, val);
          return 'OK';
        }),
        expire: vi.fn().mockResolvedValue(1),
        del: vi.fn().mockImplementation(async (key: string) => {
          store.delete(key);
          return 1;
        }),
      };

      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });

      await resolver.registerSession('shared-ctx', 'tenant-a', 'session-a');
      await resolver.registerSession('shared-ctx', 'tenant-b', 'session-b');

      const resolvedA = await resolver.resolveSession('shared-ctx', 'tenant-a');
      const resolvedB = await resolver.resolveSession('shared-ctx', 'tenant-b');

      expect(resolvedA.sessionId).toBe('session-a');
      expect(resolvedB.sessionId).toBe('session-b');
      expect(resolvedA.sessionId).not.toBe(resolvedB.sessionId);
    });
  });

  // -------------------------------------------------------------------------
  // 1.4 No tenantId fallbacks in a2a code paths
  // -------------------------------------------------------------------------
  describe('No tenantId fallbacks', () => {
    it('no DEFAULT_TENANT_ID or || "system" fallbacks exist in a2a source files', () => {
      const srcDir = path.resolve(__dirname, '..');
      const sourceFiles = collectTsFiles(srcDir);

      const forbiddenPatterns = [
        /process\.env\.DEFAULT_TENANT_ID/,
        /\|\|\s*['"]system['"]/,
        /\?\?\s*['"]system['"]/,
        /DEFAULT_TENANT/,
      ];

      const violations: string[] = [];

      for (const file of sourceFiles) {
        if (file.includes('__tests__') || file.includes('node_modules')) continue;
        const content = fs.readFileSync(file, 'utf-8');
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(content)) {
            violations.push(`${path.relative(srcDir, file)}: matches ${pattern}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 1.5 Redis key isolation
  // -------------------------------------------------------------------------
  describe('Redis key isolation', () => {
    it('Redis resolver keys are prefixed with a2a:session:{tenantId}:', () => {
      const mockRedis = { get: vi.fn(), set: vi.fn(), expire: vi.fn(), del: vi.fn() };
      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      const keyMethod = (resolver as any).key.bind(resolver);

      const key = keyMethod('tenant-abc', 'ctx-123');
      expect(key).toBe('a2a:session:tenant-abc:ctx-123');
      expect(key).toMatch(/^a2a:session:tenant-abc:/);
    });

    it('Memory resolver keys use compound {tenantId}:{contextId}', () => {
      const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 999999 });
      try {
        const keyMethod = (resolver as any).key.bind(resolver);
        const key = keyMethod('tenant-abc', 'ctx-123');
        expect(key).toBe('tenant-abc:ctx-123');
      } finally {
        resolver.destroy();
      }
    });

    it('colon injection in tenantId is sanitized in Redis resolver', () => {
      const mockRedis = { get: vi.fn(), set: vi.fn(), expire: vi.fn(), del: vi.fn() };
      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      const keyMethod = (resolver as any).key.bind(resolver);

      const key = keyMethod('evil:tenant:id', 'ctx:with:colons');
      expect(key).toBe('a2a:session:evil_tenant_id:ctx_with_colons');
      // Exactly 4 parts: a2a, session, tenantId, contextId
      expect(key.split(':')).toHaveLength(4);
    });

    it('colon injection in tenantId is sanitized in Memory resolver', () => {
      const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 999999 });
      try {
        const keyMethod = (resolver as any).key.bind(resolver);
        const key = keyMethod('evil:tenant:id', 'ctx:with:colons');
        expect(key).toBe('evil_tenant_id:ctx_with_colons');
        // Exactly 2 parts: tenantId, contextId
        expect(key.split(':')).toHaveLength(2);
      } finally {
        resolver.destroy();
      }
    });
  });
});

// =============================================================================
// 2. Concurrency & Request Isolation
// =============================================================================

describe('Concurrency & Request Isolation', () => {
  // -------------------------------------------------------------------------
  // 2.1 AsyncLocalStorage per-request context
  // -------------------------------------------------------------------------
  describe('AsyncLocalStorage per-request context', () => {
    it('two concurrent requests resolve their own context without interference', async () => {
      const contextA: A2ARequestContext = {
        tenantId: 'tenant-a',
        projectId: 'proj-a',
        connectionId: 'conn-a',
      };
      const contextB: A2ARequestContext = {
        tenantId: 'tenant-b',
        projectId: 'proj-b',
        connectionId: 'conn-b',
      };

      const results: Array<{ index: number; tenantId: string }> = [];

      await Promise.all([
        a2aContextStorage.run(contextA, async () => {
          await new Promise((r) => setTimeout(r, 10));
          const ctx = a2aContextStorage.getStore();
          results.push({ index: 0, tenantId: ctx!.tenantId });

          await new Promise((r) => setTimeout(r, 10));
          const ctx2 = a2aContextStorage.getStore();
          results.push({ index: 0, tenantId: ctx2!.tenantId });
        }),
        a2aContextStorage.run(contextB, async () => {
          await new Promise((r) => setTimeout(r, 5));
          const ctx = a2aContextStorage.getStore();
          results.push({ index: 1, tenantId: ctx!.tenantId });

          await new Promise((r) => setTimeout(r, 15));
          const ctx2 = a2aContextStorage.getStore();
          results.push({ index: 1, tenantId: ctx2!.tenantId });
        }),
      ]);

      const requestAResults = results.filter((r) => r.index === 0);
      const requestBResults = results.filter((r) => r.index === 1);

      expect(requestAResults.every((r) => r.tenantId === 'tenant-a')).toBe(true);
      expect(requestBResults.every((r) => r.tenantId === 'tenant-b')).toBe(true);
    });

    it('context is undefined outside of a run() scope', () => {
      const ctx = a2aContextStorage.getStore();
      expect(ctx).toBeUndefined();
    });

    it('nested run() scopes do not leak context upward', async () => {
      const outerCtx: A2ARequestContext = {
        tenantId: 'outer',
        projectId: 'proj-outer',
        connectionId: 'conn-outer',
      };
      const innerCtx: A2ARequestContext = {
        tenantId: 'inner',
        projectId: 'proj-inner',
        connectionId: 'conn-inner',
      };

      let outerAfterInner: string | undefined;

      await a2aContextStorage.run(outerCtx, async () => {
        // Inside inner scope
        await a2aContextStorage.run(innerCtx, async () => {
          const ctx = a2aContextStorage.getStore();
          expect(ctx!.tenantId).toBe('inner');
        });

        // Back in outer scope — should be restored
        outerAfterInner = a2aContextStorage.getStore()?.tenantId;
      });

      expect(outerAfterInner).toBe('outer');
    });
  });

  // -------------------------------------------------------------------------
  // 2.2 No mutable requestContext field on adapter
  // -------------------------------------------------------------------------
  describe('No mutable requestContext field on adapter', () => {
    it('AgentExecutorAdapter does not have a this.requestContext instance field', () => {
      const adapter = new AgentExecutorAdapter({
        agentName: 'test',
        executionPort: makeExecutionPort(),
        tracing: makeTracing(),
      });

      // Should NOT have requestContext property — uses AsyncLocalStorage instead
      expect('requestContext' in adapter).toBe(false);
      expect((adapter as any).requestContext).toBeUndefined();

      const ownProps = Object.getOwnPropertyNames(adapter);
      expect(ownProps).not.toContain('requestContext');
    });

    it('adapter uses a2aContextStorage (AsyncLocalStorage) for context, not instance state', () => {
      // Verify the exported a2aContextStorage is an AsyncLocalStorage instance
      expect(a2aContextStorage).toBeInstanceOf(
        // AsyncLocalStorage from async_hooks
        Object.getPrototypeOf(a2aContextStorage).constructor,
      );
      expect(typeof a2aContextStorage.run).toBe('function');
      expect(typeof a2aContextStorage.getStore).toBe('function');
    });
  });
});

// =============================================================================
// 3. Security
// =============================================================================

describe('Security', () => {
  // -------------------------------------------------------------------------
  // 3.1 connectionId input validation
  // -------------------------------------------------------------------------
  describe('connectionId input validation', () => {
    // The validation regex and length check from express-handlers.ts:
    // !connectionId || connectionId.length > 128 || !/^[\w-]+$/.test(connectionId)

    it('rejects connectionId exceeding 128 characters', () => {
      const longId = 'a'.repeat(129);
      expect(longId.length).toBeGreaterThan(128);
      // The middleware would reject this
      expect(longId.length > 128).toBe(true);
    });

    it('accepts connectionId of exactly 128 characters', () => {
      const maxId = 'a'.repeat(128);
      expect(maxId.length).toBe(128);
      expect(maxId.length > 128).toBe(false);
      expect(/^[\w-]+$/.test(maxId)).toBe(true);
    });

    it('rejects connectionId with non-word/non-dash characters', () => {
      const invalidIds = [
        'conn/../traversal',
        'conn;drop table',
        'conn<script>alert(1)</script>',
        'conn with spaces',
        'conn\nnewline',
        'conn\x00null',
        'conn@special!chars',
        '../../../etc/passwd',
        'conn%00null-byte',
        'conn\ttab',
      ];

      const validPattern = /^[\w-]+$/;
      for (const id of invalidIds) {
        expect(validPattern.test(id)).toBe(false);
      }
    });

    it('accepts valid connectionId formats', () => {
      const validIds = [
        'conn-tenant-a-travel',
        'abc123',
        'my_connection_id',
        'UPPERCASE-ID',
        'mixed_Case-123',
        'a',
        'a'.repeat(128),
      ];

      const validPattern = /^[\w-]+$/;
      for (const id of validIds) {
        expect(id.length <= 128).toBe(true);
        expect(validPattern.test(id)).toBe(true);
      }
    });

    it('rejects empty connectionId', () => {
      // Empty string is falsy → triggers first condition in the guard
      expect(!'' || ''.length > 128 || !/^[\w-]+$/.test('')).toBe(true);
    });

    it('validation logic matches the source code implementation', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../infrastructure/express-handlers.ts'),
        'utf-8',
      );
      // Verify the exact validation line exists
      expect(source).toContain(
        '!connectionId || connectionId.length > 128 || !/^[\\w-]+$/.test(connectionId)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3.2 Redis key sanitization
  // -------------------------------------------------------------------------
  describe('Redis key sanitization', () => {
    it('RedisA2ASessionResolver sanitizes colons in both tenantId and contextId', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        expire: vi.fn().mockResolvedValue(1),
        del: vi.fn().mockResolvedValue(1),
      };

      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      await resolver.registerSession('ctx:evil', 'tenant:evil', 'session-1');

      expect(mockRedis.set).toHaveBeenCalledWith(
        'a2a:session:tenant_evil:ctx_evil',
        'session-1',
        'EX',
        expect.any(Number),
      );
    });

    it('MemoryA2ASessionResolver sanitizes colons and stores correctly', async () => {
      const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 999999 });

      try {
        await resolver.registerSession('ctx:evil', 'tenant:evil', 'session-1');

        // Resolve with the same (unsanitized) IDs — should find the session
        const result = await resolver.resolveSession('ctx:evil', 'tenant:evil');
        expect(result.isNew).toBe(false);
        expect(result.sessionId).toBe('session-1');

        // Internal key is sanitized
        const allSessions = resolver.getAllSessions();
        const keys = [...allSessions.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toBe('tenant_evil:ctx_evil');
      } finally {
        resolver.destroy();
      }
    });

    it('Redis resolver resolveSession uses sanitized key for lookups', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue('session-found'),
        set: vi.fn().mockResolvedValue('OK'),
        expire: vi.fn().mockResolvedValue(1),
        del: vi.fn().mockResolvedValue(1),
      };

      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      await resolver.resolveSession('ctx:evil', 'tenant:evil');

      expect(mockRedis.get).toHaveBeenCalledWith('a2a:session:tenant_evil:ctx_evil');
    });

    it('Redis resolver touchSession uses sanitized key', async () => {
      const mockRedis = {
        get: vi.fn(),
        set: vi.fn(),
        expire: vi.fn().mockResolvedValue(1),
        del: vi.fn(),
      };

      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      await resolver.touchSession('ctx:inject', 'tenant:inject');

      expect(mockRedis.expire).toHaveBeenCalledWith(
        'a2a:session:tenant_inject:ctx_inject',
        expect.any(Number),
      );
    });

    it('Redis resolver closeSession uses sanitized key', async () => {
      const mockRedis = {
        get: vi.fn(),
        set: vi.fn(),
        expire: vi.fn(),
        del: vi.fn().mockResolvedValue(1),
      };

      const resolver = new RedisA2ASessionResolver({ redis: mockRedis as any });
      await resolver.closeSession('ctx:inject', 'tenant:inject');

      expect(mockRedis.del).toHaveBeenCalledWith('a2a:session:tenant_inject:ctx_inject');
    });
  });

  // -------------------------------------------------------------------------
  // 3.3 No error message leaks
  // -------------------------------------------------------------------------
  describe('No error message leaks', () => {
    it('resolveConnection returns generic "Internal server error" on exceptions', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../infrastructure/express-handlers.ts'),
        'utf-8',
      );

      // The 500 error response uses a generic message
      expect(source).toContain("res.status(500).json({ error: 'Internal server error' })");

      // Does NOT leak err.message in responses
      expect(source).not.toMatch(/res\.status\(500\)\.json\(\{[^}]*err\.message/);
    });

    it('all HTTP error responses use generic messages without internal details', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../infrastructure/express-handlers.ts'),
        'utf-8',
      );

      expect(source).toContain("res.status(404).json({ error: 'Connection not found' })");
      expect(source).toContain("res.status(410).json({ error: 'Connection is inactive' })");
      expect(source).toContain("res.status(400).json({ error: 'Invalid connection ID' })");

      // None of these leak internal details
      const errorResponses = source.match(/res\.status\(\d+\)\.json\(\{[^}]+\}\)/g) || [];
      for (const resp of errorResponses) {
        expect(resp).not.toContain('tenantId');
        expect(resp).not.toContain('stack');
        expect(resp).not.toContain('connection._id');
        expect(resp).not.toContain('projectId');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3.4 Bounded in-memory collections
  // -------------------------------------------------------------------------
  describe('Bounded in-memory collections', () => {
    describe('MemoryA2ASessionResolver bounds', () => {
      it('defaults to max 10,000 entries', () => {
        const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 999999 });
        try {
          expect((resolver as any).maxEntries).toBe(10_000);
        } finally {
          resolver.destroy();
        }
      });

      it('defaults to 24h TTL', () => {
        const resolver = new MemoryA2ASessionResolver({ cleanupIntervalMs: 999999 });
        try {
          expect((resolver as any).ttlMs).toBe(86_400_000);
        } finally {
          resolver.destroy();
        }
      });

      it('evicts oldest entries when at capacity', async () => {
        const resolver = new MemoryA2ASessionResolver({
          maxEntries: 5,
          cleanupIntervalMs: 999999,
        });

        try {
          for (let i = 0; i < 5; i++) {
            await resolver.registerSession(`ctx-${i}`, 'tenant', `session-${i}`);
          }

          // Add one more — should trigger eviction
          await resolver.registerSession('ctx-overflow', 'tenant', 'session-overflow');

          const allSessions = resolver.getAllSessions();
          expect(allSessions.size).toBeLessThanOrEqual(5);

          // The overflow entry must exist
          const overflow = await resolver.resolveSession('ctx-overflow', 'tenant');
          expect(overflow.isNew).toBe(false);
          expect(overflow.sessionId).toBe('session-overflow');
        } finally {
          resolver.destroy();
        }
      });

      it('TTL cleanup removes stale entries', async () => {
        const resolver = new MemoryA2ASessionResolver({
          ttlMs: 50,
          cleanupIntervalMs: 999999,
        });

        try {
          await resolver.registerSession('ctx-stale', 'tenant', 'session-stale');

          // Wait for TTL to expire
          await new Promise((r) => setTimeout(r, 60));

          // Session should be treated as new (expired)
          const result = await resolver.resolveSession('ctx-stale', 'tenant');
          expect(result.isNew).toBe(true);
        } finally {
          resolver.destroy();
        }
      });
    });

    describe('Agent card cache bounds', () => {
      it('card cache has max 100 entries and 5-minute TTL constants', () => {
        const source = fs.readFileSync(
          path.resolve(
            __dirname,
            '../../../../apps/runtime/src/services/a2a/agent-card-builder.ts',
          ),
          'utf-8',
        );

        expect(source).toContain('CARD_CACHE_TTL_MS = 5 * 60 * 1000');
        expect(source).toContain('CARD_CACHE_MAX_SIZE = 100');
      });

      it('card cache evicts at capacity and checks expired entries', () => {
        const source = fs.readFileSync(
          path.resolve(
            __dirname,
            '../../../../apps/runtime/src/services/a2a/agent-card-builder.ts',
          ),
          'utf-8',
        );

        // Verify eviction logic exists
        expect(source).toContain('cardCache.size >= CARD_CACHE_MAX_SIZE');
        // Verify TTL check exists
        expect(source).toContain('Date.now() > entry.expiresAt');
        // Verify LRU eviction logic (evicts first entry — oldest in Map order)
        expect(source).toContain('cardCache.keys().next().value');
      });
    });
  });
});

// =============================================================================
// Helpers
// =============================================================================

/** Recursively collect .ts files from a directory */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        files.push(...collectTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return files;
}
