import { describe, it, expect } from 'vitest';
import { ConnectorRegistry } from '../registry.js';
import type { Connector } from '../types.js';

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    name: 'slack',
    displayName: 'Slack',
    version: '1.0.0',
    description: 'Slack connector',
    auth: { type: 'api_key' },
    triggers: [
      {
        name: 'new_message',
        displayName: 'New Message',
        description: 'New Slack message',
        triggerType: 'webhook',
        props: [],
        onEnable: async () => {},
        onDisable: async () => {},
        run: async () => [],
      },
    ],
    actions: [
      {
        name: 'send_message',
        displayName: 'Send Message',
        description: 'Send a Slack message',
        props: [],
        run: async () => ({ messageId: 'msg-1' }),
      },
    ],
    ...overrides,
  };
}

describe('ConnectorRegistry', () => {
  it('registers and retrieves connector by name', async () => {
    const registry = new ConnectorRegistry();
    const slack = makeConnector();
    registry.register(slack);
    expect(await registry.get('slack')).toBe(slack);
    expect(registry.has('slack')).toBe(true);
    expect(registry.listConnectors()).toHaveLength(1);
  });

  it('getAction returns specific action', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const action = await registry.getAction('slack', 'send_message');
    expect(action?.name).toBe('send_message');
  });

  it('getAction returns undefined for unknown action', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const action = await registry.getAction('slack', 'nonexistent');
    expect(action).toBeUndefined();
  });

  it('getTrigger returns specific trigger', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const trigger = await registry.getTrigger('slack', 'new_message');
    expect(trigger?.name).toBe('new_message');
  });

  it('getTrigger returns undefined for unknown trigger', async () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    const trigger = await registry.getTrigger('slack', 'nonexistent');
    expect(trigger).toBeUndefined();
  });

  it('throws on unknown connector', async () => {
    const registry = new ConnectorRegistry();
    await expect(registry.get('unknown')).rejects.toThrow('Unknown connector: unknown');
  });

  it('throws on duplicate registration', () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    expect(() => registry.register(makeConnector())).toThrow('Connector already registered: slack');
  });

  it('lists multiple connectors', () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector({ name: 'slack' }));
    registry.register(makeConnector({ name: 'stripe', displayName: 'Stripe' }));
    expect(registry.listConnectors()).toHaveLength(2);
  });

  it('has returns false for unregistered connector', () => {
    const registry = new ConnectorRegistry();
    expect(registry.has('unknown')).toBe(false);
  });

  it('clear removes all connectors', () => {
    const registry = new ConnectorRegistry();
    registry.register(makeConnector());
    expect(registry.listConnectors()).toHaveLength(1);
    registry.clear();
    expect(registry.listConnectors()).toHaveLength(0);
    expect(registry.has('slack')).toBe(false);
  });

  it('throws when max registry size is exceeded', () => {
    const registry = new ConnectorRegistry();
    // Register 500 connectors (the max)
    for (let i = 0; i < 500; i++) {
      registry.register(makeConnector({ name: `connector-${i}` }));
    }
    expect(registry.listConnectors()).toHaveLength(500);
    // The 501st should throw
    expect(() => registry.register(makeConnector({ name: 'connector-500' }))).toThrow(
      /size limit reached/,
    );
  });
});
