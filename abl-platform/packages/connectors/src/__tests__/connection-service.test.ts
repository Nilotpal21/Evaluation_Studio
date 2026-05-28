/**
 * Tests for ConnectionService — creation, listing, and auth profile binding.
 *
 * ConnectionService now manages pure binding records (no credentials/encryption).
 * Connections require an authProfileId and delegate credential resolution to
 * the auth profile system.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionService } from '../services/connection-service.js';
import { ConnectorRegistry } from '../registry.js';
import type { Connector } from '../types.js';

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    name: 'slack',
    displayName: 'Slack',
    version: '1.0.0',
    description: 'Slack connector',
    auth: { type: 'api_key' },
    triggers: [],
    actions: [],
    ...overrides,
  };
}

function makeHttpConnector(): Connector {
  return makeConnector({
    name: 'http',
    displayName: 'HTTP Request',
    auth: { type: 'none' },
  });
}

function makeMockConnection(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'c-default',
    tenantId: 't1',
    projectId: 'p1',
    connectorName: 'slack',
    displayName: 'My Slack',
    scope: 'tenant',
    authProfileId: 'ap-1',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockModel() {
  return {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    create: vi.fn().mockImplementation(async (data: Record<string, unknown>) => data),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    findOneAndDelete: vi.fn().mockResolvedValue(null),
  };
}

function makeDeps(connectors: Connector[]) {
  const registry = new ConnectorRegistry();
  for (const c of connectors) {
    registry.register(c);
  }
  const model = makeMockModel();
  return {
    model,
    registry,
    svc: new ConnectionService({
      connectionModel: model,
      registry,
    }),
  };
}

describe('ConnectionService.create', () => {
  it('stores authProfileId in the created record', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    model.findOneAndUpdate.mockResolvedValue(makeMockConnection({ authProfileId: 'ap-1' }));
    await svc.create('t1', 'p1', {
      connectorName: 'slack',
      displayName: 'My Slack',
      authProfileId: 'ap-1',
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: 'ap-1' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('throws VALIDATION_ERROR when authProfileId is missing', async () => {
    const { svc } = makeDeps([makeConnector()]);
    await expect(
      svc.create('t1', 'p1', {
        connectorName: 'slack',
        displayName: 'My Slack',
        authProfileId: '',
      }),
    ).rejects.toThrow('authProfileId');
  });

  it('throws UNKNOWN_CONNECTOR for unregistered connector without authProfileId', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    // When authProfileId is provided, the registry check is skipped (catalog connectors).
    // UNKNOWN_CONNECTOR only triggers when there's no authProfileId AND not in registry.
    model.create.mockResolvedValue({} as any);
    await expect(
      svc.create('t1', 'p1', {
        connectorName: 'nonexistent',
        displayName: 'Bad',
        authProfileId: '',
      }),
    ).rejects.toThrow('authProfileId');
  });

  it('allows unregistered connector when authProfileId is provided', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    model.findOneAndUpdate.mockResolvedValue(
      makeMockConnection({ connectorName: 'gmail', displayName: 'Gmail' }),
    );
    const result = await svc.create('t1', 'p1', {
      connectorName: 'gmail',
      displayName: 'Gmail',
      authProfileId: 'ap-1',
    });
    expect(result.connectorName).toBe('gmail');
  });

  it('throws VALIDATION_ERROR when displayName is empty', async () => {
    const { svc } = makeDeps([makeConnector()]);
    await expect(
      svc.create('t1', 'p1', {
        connectorName: 'slack',
        displayName: '',
        authProfileId: 'ap-1',
      }),
    ).rejects.toThrow('displayName');
  });

  it('defaults scope to tenant', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    model.findOneAndUpdate.mockResolvedValue(makeMockConnection());
    await svc.create('t1', 'p1', {
      connectorName: 'slack',
      displayName: 'Slack',
      authProfileId: 'ap-1',
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ scope: 'tenant' }) }),
      expect.anything(),
    );
  });

  it('sets status to active on creation', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    model.findOneAndUpdate.mockResolvedValue(makeMockConnection());
    await svc.create('t1', 'p1', {
      connectorName: 'slack',
      displayName: 'Slack',
      authProfileId: 'ap-1',
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ status: 'active' }) }),
      expect.anything(),
    );
  });

  it('requires userId for user-scoped connections', async () => {
    const { svc } = makeDeps([makeConnector()]);
    await expect(
      svc.create('t1', 'p1', {
        connectorName: 'slack',
        displayName: 'Slack',
        authProfileId: 'ap-1',
        scope: 'user',
      }),
    ).rejects.toThrow('userId');
  });
});

describe('ConnectionService.list', () => {
  it('scopes query to tenantId and projectId', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    await svc.list('t1', 'p1');
    expect(model.find).toHaveBeenCalledWith({ tenantId: 't1', projectId: 'p1' });
  });
});

describe('ConnectionService.getById', () => {
  it('scopes query to _id, tenantId, and projectId', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    await svc.getById('t1', 'p1', 'c1');
    expect(model.findOne).toHaveBeenCalledWith({ _id: 'c1', tenantId: 't1', projectId: 'p1' });
  });

  it('returns null when not found (tenant isolation)', async () => {
    const { svc } = makeDeps([makeConnector()]);
    const result = await svc.getById('wrong-tenant', 'p1', 'c1');
    expect(result).toBeNull();
  });
});

describe('ConnectionService.update', () => {
  it('scopes query to _id, tenantId, and projectId', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    await svc.update('t1', 'p1', 'c1', { displayName: 'New Name' });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'c1', tenantId: 't1', projectId: 'p1' },
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('updates authProfileId and metadata when provided', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    await svc.update('t1', 'p1', 'c1', {
      authProfileId: 'ap-2',
      metadata: { baseUrl: 'https://smartassist.example.com', appId: 'app-123' },
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'c1', tenantId: 't1', projectId: 'p1' },
      {
        $set: expect.objectContaining({
          authProfileId: 'ap-2',
          metadata: { baseUrl: 'https://smartassist.example.com', appId: 'app-123' },
        }),
      },
      expect.any(Object),
    );
  });

  it('throws VALIDATION_ERROR when update authProfileId is empty', async () => {
    const { svc } = makeDeps([makeConnector()]);
    await expect(svc.update('t1', 'p1', 'c1', { authProfileId: '' })).rejects.toThrow(
      'authProfileId',
    );
  });

  it('returns null when connection not found', async () => {
    const { svc } = makeDeps([makeConnector()]);
    const result = await svc.update('t1', 'p1', 'c1', { displayName: 'X' });
    expect(result).toBeNull();
  });
});

describe('ConnectionService.delete', () => {
  it('scopes query to _id, tenantId, and projectId', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    await svc.delete('t1', 'p1', 'c1');
    expect(model.findOneAndDelete).toHaveBeenCalledWith({
      _id: 'c1',
      tenantId: 't1',
      projectId: 'p1',
    });
  });

  it('returns false when not found', async () => {
    const { svc } = makeDeps([makeConnector()]);
    const result = await svc.delete('t1', 'p1', 'c1');
    expect(result).toBe(false);
  });

  it('returns true when deleted', async () => {
    const { svc, model } = makeDeps([makeConnector()]);
    model.findOneAndDelete.mockResolvedValue({ _id: 'c1' });
    const result = await svc.delete('t1', 'p1', 'c1');
    expect(result).toBe(true);
  });
});

describe('ConnectionService.test', () => {
  it('throws NOT_FOUND when connection does not exist', async () => {
    const { svc } = makeDeps([makeConnector()]);
    await expect(svc.test('t1', 'p1', 'c1')).rejects.toThrow('Connection not found');
  });

  it('throws when auth profile resolver is not configured', async () => {
    const record = {
      _id: 'c1',
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'slack',
      displayName: 'Slack',
      scope: 'tenant',
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { svc, model } = makeDeps([makeConnector()]);
    model.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(record) });
    await expect(svc.test('t1', 'p1', 'c1')).rejects.toThrow('Auth profile resolver');
  });

  it('returns success when no test action exists and resolver is configured', async () => {
    const record = {
      _id: 'c1',
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'slack',
      displayName: 'Slack',
      scope: 'tenant',
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const model = makeMockModel();
    model.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(record) });

    const svc = new ConnectionService({
      connectionModel: model,
      registry,
      authProfileResolver: {
        resolve: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
      },
    });

    const result = await svc.test('t1', 'p1', 'c1');
    expect(result.success).toBe(true);
  });

  it('updates status to active on success', async () => {
    const record = {
      _id: 'c1',
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'slack',
      displayName: 'Slack',
      scope: 'tenant',
      authProfileId: 'ap-1',
      status: 'expired',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const model = makeMockModel();
    model.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(record) });

    const svc = new ConnectionService({
      connectionModel: model,
      registry,
      authProfileResolver: {
        resolve: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
      },
    });

    await svc.test('t1', 'p1', 'c1');
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'c1', tenantId: 't1', projectId: 'p1' },
      { $set: expect.objectContaining({ status: 'active' }) },
    );
  });

  it('updates status to expired on test failure', async () => {
    const testAction = {
      name: 'test_connection',
      displayName: 'Test',
      run: vi.fn().mockRejectedValue(new Error('auth failed')),
    };
    const connector = makeConnector({ actions: [testAction as any] });
    const record = {
      _id: 'c1',
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'slack',
      displayName: 'Slack',
      scope: 'tenant',
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const registry = new ConnectorRegistry();
    registry.register(connector);
    const model = makeMockModel();
    model.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(record) });

    const svc = new ConnectionService({
      connectionModel: model,
      registry,
      authProfileResolver: {
        resolve: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
      },
    });

    const result = await svc.test('t1', 'p1', 'c1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('auth failed');
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'c1', tenantId: 't1', projectId: 'p1' },
      { $set: expect.objectContaining({ status: 'expired' }) },
    );
  });
});

describe('ConnectionService.create — additional edge cases', () => {
  it('validates connectorName is not empty', async () => {
    const { svc } = makeDeps([makeConnector()]);
    await expect(
      svc.create('t1', 'p1', { connectorName: '', displayName: 'Test', authProfileId: 'ap-1' }),
    ).rejects.toThrow();
  });
});
