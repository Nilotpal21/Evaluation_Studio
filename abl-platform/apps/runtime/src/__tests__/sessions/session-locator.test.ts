import { describe, expect, it } from 'vitest';

import { buildProductionSessionLocator } from '../../services/session/execution-scope.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import { SessionService } from '../../services/session/session-service.js';

describe('SessionLocator scoped session access', () => {
  it('loads, versions, locks, touches, and deletes a production session through scoped service methods', async () => {
    const store = new MemorySessionStore();
    const service = new SessionService(store);

    await service.createSession({
      id: 'locator-session-1',
      agentName: 'locator-agent',
      agentIR: null,
      compilationOutput: null,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      executionScopeKind: 'production',
    });

    const locator = buildProductionSessionLocator({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'locator-session-1',
    });

    expect(locator).not.toBeNull();

    const loaded = await service.loadSessionScoped(locator!);
    expect(loaded).toMatchObject({
      id: 'locator-session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      executionScopeKind: 'production',
    });

    await expect(service.getVersionScoped(locator!)).resolves.toBe(0);
    await expect(service.acquireLockScoped(locator!)).resolves.toBe(true);
    await expect(service.releaseLockScoped(locator!)).resolves.toBeUndefined();
    await expect(service.touchScoped(locator!)).resolves.toBeUndefined();
    await expect(
      service.setAgentRegistryScoped(locator!, { 'locator-agent': 'hash-locator-agent' }),
    ).resolves.toBeUndefined();
    await expect(service.getAgentRegistryScoped(locator!)).resolves.toEqual({
      'locator-agent': 'hash-locator-agent',
    });

    await service.deleteSessionScoped(locator!);
    await expect(service.loadSessionScoped(locator!)).resolves.toBeNull();
  });
});
