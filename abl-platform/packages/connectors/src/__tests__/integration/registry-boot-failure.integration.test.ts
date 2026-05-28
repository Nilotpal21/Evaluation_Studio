/**
 * Integration Test: ConnectorRegistry Graceful Degradation (INT-9)
 *
 * Tests that the ConnectorRegistry remains functional when individual
 * connectors fail to register or have broken action handlers.
 *
 * No MongoDB needed — this tests the registry service in isolation.
 * No vi.mock() — real ConnectorRegistry and real connector objects.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectorRegistry } from '../../registry.js';
import {
  testConnector,
  registerTestConnector,
  oauth2TestConnector,
} from '../fixtures/test-connector.js';
import type { Connector, ActionContext } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a connector whose echo action always throws. */
function createBrokenActionConnector(): Connector {
  return {
    name: 'broken-action-connector',
    displayName: 'Broken Action Connector',
    version: '1.0.0',
    description: 'Connector with an action that throws on execution',
    auth: { type: 'none' },
    triggers: [],
    actions: [
      {
        name: 'explode',
        displayName: 'Explode',
        description: 'Always throws',
        props: [],
        async run(_ctx: ActionContext): Promise<unknown> {
          throw new Error('Boom! Action handler exploded');
        },
      },
    ],
  };
}

/** Creates a minimal valid connector with a given name. */
function createSimpleConnector(name: string): Connector {
  return {
    name,
    displayName: `Simple ${name}`,
    version: '1.0.0',
    description: `Simple connector: ${name}`,
    auth: { type: 'none' },
    triggers: [],
    actions: [
      {
        name: 'noop',
        displayName: 'No-Op',
        description: 'Does nothing',
        props: [],
        async run(_ctx: ActionContext): Promise<unknown> {
          return { ok: true };
        },
      },
    ],
  };
}

