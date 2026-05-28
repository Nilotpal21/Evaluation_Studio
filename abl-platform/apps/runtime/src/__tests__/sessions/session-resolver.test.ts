/**
 * Session Resolver Tests
 *
 * Tests for session resolution logic:
 * - Resolve via explicit sessionId
 * - Resolve via channel artifact
 * - Handle stale resolution keys
 * - 'always_new' strategy
 * - registerResolutionKey
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import { resolveSession, registerResolutionKey } from '../../services/identity/session-resolver.js';
import type { CallerContext } from '@agent-platform/shared/types';
import type { SessionData } from '../../services/session/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: overrides.id || 'session-1',
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

function makeCallerContext(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    tenantId: 'tenant-1',
    channel: 'sdk_websocket',
    identityTier: 0,
    verificationMethod: 'none',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('resolveSession', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  test('resolves via explicit sessionId when session exists', async () => {
    const session = makeSessionData({ id: 'sess-abc' });
    await store.create(session);

    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      explicitSessionId: 'sess-abc',
      callerContext: makeCallerContext(),
    });

    expect(result.outcome).toBe('existing');
    expect(result.sessionId).toBe('sess-abc');
    expect(result.reason).toBe('explicit_session_id');
  });

  test('falls through when explicit sessionId is expired/missing', async () => {
    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      explicitSessionId: 'nonexistent-session',
      callerContext: makeCallerContext(),
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('no_match');
  });

  test('resolves via channel artifact', async () => {
    const session = makeSessionData({ id: 'sess-artifact' });
    await store.create(session);

    // Register a resolution key
    await store.setResolutionKey(
      'tenant-1',
      'channel-1',
      'artifact-hash-123',
      'sess-artifact',
      3600,
    );

    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      callerContext: makeCallerContext({
        channelArtifact: 'artifact-hash-123',
      }),
    });

    expect(result.outcome).toBe('existing');
    expect(result.sessionId).toBe('sess-artifact');
    expect(result.reason).toBe('channel_artifact');
  });

  test('cleans stale resolution keys when session no longer exists', async () => {
    // Set a resolution key pointing to a non-existent session
    await store.setResolutionKey('tenant-1', 'channel-1', 'stale-hash', 'deleted-session', 3600);

    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      callerContext: makeCallerContext({
        channelArtifact: 'stale-hash',
      }),
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('no_match');

    // Resolution key should have been cleaned up
    const key = await store.getResolutionKey('tenant-1', 'channel-1', 'stale-hash');
    expect(key).toBeNull();
  });

  test('returns new for always_new strategy', async () => {
    const session = makeSessionData({ id: 'sess-ignore' });
    await store.create(session);
    await store.setResolutionKey('tenant-1', 'channel-1', 'hash-abc', 'sess-ignore', 3600);

    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      explicitSessionId: 'sess-ignore',
      callerContext: makeCallerContext({
        channelArtifact: 'hash-abc',
      }),
      resolutionStrategy: 'always_new',
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('always_new strategy');
  });

  test('returns new when no artifact and no explicit sessionId', async () => {
    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      callerContext: makeCallerContext(),
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('no_match');
  });

  test('returns new when channelId is missing even with artifact', async () => {
    const session = makeSessionData({ id: 'sess-no-channel' });
    await store.create(session);
    await store.setResolutionKey('tenant-1', 'channel-1', 'some-hash', 'sess-no-channel', 3600);

    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      // No channelId
      callerContext: makeCallerContext({
        channelArtifact: 'some-hash',
      }),
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('no_match');
  });

  // =========================================================================
  // Tenant Isolation
  // =========================================================================

  test('rejects explicit sessionId belonging to a different tenant', async () => {
    const session = makeSessionData({ id: 'sess-tenant-a', tenantId: 'tenant-A' });
    await store.create(session);

    const result = await resolveSession(store, {
      tenantId: 'tenant-B', // Different tenant
      explicitSessionId: 'sess-tenant-a',
      callerContext: makeCallerContext({ tenantId: 'tenant-B' }),
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('tenant_mismatch');
  });

  test('rejects artifact-resolved session belonging to a different tenant', async () => {
    const session = makeSessionData({ id: 'sess-cross-tenant', tenantId: 'tenant-X' });
    await store.create(session);
    // Resolution key exists under tenant-Y (attacker's tenant) but points to tenant-X's session
    await store.setResolutionKey(
      'tenant-Y',
      'channel-1',
      'artifact-xss',
      'sess-cross-tenant',
      3600,
    );

    const result = await resolveSession(store, {
      tenantId: 'tenant-Y',
      channelId: 'channel-1',
      callerContext: makeCallerContext({
        tenantId: 'tenant-Y',
        channelArtifact: 'artifact-xss',
      }),
    });

    expect(result.outcome).toBe('new');
    expect(result.reason).toBe('no_match');

    // Stale cross-tenant resolution key should have been cleaned up
    const key = await store.getResolutionKey('tenant-Y', 'channel-1', 'artifact-xss');
    expect(key).toBeNull();
  });

  test('allows same-tenant session resume via explicit sessionId', async () => {
    const session = makeSessionData({ id: 'sess-same-tenant', tenantId: 'tenant-1' });
    await store.create(session);

    const result = await resolveSession(store, {
      tenantId: 'tenant-1',
      explicitSessionId: 'sess-same-tenant',
      callerContext: makeCallerContext({ tenantId: 'tenant-1' }),
    });

    expect(result.outcome).toBe('existing');
    expect(result.sessionId).toBe('sess-same-tenant');
  });
});

// =============================================================================
// registerResolutionKey
// =============================================================================

describe('registerResolutionKey', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  test('sets resolution key with default TTL', async () => {
    await registerResolutionKey(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      artifactHash: 'hash-abc',
      sessionId: 'sess-123',
    });

    const resolved = await store.getResolutionKey('tenant-1', 'channel-1', 'hash-abc');
    expect(resolved).toBe('sess-123');
  });

  test('sets resolution key with custom TTL', async () => {
    await registerResolutionKey(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-2',
      artifactHash: 'hash-def',
      sessionId: 'sess-456',
      resumeWindowSeconds: 600,
    });

    const resolved = await store.getResolutionKey('tenant-1', 'channel-2', 'hash-def');
    expect(resolved).toBe('sess-456');
  });

  test('overwrites existing resolution key', async () => {
    await registerResolutionKey(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      artifactHash: 'hash-abc',
      sessionId: 'sess-old',
    });

    await registerResolutionKey(store, {
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      artifactHash: 'hash-abc',
      sessionId: 'sess-new',
    });

    const resolved = await store.getResolutionKey('tenant-1', 'channel-1', 'hash-abc');
    expect(resolved).toBe('sess-new');
  });
});
