import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeConnectionOps } from '../connection-ops';
import * as draftService from '../../integration-draft-service';
import * as connectionServiceModule from '@/lib/connection-service';
import type { ToolPermissionContext } from '../../guards';

function makeTestCtx(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    user: {
      tenantId: 't1',
      userId: 'u1',
      permissions: ['connection:read', 'connection:write', 'connection:delete'],
    },
    projectId: 'p1',
    sessionId: undefined,
    authToken: 'tok',
    ...overrides,
  };
}

describe('executeConnectionOps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('returns connections scoped to tenant + project', async () => {
      const { ConnectorConnection } = await import('@agent-platform/database/models');
      const fakeDocs = [
        {
          _id: 'conn_1',
          connectorName: 'slack',
          displayName: 'Slack Workspace',
          authProfileId: 'ap_1',
          scope: 'tenant',
          status: 'active',
        },
        {
          _id: 'conn_2',
          connectorName: 'gmail',
          displayName: 'Gmail',
          authProfileId: 'ap_2',
          scope: 'tenant',
          status: 'active',
        },
      ];
      const findSpy = vi.spyOn(ConnectorConnection, 'find').mockReturnValue({
        lean: async () => fakeDocs,
      } as unknown as ReturnType<typeof ConnectorConnection.find>);

      const result = await executeConnectionOps({ action: 'list' }, makeTestCtx());

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data?.connections)).toBe(true);
      expect((result.data?.connections as unknown[]).length).toBe(2);
      const filter = findSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(filter).toMatchObject({ tenantId: 't1', projectId: 'p1' });
    });
  });

  describe('create', () => {
    it('binds AuthProfile to connector and syncs active draft', async () => {
      const fakeService = {
        create: vi.fn(async () => ({
          _id: 'conn_new_1',
          connectorName: 'slack',
          authProfileId: 'ap_1',
          status: 'active',
        })),
        delete: vi.fn(async () => true),
      };
      vi.spyOn(connectionServiceModule, 'getConnectionService').mockResolvedValue(
        fakeService as never,
      );
      const syncSpy = vi
        .spyOn(draftService, 'syncActiveDraftFromConnection')
        .mockResolvedValue(null);

      const ctx = makeTestCtx({ sessionId: 's1' });
      const result = await executeConnectionOps(
        {
          action: 'create',
          connectorName: 'slack',
          authProfileId: 'ap_1',
          displayName: 'Slack Workspace',
        },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.data?.connectionId).toBe('conn_new_1');
      expect(fakeService.create).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          projectId: 'p1',
          sessionId: 's1',
          userId: 'u1',
          connectionId: 'conn_new_1',
        }),
      );
    });
  });

  describe('delete', () => {
    it('deletes a connection via the service and invalidates caches', async () => {
      const fakeService = {
        create: vi.fn(),
        delete: vi.fn(async () => true),
      };
      vi.spyOn(connectionServiceModule, 'getConnectionService').mockResolvedValue(
        fakeService as never,
      );

      const result = await executeConnectionOps(
        { action: 'delete', connectionId: 'conn_to_delete' },
        makeTestCtx(),
      );

      expect(result.success).toBe(true);
      expect(result.data?.deleted).toBe('conn_to_delete');
      expect(fakeService.delete).toHaveBeenCalledTimes(1);
      // Service expects positional args: (tenantId, projectId, id)
      expect(fakeService.delete).toHaveBeenCalledWith('t1', 'p1', 'conn_to_delete');
    });
  });

  describe('resolve_options', () => {
    it('returns disabled+placeholder when proxy unreachable', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await executeConnectionOps(
        {
          action: 'resolve_options',
          connectorName: 'slack',
          actionName: 'send_channel_message',
          propName: 'channel',
          connectionId: 'conn_1',
        },
        makeTestCtx(),
      );

      expect(result.success).toBe(true);
      expect(result.data?.disabled).toBe(true);
      expect(String(result.data?.placeholder)).toContain('Connector unavailable');
      expect(Array.isArray(result.data?.options)).toBe(true);
    });

    it('returns disabled+placeholder when proxy returns non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await executeConnectionOps(
        {
          action: 'resolve_options',
          connectorName: 'slack',
          actionName: 'send_channel_message',
          propName: 'channel',
          connectionId: 'conn_1',
        },
        makeTestCtx(),
      );

      expect(result.success).toBe(true);
      expect(result.data?.disabled).toBe(true);
    });
  });

  describe('permission gating', () => {
    it('rejects list without connection:read permission', async () => {
      const noPerm = makeTestCtx({
        user: { tenantId: 't1', userId: 'u1', permissions: [] },
      });
      const result = await executeConnectionOps({ action: 'list' }, noPerm);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PERMISSION_DENIED');
    });

    it('rejects create without connection:write permission', async () => {
      const noPerm = makeTestCtx({
        user: { tenantId: 't1', userId: 'u1', permissions: ['connection:read'] },
      });
      const result = await executeConnectionOps(
        {
          action: 'create',
          connectorName: 'slack',
          authProfileId: 'ap_1',
          displayName: 'Slack',
        },
        noPerm,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PERMISSION_DENIED');
    });
  });
});