/** Creates a stub ActionContext for testing action execution. */
function createStubActionContext(params: Record<string, unknown> = {}): ActionContext {
  return {
    auth: {},
    params,
    tenantId: 'test-tenant',
    projectId: 'test-project',
    userId: 'test-user',
    connectionScope: 'tenant',
    executionId: 'exec-001',
    store: {
      async get<T = unknown>(_key: string): Promise<T | undefined> {
        return undefined;
      },
      async set(_key: string, _value: unknown, _ttlMs?: number): Promise<void> {
        /* no-op */
      },
      async delete(_key: string): Promise<void> {
        /* no-op */
      },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConnectorRegistry graceful degradation (INT-9)', () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
  });

  // ── 1. Working connector registers and is usable ──────────────────────────

  it('registers a working connector and exposes its action', async () => {
    registerTestConnector(registry);

    // Connector is retrievable by name
    expect(registry.has('test-connector')).toBe(true);
    const connector = registry.get('test-connector');
    expect(connector.name).toBe('test-connector');
    expect(connector.displayName).toBe('Test Connector');

    // getAction returns the echo action
    const echoAction = registry.getAction('test-connector', 'echo');
    expect(echoAction).toBeDefined();
    expect(echoAction!.name).toBe('echo');

    // Action is executable
    const ctx = createStubActionContext({ message: 'hello' });
    const result = await echoAction!.run(ctx);
    expect(result).toEqual({ echo: 'hello', auth: 'present' });
  });

  // ── 2. Broken action handler doesn't crash registry ──────────────────────

  it('survives a connector whose action handler throws at runtime', async () => {
    // Register both a working and a broken-action connector
    registerTestConnector(registry);
    const brokenConnector = createBrokenActionConnector();
    registry.register(brokenConnector);

    // Both are registered
    expect(registry.has('test-connector')).toBe(true);
    expect(registry.has('broken-action-connector')).toBe(true);

    // The broken action throws when executed
    const brokenAction = registry.getAction('broken-action-connector', 'explode');
    expect(brokenAction).toBeDefined();
    const ctx = createStubActionContext();
    await expect(brokenAction!.run(ctx)).rejects.toThrow('Boom! Action handler exploded');

    // The registry is still fully functional — working connector unaffected
    const echoAction = registry.getAction('test-connector', 'echo');
    expect(echoAction).toBeDefined();
    const echoResult = await echoAction!.run(createStubActionContext({ message: 'still works' }));
    expect(echoResult).toEqual({ echo: 'still works', auth: 'present' });

    // listConnectors returns both
    const connectors = registry.listConnectors();
    expect(connectors).toHaveLength(2);
  });

  // ── 3. Registry survives registering a connector with invalid structure ───

  it('remains functional after a registration failure from invalid connector', () => {
    // Register a working connector first
    registerTestConnector(registry);

    // Attempt to register a structurally invalid connector (missing name).
    // The register() method accesses connector.name — a missing name causes
    // the Map to key on undefined, or the duplicate check may behave unexpectedly.
    // Regardless of how it fails, the working connector must survive.
    const invalidConnector = {
      displayName: 'No Name',
      version: '1.0.0',
      description: 'Missing name field',
      auth: { type: 'none' as const },
      triggers: [],
      actions: [],
    } as unknown as Connector;

    // Attempting to register may or may not throw — we catch either outcome
    try {
      registry.register(invalidConnector);
    } catch {
      // Expected: registration might throw
    }

    // The previously-registered connector is still available
    expect(registry.has('test-connector')).toBe(true);
    const connector = registry.get('test-connector');
    expect(connector.name).toBe('test-connector');
    expect(connector.actions).toHaveLength(1);
  });

  // ── 4. clear() removes all connectors ─────────────────────────────────────

  it('removes all connectors when clear() is called', () => {
    registerTestConnector(registry);
    registry.register(oauth2TestConnector);

    expect(registry.listConnectors()).toHaveLength(2);
    expect(registry.has('test-connector')).toBe(true);
    expect(registry.has('test-connector-oauth')).toBe(true);

    registry.clear();

    expect(registry.listConnectors()).toHaveLength(0);
    expect(registry.has('test-connector')).toBe(false);
    expect(registry.has('test-connector-oauth')).toBe(false);

    // get() throws for cleared connectors
    expect(() => registry.get('test-connector')).toThrow('Unknown connector: test-connector');
  });

  // ── 5. Registry max size enforcement ──────────────────────────────────────

  it('rejects registration when MAX_REGISTRY_SIZE (500) is reached', () => {
    // Fill the registry to capacity. MAX_REGISTRY_SIZE = 500 per registry.ts.
    // We register 500 connectors — the 501st must be rejected.
    for (let i = 0; i < 500; i++) {
      registry.register(createSimpleConnector(`connector-${i}`));
    }

    expect(registry.listConnectors()).toHaveLength(500);

    // The 501st registration must throw
    expect(() => registry.register(createSimpleConnector('connector-overflow'))).toThrow(
      /size limit reached.*500/i,
    );

    // Existing connectors are unaffected
    expect(registry.has('connector-0')).toBe(true);
    expect(registry.has('connector-499')).toBe(true);
    expect(registry.listConnectors()).toHaveLength(500);

    // The rejected connector was NOT added
    expect(registry.has('connector-overflow')).toBe(false);
  });

  // ── 6. listConnectors() returns only successfully registered connectors ───

  it('lists only connectors that were successfully registered', () => {
    // Register a working connector
    registerTestConnector(registry);

    // Attempt to register a duplicate (same name) — should throw
    expect(() => registry.register(testConnector)).toThrow(
      'Connector already registered: test-connector',
    );

    // Register a second distinct connector
    registry.register(createBrokenActionConnector());

    // listConnectors returns exactly the 2 successfully-registered connectors
    const list = registry.listConnectors();
    expect(list).toHaveLength(2);

    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(['broken-action-connector', 'test-connector']);

    // Verify the failed duplicate did not create a second entry
    const testConnectors = list.filter((c) => c.name === 'test-connector');
    expect(testConnectors).toHaveLength(1);
  });
});
