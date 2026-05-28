import { describe, it, expect, vi } from 'vitest';
import { ConnectorToolExecutor } from '../executor/connector-tool-executor.js';
import { ConnectorRegistry } from '../registry.js';
import type { ConnectionResolver, ResolvedConnection } from '../auth/connection-resolver.js';
import type { Connector, ConnectorAction, KeyValueStore } from '../types.js';
import type { IConnectorConnection } from '@agent-platform/database/models';

function makeAction(overrides: Partial<ConnectorAction> = {}): ConnectorAction {
  return {
    name: 'send_message',
    displayName: 'Send Message',
    description: 'Send a message',
    props: [],
    run: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    ...overrides,
  };
}

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    name: 'slack',
    displayName: 'Slack',
    version: '1.0.0',
    description: 'Slack connector',
    auth: { type: 'api_key' },
    triggers: [],
    actions: [makeAction()],
    ...overrides,
  };
}

function makeMockResolver(resolvedScope: 'tenant' | 'user' = 'tenant'): ConnectionResolver {
  return {
    resolve: vi.fn().mockResolvedValue({
      connection: {
        _id: 'conn-1',
        tenantId: 't-1',
        projectId: 'p-1',
        connectorName: 'slack',
        displayName: 'Slack Connection',
        scope: resolvedScope,
        authProfileId: 'ap-1',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IConnectorConnection,
      scope: resolvedScope,
    } satisfies ResolvedConnection),
    resolveAuth: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
  } as unknown as ConnectionResolver;
}

describe('ConnectorToolExecutor', () => {
  it('resolves connection, decrypts auth, executes action.run()', async () => {
    const registry = new ConnectorRegistry();
    const connector = makeConnector();
    registry.register(connector);
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    const result = await executor.execute(
      'slack.send_message',
      { channel: '#general', text: 'hello' },
      30_000,
    );

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ connectorName: 'slack', tenantId: 't-1' }),
    );
    expect(resolver.resolveAuth).toHaveBeenCalled();

    const action = connector.actions[0];
    expect(action.run).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { apiKey: 'sk-123' },
        params: { channel: '#general', text: 'hello' },
        tenantId: 't-1',
        projectId: 'p-1',
        connectionScope: 'tenant',
      }),
    );
  });

  it('passes userId to connection resolver', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const resolver = makeMockResolver('user');

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
      userId: 'u-1',
    });

    await executor.execute('slack.send_message', {}, 30_000);

    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }));
  });

  it('times out after specified duration', async () => {
    const registry = new ConnectorRegistry();
    const slowAction = makeAction({
      run: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
    });
    registry.register(makeConnector({ actions: [slowAction] }));
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await expect(executor.execute('slack.send_message', {}, 50)).rejects.toThrow('timed out');
  });

  it('throws on unknown connector', async () => {
    const registry = new ConnectorRegistry();
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await expect(executor.execute('unknown.action', {}, 30_000)).rejects.toThrow(
      'Unknown connector: unknown',
    );
  });

  it('throws on unknown action', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await expect(executor.execute('slack.nonexistent', {}, 30_000)).rejects.toThrow(
      'Action "nonexistent" not found',
    );
  });

  it('throws on invalid tool name format', async () => {
    const registry = new ConnectorRegistry();
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await expect(executor.execute('no-dot-name', {}, 30_000)).rejects.toThrow(
      'expected format "connector.action"',
    );
  });

  it('provides executionId in action context', async () => {
    const registry = new ConnectorRegistry();
    const action = makeAction();
    registry.register(makeConnector({ actions: [action] }));
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await executor.execute('slack.send_message', {}, 30_000);

    expect(action.run).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: expect.any(String),
      }),
    );
  });

  it('uses provided KV store', async () => {
    const registry = new ConnectorRegistry();
    const action = makeAction();
    registry.register(makeConnector({ actions: [action] }));
    const resolver = makeMockResolver();

    const mockStore: KeyValueStore = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };

    const executor = new ConnectorToolExecutor(
      registry,
      resolver,
      {
        tenantId: 't-1',
        projectId: 'p-1',
      },
      mockStore,
    );

    await executor.execute('slack.send_message', {}, 30_000);

    expect(action.run).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
  });

  it('propagates action errors', async () => {
    const registry = new ConnectorRegistry();
    const failingAction = makeAction({
      run: vi.fn().mockRejectedValue(new Error('Slack API error: channel_not_found')),
    });
    registry.register(makeConnector({ actions: [failingAction] }));
    const resolver = makeMockResolver();

    const executor = new ConnectorToolExecutor(registry, resolver, {
      tenantId: 't-1',
      projectId: 'p-1',
    });

    await expect(executor.execute('slack.send_message', {}, 30_000)).rejects.toThrow(
      'channel_not_found',
    );
  });
});
