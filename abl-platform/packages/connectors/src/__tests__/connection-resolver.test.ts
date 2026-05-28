import { describe, it, expect, vi } from 'vitest';
import { ConnectionResolver } from '../auth/connection-resolver.js';
import type {
  ConnectorConnectionModel,
  AuthProfileResolverLike,
} from '../auth/connection-resolver.js';
import type { IConnectorConnection } from '@agent-platform/database/models';

function makeConnection(overrides: Partial<IConnectorConnection> = {}): IConnectorConnection {
  return {
    _id: 'conn-1',
    tenantId: 't-1',
    projectId: 'p-1',
    connectorName: 'slack',
    displayName: 'Slack (Team)',
    scope: 'tenant',
    authProfileId: 'ap-1',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMocks() {
  const connectionModel: ConnectorConnectionModel = {
    findOne: vi.fn().mockResolvedValue(null),
  };

  const authProfileResolver: AuthProfileResolverLike = {
    resolve: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
  };

  return { connectionModel, authProfileResolver };
}

describe('ConnectionResolver', () => {
  describe('resolve()', () => {
    it('resolves user-scoped connection first', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const userConn = makeConnection({ scope: 'user', userId: 'u-1' });
      (connectionModel.findOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(userConn);

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      const result = await resolver.resolve({
        connectorName: 'slack',
        tenantId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
      });

      expect(result.scope).toBe('user');
      expect(result.connection).toBe(userConn);
      expect(connectionModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'user', userId: 'u-1', tenantId: 't-1' }),
      );
    });

    it('falls back to tenant connection when no user connection exists', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const tenantConn = makeConnection({ scope: 'tenant' });
      (connectionModel.findOne as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null) // user query
        .mockResolvedValueOnce(tenantConn); // tenant query

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      const result = await resolver.resolve({
        connectorName: 'slack',
        tenantId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
      });

      expect(result.scope).toBe('tenant');
      expect(result.connection).toBe(tenantConn);
    });

    it('resolves tenant connection when no userId provided', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const tenantConn = makeConnection({ scope: 'tenant' });
      (connectionModel.findOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(tenantConn);

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      const result = await resolver.resolve({
        connectorName: 'slack',
        tenantId: 't-1',
        projectId: 'p-1',
      });

      expect(result.scope).toBe('tenant');
      // Should not have queried for user-scoped
      expect(connectionModel.findOne).toHaveBeenCalledTimes(1);
      expect(connectionModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'tenant', tenantId: 't-1' }),
      );
    });

    it('throws when no connection exists', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      await expect(
        resolver.resolve({ connectorName: 'unknown', tenantId: 't-1', projectId: 'p-1' }),
      ).rejects.toThrow('No connection configured');
    });

    it('always includes projectId in queries (scope isolation)', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const tenantConn = makeConnection();
      (connectionModel.findOne as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(tenantConn);

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      await resolver.resolve({
        connectorName: 'slack',
        tenantId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
      });

      const calls = (connectionModel.findOne as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0]).toHaveProperty('projectId', 'p-1');
      }
    });

    it('includes projectId when resolving by connectionId', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const conn = makeConnection();
      (connectionModel.findOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(conn);

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      await resolver.resolve({
        connectorName: 'slack',
        tenantId: 't-1',
        projectId: 'p-1',
        connectionId: 'conn-1',
      });

      expect(connectionModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'conn-1', tenantId: 't-1', projectId: 'p-1' }),
      );
    });

    it('always includes tenantId in queries', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const tenantConn = makeConnection();
      (connectionModel.findOne as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(tenantConn);

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      await resolver.resolve({
        connectorName: 'slack',
        tenantId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
      });

      const calls = (connectionModel.findOne as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0]).toHaveProperty('tenantId', 't-1');
      }
    });
  });

  describe('resolveAuth()', () => {
    it('delegates to auth profile resolver', async () => {
      const { connectionModel, authProfileResolver } = makeMocks();
      const connection = makeConnection({ authProfileId: 'ap-1' });

      const resolver = new ConnectionResolver(connectionModel, authProfileResolver);
      const auth = await resolver.resolveAuth(connection);

      expect(auth).toEqual({ apiKey: 'sk-123' });
      expect(authProfileResolver.resolve).toHaveBeenCalledWith({
        authProfileId: 'ap-1',
        tenantId: 't-1',
        projectId: 'p-1',
      });
    });
  });
});
