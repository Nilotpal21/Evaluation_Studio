/**
 * Resolve Session Use Case Tests
 *
 * Validates session resolution via a port-based store interface.
 * Tests: artifact found -> returns existing session, no match -> returns create-new signal.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ResolveSession,
  type SessionResolutionStore,
} from '../../../../contexts/identity/use-cases/resolve-session.js';
import { RegisterResolutionKey } from '../../../../contexts/identity/use-cases/register-resolution-key.js';
import type { SessionResolutionKey } from '../../../../contexts/identity/domain/session-resolution-key.js';
import { normalizeSessionResolutionRecord } from '../../../../contexts/identity/domain/session-resolution-record.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockStore(storedSessionId?: string): SessionResolutionStore {
  return {
    findByKey: vi.fn().mockResolvedValue(
      storedSessionId
        ? normalizeSessionResolutionRecord({
            tenantId: 'tenant-001',
            channelId: 'ch-web-main',
            artifactHash: 'abc123hash',
            sessionId: storedSessionId,
            expiresAt: new Date('2026-12-31T23:59:59.000Z'),
          })
        : null,
    ),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// RESOLVE SESSION TESTS
// =============================================================================

describe('ResolveSession', () => {
  const TENANT_ID = 'tenant-001';
  const CHANNEL_ID = 'ch-web-main';
  const ARTIFACT_HASH = 'abc123hash';

  describe('execute()', () => {
    it('returns found=true with sessionId when resolution key exists', async () => {
      const store = createMockStore('existing-session-id');
      const useCase = new ResolveSession(store);

      const result = await useCase.execute(TENANT_ID, CHANNEL_ID, ARTIFACT_HASH);

      expect(result.found).toBe(true);
      expect(result.sessionId).toBe('existing-session-id');
      expect(result.sessionPrincipalId).toBe('existing-session-id');
      expect(result.sessionLocator).toEqual({
        tenantId: TENANT_ID,
        projectId: '',
        sessionId: 'existing-session-id',
      });
      expect(store.findByKey).toHaveBeenCalledWith(TENANT_ID, CHANNEL_ID, ARTIFACT_HASH);
    });

    it('returns found=false when no resolution key matches', async () => {
      const store = createMockStore(undefined);
      const useCase = new ResolveSession(store);

      const result = await useCase.execute(TENANT_ID, CHANNEL_ID, ARTIFACT_HASH);

      expect(result.found).toBe(false);
      expect(result.sessionId).toBeUndefined();
      expect(store.findByKey).toHaveBeenCalledWith(TENANT_ID, CHANNEL_ID, ARTIFACT_HASH);
    });

    it('passes tenant, channel, and artifact hash to the store', async () => {
      const store = createMockStore(undefined);
      const useCase = new ResolveSession(store);

      await useCase.execute('tenant-X', 'ch-voice', 'hashXYZ');

      expect(store.findByKey).toHaveBeenCalledWith('tenant-X', 'ch-voice', 'hashXYZ');
    });
  });
});

// =============================================================================
// REGISTER RESOLUTION KEY TESTS
// =============================================================================

describe('RegisterResolutionKey', () => {
  it('stores the resolution key via the port', async () => {
    const store = createMockStore();
    const useCase = new RegisterResolutionKey(store);

    const key: SessionResolutionKey = {
      tenantId: 'tenant-001',
      channelId: 'ch-web-main',
      artifactHash: 'abc123hash',
      sessionId: 'sess-new-001',
      expiresAt: new Date(Date.now() + 3600_000),
    };

    await useCase.execute(key);

    expect(store.save).toHaveBeenCalledWith(key);
  });

  it('passes the full key object without modification', async () => {
    const store = createMockStore();
    const useCase = new RegisterResolutionKey(store);

    const expiresAt = new Date('2026-12-31T23:59:59Z');
    const key: SessionResolutionKey = {
      tenantId: 'tenant-999',
      channelId: 'ch-sms-prod',
      artifactHash: 'deadbeef',
      sessionId: 'sess-999',
      expiresAt,
    };

    await useCase.execute(key);

    const savedKey = (store.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedKey.tenantId).toBe('tenant-999');
    expect(savedKey.channelId).toBe('ch-sms-prod');
    expect(savedKey.artifactHash).toBe('deadbeef');
    expect(savedKey.sessionId).toBe('sess-999');
    expect(savedKey.expiresAt).toBe(expiresAt);
  });
});
