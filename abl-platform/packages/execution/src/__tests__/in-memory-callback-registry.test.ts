import { describe, expect, it } from 'vitest';
import { InMemoryCallbackRegistry } from '../in-memory-callback-registry.js';

describe('InMemoryCallbackRegistry', () => {
  it('registers, looks up, and claims callbacks exactly once', async () => {
    const registry = new InMemoryCallbackRegistry();
    const entry = {
      callbackId: 'cb-1',
      suspensionId: 'susp-1',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      expiresAt: Date.now() + 60_000,
    };

    await registry.register(entry);

    await expect(registry.lookup('cb-1')).resolves.toEqual(entry);
    await expect(registry.claim('cb-1')).resolves.toEqual(entry);
    await expect(registry.lookup('cb-1')).resolves.toBeNull();
    await expect(registry.claim('cb-1')).resolves.toBeNull();
  });

  it('does not register expired callbacks', async () => {
    const registry = new InMemoryCallbackRegistry();

    await registry.register({
      callbackId: 'cb-expired',
      suspensionId: 'susp-expired',
      sessionId: 'session-expired',
      tenantId: 'tenant-1',
      expiresAt: Date.now() - 1,
    });

    await expect(registry.lookup('cb-expired')).resolves.toBeNull();
  });

  it('keeps the first unexpired registration for a callback id', async () => {
    const registry = new InMemoryCallbackRegistry();
    const first = {
      callbackId: 'cb-dup',
      suspensionId: 'susp-1',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      expiresAt: Date.now() + 60_000,
    };
    const second = {
      ...first,
      suspensionId: 'susp-2',
    };

    await registry.register(first);
    await registry.register(second);

    await expect(registry.lookup('cb-dup')).resolves.toEqual(first);
  });
});
