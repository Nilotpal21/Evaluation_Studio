/**
 * `ConnectionResolver.resolveAuth` — no-auth short-circuit
 * (LLD Phase 2 Task 2.6 / FR-15).
 *
 * Asserts that when the `ConnectorConnection.metadata.authType === 'none'`
 * the resolver returns `{}` without invoking `authProfileResolver.resolve`.
 * The synthetic Docling AuthProfile carries empty `encryptedSecrets`;
 * asking the encryption facade to decrypt them would be wasteful at best
 * and throw on a malformed ciphertext at worst.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConnectionResolver } from '../auth/connection-resolver.js';
import type { IConnectorConnection } from '@agent-platform/database/models';
import type { AuthProfileResolverLike } from '../services/connection-service.js';

function buildConnection(overrides: Partial<IConnectorConnection> = {}): IConnectorConnection {
  return {
    _id: 'conn-1',
    tenantId: 't-1',
    projectId: 'p-1',
    connectorName: 'docling',
    displayName: 'Docling',
    scope: 'tenant',
    authProfileId: 'profile-1',
    metadata: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IConnectorConnection;
}

describe('ConnectionResolver.resolveAuth — no-auth short-circuit', () => {
  it('returns `{}` and skips authProfileResolver when metadata.authType === "none"', async () => {
    const resolve = vi.fn();
    const authProfileResolver: AuthProfileResolverLike = { resolve };
    const resolver = new ConnectionResolver({ findOne: vi.fn() } as never, authProfileResolver);

    const connection = buildConnection({
      metadata: { authType: 'none', synthetic: true },
    });
    const auth = await resolver.resolveAuth(connection);

    expect(auth).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
  });

  it('invokes authProfileResolver when metadata is null (legacy connections)', async () => {
    const resolve = vi.fn().mockResolvedValue({ apiKey: 'sk-test' });
    const authProfileResolver: AuthProfileResolverLike = { resolve };
    const resolver = new ConnectionResolver({ findOne: vi.fn() } as never, authProfileResolver);

    const connection = buildConnection({ metadata: null });
    const auth = await resolver.resolveAuth(connection);

    expect(auth).toEqual({ apiKey: 'sk-test' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('invokes authProfileResolver when metadata.authType is something else', async () => {
    const resolve = vi.fn().mockResolvedValue({ apiKey: 'sk-test' });
    const authProfileResolver: AuthProfileResolverLike = { resolve };
    const resolver = new ConnectionResolver({ findOne: vi.fn() } as never, authProfileResolver);

    const connection = buildConnection({
      metadata: { authType: 'api_key', vendor: 'azure' },
    });
    await resolver.resolveAuth(connection);

    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
