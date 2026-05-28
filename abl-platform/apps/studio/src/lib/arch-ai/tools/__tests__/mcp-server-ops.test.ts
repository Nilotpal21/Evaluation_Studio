import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeMcpServerOps } from '../mcp-server-ops';
import * as cacheInvalidation from '@/lib/runtime-mcp-cache-invalidation';
import type { ToolPermissionContext } from '../../guards';

function makeTestCtx(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    user: {
      tenantId: 't1',
      userId: 'u1',
      permissions: ['tool:read', 'tool:write', 'tool:delete', 'tool:execute'],
    },
    projectId: 'p1',
    sessionId: 's1',
    authToken: 'tok',
    ...overrides,
  };
}

describe('executeMcpServerOps — runtime cache invalidation wiring', () => {
  const originalFetch = globalThis.fetch;
  let notifySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notifySpy = vi
      .spyOn(cacheInvalidation, 'notifyRuntimeMcpServersChanged')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('create action', () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, data: { id: 'mcp-server-1', name: 'Test' } }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
    });

    it('notifies runtime after successful create', async () => {
      const result = await executeMcpServerOps(
        {
          action: 'create',
          name: 'Test MCP Server',
          transport: 'http',
          url: 'https://mcp.example.com',
          authType: 'none',
        },
        makeTestCtx(),
      );

      expect(result.success).toBe(true);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledWith('t1', 'p1');
    });

    it('does NOT notify runtime when create fails', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, error: { code: 'BAD_INPUT', message: 'fail' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;

      const result = await executeMcpServerOps(
        {
          action: 'create',
          name: 'Test MCP Server',
          transport: 'http',
          url: 'https://mcp.example.com',
          authType: 'none',
        },
        makeTestCtx(),
      );

      expect(result.success).toBe(false);
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });

  describe('update action', () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, data: { id: 'mcp-server-1', name: 'Renamed' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
    });

    it('notifies runtime after successful update', async () => {
      const result = await executeMcpServerOps(
        { action: 'update', serverId: 'mcp-server-1', name: 'Renamed' },
        makeTestCtx(),
      );

      expect(result.success).toBe(true);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledWith('t1', 'p1');
    });
  });

  describe('delete action', () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof fetch;
    });

    it('notifies runtime after successful delete', async () => {
      const result = await executeMcpServerOps(
        { action: 'delete', serverId: 'mcp-server-1', confirmed: true },
        makeTestCtx(),
      );

      expect(result.success).toBe(true);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).toHaveBeenCalledWith('t1', 'p1');
    });

    it('returns needsConfirmation without notifying runtime when not confirmed', async () => {
      const result = await executeMcpServerOps(
        { action: 'delete', serverId: 'mcp-server-1' },
        makeTestCtx(),
      );

      expect(result.needsConfirmation).toBe(true);
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });

  describe('non-mutating actions', () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof fetch;
    });

    it('does NOT notify runtime on list', async () => {
      await executeMcpServerOps({ action: 'list' }, makeTestCtx());
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('does NOT notify runtime on read', async () => {
      await executeMcpServerOps({ action: 'read', serverId: 'mcp-server-1' }, makeTestCtx());
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('does NOT notify runtime on test_connection', async () => {
      await executeMcpServerOps(
        { action: 'test_connection', serverId: 'mcp-server-1' },
        makeTestCtx(),
      );
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });
});
