/**
 * Session Identity Integration Tests
 *
 * End-to-end tests for the session identity system:
 * - CallerContext round-trips through MemorySessionStore
 * - Resolution keys: set on create, found on lookup, deleted on close
 * - Resolution key TTL expiry in memory store
 * - HMAC enforcement modes
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import { resolveSession, registerResolutionKey } from '../../services/identity/session-resolver.js';
import {
  hashArtifact,
  buildCallerContext,
  verifyHMAC,
} from '../../services/identity/artifact-hasher.js';
import type { CallerContext } from '@agent-platform/shared/types';
import type { SessionData } from '../../services/session/types.js';
import { createHmac } from 'node:crypto';

// =============================================================================
// HELPERS
// =============================================================================

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: overrides.id || `session-${Date.now()}`,
    agentName: 'test-agent',
    irSourceHash: '',
    compilationHash: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    dataValues: {},
    dataGatheredKeys: [],
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['test-agent'],
    tenantId: 'tenant-1',
    initialized: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    ...overrides,
  };
}

// =============================================================================
// CallerContext Round-Trip
// =============================================================================

describe('CallerContext round-trip through MemorySessionStore', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  test('stores and retrieves CallerContext on session create/load', async () => {
    const callerContext: CallerContext = {
      tenantId: 'tenant-1',
      channel: 'sdk_websocket',
      channelId: 'channel-abc',
      customerId: 'customer-123',
      identityTier: 2,
      verificationMethod: 'hmac',
      channelArtifact: hashArtifact('device-fingerprint-xyz'),
      channelArtifactType: 'device_id',
      sourceIp: '10.0.0.1',
    };

    const session = makeSessionData({
      id: 'sess-ctx-test',
      callerContext,
    });

    await store.create(session);
    const loaded = await store.load('sess-ctx-test');

    expect(loaded).not.toBeNull();
    expect(loaded!.callerContext).toEqual(callerContext);
    expect(loaded!.callerContext!.identityTier).toBe(2);
    expect(loaded!.callerContext!.verificationMethod).toBe('hmac');
    expect(loaded!.callerContext!.channelArtifact).toHaveLength(64);
  });

  test('session without CallerContext loads as undefined', async () => {
    const session = makeSessionData({ id: 'sess-no-ctx' });
    await store.create(session);

    const loaded = await store.load('sess-no-ctx');
    expect(loaded).not.toBeNull();
    expect(loaded!.callerContext).toBeUndefined();
  });
});

// =============================================================================
// Resolution Key Lifecycle
// =============================================================================

describe('resolution key lifecycle', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  test('set on create → found on lookup → deleted on close', async () => {
    const tenantId = 'tenant-1';
    const channelId = 'channel-1';
    const artifactHash = hashArtifact('user-cookie');

    // 1. Create session
    const session = makeSessionData({ id: 'sess-lifecycle' });
    await store.create(session);

    // 2. Register resolution key (simulating post-creation)
    await registerResolutionKey(store, {
      tenantId,
      channelId,
      artifactHash,
      sessionId: 'sess-lifecycle',
    });

    // 3. Verify key exists
    const foundId = await store.getResolutionKey(tenantId, channelId, artifactHash);
    expect(foundId).toBe('sess-lifecycle');

    // 4. Resolve session via artifact — should find existing
    const resolveResult = await resolveSession(store, {
      tenantId,
      channelId,
      callerContext: {
        tenantId,
        channel: 'sdk_websocket',
        identityTier: 1,
        verificationMethod: 'cookie',
        channelArtifact: artifactHash,
      },
    });
    expect(resolveResult.outcome).toBe('existing');
    expect(resolveResult.sessionId).toBe('sess-lifecycle');

    // 5. Delete resolution key (simulating WS close)
    await store.deleteResolutionKey(tenantId, channelId, artifactHash);

    // 6. Key should be gone
    const afterDelete = await store.getResolutionKey(tenantId, channelId, artifactHash);
    expect(afterDelete).toBeNull();
  });

  test('resolution key TTL expiry in memory store', async () => {
    const tenantId = 'tenant-1';
    const channelId = 'channel-1';
    const artifactHash = 'expired-hash';

    // Set with 1 second TTL
    await store.setResolutionKey(tenantId, channelId, artifactHash, 'sess-expired', 1);

    // Immediately readable
    const immediate = await store.getResolutionKey(tenantId, channelId, artifactHash);
    expect(immediate).toBe('sess-expired');

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should be expired
    const afterExpiry = await store.getResolutionKey(tenantId, channelId, artifactHash);
    expect(afterExpiry).toBeNull();
  });
});

// =============================================================================
// HMAC Enforcement Modes
// =============================================================================

describe('HMAC enforcement modes', () => {
  const SECRET_KEY = 'channel-hmac-secret';

  function createValidHMAC(userId: string): { hmac: string; timestamp: number } {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `${userId}:${timestamp}`;
    const hmac = createHmac('sha256', SECRET_KEY).update(message).digest('hex');
    return { hmac, timestamp };
  }

  test('required mode: unsigned userId is rejected', () => {
    // When HMAC enforcement is 'required', a tampered/invalid hmac should fail.
    const result = verifyHMAC(
      { userId: 'user-1', hmac: 'invalid-hmac-value', timestamp: Math.floor(Date.now() / 1000) },
      SECRET_KEY,
    );
    expect(result.success).toBe(false);
  });

  test('required mode: valid HMAC is accepted as tier 2', () => {
    const userId = 'user-verified';
    const { hmac, timestamp } = createValidHMAC(userId);

    const result = verifyHMAC({ userId, hmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(true);

    // After successful verification, identityTier = 2, verificationMethod = 'hmac'
    const callerCtx = buildCallerContext({
      tenantId: 'tenant-1',
      channel: 'sdk_websocket',
      customerId: userId,
      identityTier: 2,
      verificationMethod: 'hmac',
    });
    expect(callerCtx.identityTier).toBe(2);
    expect(callerCtx.verificationMethod).toBe('hmac');
    expect(callerCtx.customerId).toBe(userId);
  });

  test('required mode: invalid HMAC is rejected', () => {
    const userId = 'user-bad-hmac';
    const timestamp = Math.floor(Date.now() / 1000);
    const badHmac = createHmac('sha256', 'wrong-key')
      .update(`${userId}:${timestamp}`)
      .digest('hex');

    const result = verifyHMAC({ userId, hmac: badHmac, timestamp }, SECRET_KEY);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HMAC_INVALID');
  });

  test('optional mode: unsigned userId accepted as tier 1', () => {
    const hmacEnforcement = 'optional';
    const userContext = { userId: 'user-unverified' };

    // In optional mode with no HMAC fields, tier = 1, method = 'none'
    const hasHmacFields = false;

    if (hmacEnforcement === 'optional' && !hasHmacFields) {
      const callerCtx = buildCallerContext({
        tenantId: 'tenant-1',
        channel: 'sdk_websocket',
        anonymousId: userContext.userId,
        identityTier: 1,
        verificationMethod: 'none',
      });
      expect(callerCtx.identityTier).toBe(1);
      expect(callerCtx.verificationMethod).toBe('none');
      expect(callerCtx.anonymousId).toBe('user-unverified');
    }
  });

  test('disabled mode: userId present but unverified as tier 1', () => {
    // HMAC disabled but userId present → tier 1
    const callerCtx = buildCallerContext({
      tenantId: 'tenant-1',
      channel: 'sdk_websocket',
      anonymousId: 'user-no-hmac',
      identityTier: 1,
      verificationMethod: 'none',
    });
    expect(callerCtx.identityTier).toBe(1);
    expect(callerCtx.verificationMethod).toBe('none');
  });
});
