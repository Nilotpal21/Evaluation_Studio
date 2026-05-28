/**
 * Audit Middleware Tests
 *
 * Verifies tool call audit logging behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAuditMiddleware } from '../../platform/constructs/executors/audit-middleware.js';
import type {
  ToolAuditLogger,
  ToolAuditEntry,
} from '../../platform/constructs/executors/audit-middleware.js';
import type {
  ToolCallContext,
  ToolMiddlewareNext,
} from '../../platform/constructs/executors/tool-middleware.js';

function createMockLogger(): ToolAuditLogger & { entries: ToolAuditEntry[] } {
  const entries: ToolAuditEntry[] = [];
  return {
    entries,
    logToolAudit: vi.fn(async (entry: ToolAuditEntry) => {
      entries.push(entry);
    }),
  };
}

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: 'test_api',
    params: { query: 'test' },
    timeoutMs: 5000,
    tool: {
      name: 'test_api',
      description: 'Test',
      parameters: [],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'fast',
        parallelizable: false,
        side_effects: false,
        requires_auth: false,
      },
      tool_type: 'http',
      http_binding: {
        endpoint: 'https://api.example.com/search?key=secret',
        method: 'POST',
        auth: { type: 'bearer' },
      },
    },
    metadata: {
      sessionId: 'session-123',
      tenantId: 'org-1',
      userId: 'user-1',
    },
    ...overrides,
  };
}

describe('Audit Middleware', () => {
  it('should log successful tool call', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: { data: 'test' } });

    await middleware(makeCtx(), next);

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0].success).toBe(true);
    expect(logger.entries[0].toolName).toBe('test_api');
    expect(logger.entries[0].toolType).toBe('http');
    expect(logger.entries[0].sessionId).toBe('session-123');
    expect(logger.entries[0].tenantId).toBe('org-1');
    expect(logger.entries[0].userId).toBe('user-1');
  });

  it('should log failed tool call', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => {
      throw new Error('Connection refused');
    };

    await expect(middleware(makeCtx(), next)).rejects.toThrow('Connection refused');

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0].success).toBe(false);
    expect(logger.entries[0].errorMessage).toBe('Connection refused');
  }, 15_000);

  it('should hash input params (not store raw)', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: 'ok' });

    await middleware(makeCtx(), next);

    expect(logger.entries[0].inputHash).toBeDefined();
    expect(logger.entries[0].inputHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    // The params should NOT be in the entry itself (only the hash)
    expect(JSON.stringify(logger.entries[0])).not.toContain('"query":"test"');
  });

  it('should include auth type from tool binding', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: 'ok' });

    await middleware(makeCtx(), next);

    expect(logger.entries[0].authType).toBe('bearer');
  });

  it('should include endpoint from tool binding', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: 'ok' });

    await middleware(makeCtx(), next);

    expect(logger.entries[0].endpoint).toBe('https://api.example.com/search?key=secret');
  });

  it('should measure latency', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { result: 'ok' };
    };

    await middleware(makeCtx(), next);

    expect(logger.entries[0].latencyMs).toBeGreaterThanOrEqual(40);
  });

  it('should not block on audit failure', async () => {
    const failingLogger: ToolAuditLogger = {
      logToolAudit: vi.fn(async () => {
        throw new Error('DB connection failed');
      }),
    };

    const middleware = createAuditMiddleware(failingLogger);
    const next: ToolMiddlewareNext = async () => ({ result: 'success' });

    // Should NOT throw even though audit logger fails
    const { result } = await middleware(makeCtx(), next);
    expect(result).toBe('success');
    expect(failingLogger.logToolAudit).toHaveBeenCalled();
  });

  it('should produce deterministic hash for same input', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: 'ok' });

    await middleware(makeCtx(), next);
    await middleware(makeCtx(), next);

    expect(logger.entries[0].inputHash).toBe(logger.entries[1].inputHash);
  });

  it('should include context metadata in audit entries', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: 'ok' });

    const ctx = makeCtx({
      metadata: {
        sessionId: 'sess-abc',
        tenantId: 'org-xyz',
        userId: 'user-def',
      },
    });

    await middleware(ctx, next);

    expect(logger.entries[0].sessionId).toBe('sess-abc');
    expect(logger.entries[0].tenantId).toBe('org-xyz');
    expect(logger.entries[0].userId).toBe('user-def');
  });

  it('should include workflow version metadata in audit entries', async () => {
    const logger = createMockLogger();
    const middleware = createAuditMiddleware(logger);
    const next: ToolMiddlewareNext = async () => ({ result: 'ok' });

    const ctx = makeCtx({
      metadata: {
        sessionId: 'sess-workflow',
        tenantId: 'org-workflow',
        workflow_id: 'wf-1',
        workflow_version_id: 'wfv-2',
        workflow_version: 'v2.0.0',
      },
    });

    await middleware(ctx, next);

    expect(logger.entries[0].workflowId).toBe('wf-1');
    expect(logger.entries[0].workflowVersionId).toBe('wfv-2');
    expect(logger.entries[0].workflowVersion).toBe('v2.0.0');
  });
});
