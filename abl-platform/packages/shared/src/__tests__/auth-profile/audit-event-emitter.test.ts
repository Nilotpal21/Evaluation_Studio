/**
 * Audit Event Emitter Tests
 *
 * Tests the deduplication logic, all 10 event types, and error handling.
 * Uses dependency injection (DI) via the `deps` parameter — no vi.mock needed.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  emitAuthProfileAuditEvent,
  _resetDedupeMap,
  type AuthProfileAuditEventType,
  type AuthProfileAuditEventInput,
  type AuditEventEmitterDeps,
} from '../../services/auth-profile/audit-event-emitter.js';

function buildInput(
  overrides: Partial<AuthProfileAuditEventInput> = {},
): AuthProfileAuditEventInput {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    profileId: 'profile-1',
    eventType: 'authorized',
    actorUserId: 'user-1',
    actorContext: { source: 'profile' },
    eventPayload: {},
    ...overrides,
  };
}

function buildDeps(createFn?: AuditEventEmitterDeps['create']): AuditEventEmitterDeps {
  return {
    create: createFn ?? vi.fn().mockResolvedValue({ _id: 'test-event-id' }),
  };
}

describe('emitAuthProfileAuditEvent', () => {
  beforeEach(() => {
    _resetDedupeMap();
  });

  afterEach(() => {
    _resetDedupeMap();
  });

  // ─── All 10 Event Types ───────────────────────────────────────────

  const EVENT_TYPES: AuthProfileAuditEventType[] = [
    'authorized',
    'authorize_failed',
    'token_refreshed',
    'token_refresh_failed',
    'profile_revoked',
    'tokens_revoked',
    'profile_updated',
    'sensitive_field_changed',
    'profile_deleted',
    'scope_insufficient_detected',
  ];

  for (const eventType of EVENT_TYPES) {
    it(`writes event type "${eventType}" to the collection`, async () => {
      const deps = buildDeps();
      await emitAuthProfileAuditEvent(buildInput({ eventType }), deps);

      expect(deps.create).toHaveBeenCalledOnce();
      expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ eventType }));
    });
  }

  // ─── Full Payload Schema ──────────────────────────────────────────

  it('writes the full payload structure', async () => {
    const deps = buildDeps();
    const input = buildInput({
      tenantId: 'tenant-abc',
      projectId: 'project-xyz',
      profileId: 'profile-123',
      eventType: 'token_refreshed',
      actorUserId: 'user-456',
      actorContext: {
        source: 'session_init',
        requestId: 'req-789',
        sessionId: 'sess-012',
      },
      eventPayload: { expiresIn: 3600 },
    });

    await emitAuthProfileAuditEvent(input, deps);

    expect(deps.create).toHaveBeenCalledWith({
      tenantId: 'tenant-abc',
      projectId: 'project-xyz',
      profileId: 'profile-123',
      eventType: 'token_refreshed',
      actorUserId: 'user-456',
      actorContext: {
        source: 'session_init',
        requestId: 'req-789',
        sessionId: 'sess-012',
      },
      eventPayload: { expiresIn: 3600 },
    });
  });

  it('writes event with null projectId', async () => {
    const deps = buildDeps();
    await emitAuthProfileAuditEvent(buildInput({ projectId: null }), deps);

    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it('writes event with null actorUserId', async () => {
    const deps = buildDeps();
    await emitAuthProfileAuditEvent(buildInput({ actorUserId: null }), deps);

    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null }));
  });

  // ─── Idempotency / Deduplication ─────────────────────────────────

  it('deduplicates events with same (tenantId, profileId, eventType, requestId)', async () => {
    const deps = buildDeps();
    const input = buildInput({
      actorContext: { source: 'profile', requestId: 'req-123' },
    });

    await emitAuthProfileAuditEvent(input, deps);
    await emitAuthProfileAuditEvent(input, deps);
    await emitAuthProfileAuditEvent(input, deps);

    // Only the first call should write to DB
    expect(deps.create).toHaveBeenCalledOnce();
  });

  it('does NOT deduplicate events without requestId', async () => {
    const deps = buildDeps();
    const input = buildInput({
      actorContext: { source: 'profile' }, // no requestId
    });

    await emitAuthProfileAuditEvent(input, deps);
    await emitAuthProfileAuditEvent(input, deps);

    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  it('does NOT deduplicate events with different requestIds', async () => {
    const deps = buildDeps();
    await emitAuthProfileAuditEvent(
      buildInput({ actorContext: { source: 'profile', requestId: 'req-1' } }),
      deps,
    );
    await emitAuthProfileAuditEvent(
      buildInput({ actorContext: { source: 'profile', requestId: 'req-2' } }),
      deps,
    );

    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  it('does NOT deduplicate events with different event types', async () => {
    const deps = buildDeps();
    const base = {
      actorContext: { source: 'profile' as const, requestId: 'req-same' },
    };

    await emitAuthProfileAuditEvent(buildInput({ ...base, eventType: 'authorized' }), deps);
    await emitAuthProfileAuditEvent(buildInput({ ...base, eventType: 'token_refreshed' }), deps);

    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  it('does NOT deduplicate events with different profileIds', async () => {
    const deps = buildDeps();
    const base = {
      actorContext: { source: 'profile' as const, requestId: 'req-same' },
    };

    await emitAuthProfileAuditEvent(buildInput({ ...base, profileId: 'profile-A' }), deps);
    await emitAuthProfileAuditEvent(buildInput({ ...base, profileId: 'profile-B' }), deps);

    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  // ─── Scope Isolation ──────────────────────────────────────────────

  it('does NOT deduplicate events across tenants with same requestId', async () => {
    const deps = buildDeps();
    const base = {
      actorContext: { source: 'profile' as const, requestId: 'req-same' },
    };

    await emitAuthProfileAuditEvent(buildInput({ ...base, tenantId: 'tenant-A' }), deps);
    await emitAuthProfileAuditEvent(buildInput({ ...base, tenantId: 'tenant-B' }), deps);

    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  // ─── Error Handling ───────────────────────────────────────────────

  it('swallows DB write errors (audit events are non-critical)', async () => {
    const deps = buildDeps(vi.fn().mockRejectedValue(new Error('MongoDB connection failed')));

    // Should not throw
    await expect(emitAuthProfileAuditEvent(buildInput(), deps)).resolves.toBeUndefined();
  });

  it('does not record dedupe entry on failed write', async () => {
    const failCreate = vi.fn().mockRejectedValueOnce(new Error('Write failed'));
    const successCreate = vi.fn().mockResolvedValueOnce({ _id: 'retry-id' });

    const input = buildInput({
      actorContext: { source: 'profile', requestId: 'req-retry' },
    });

    await emitAuthProfileAuditEvent(input, { create: failCreate });
    // First write failed, so dedupe should not block retry
    await emitAuthProfileAuditEvent(input, { create: successCreate });

    expect(failCreate).toHaveBeenCalledOnce();
    expect(successCreate).toHaveBeenCalledOnce();
  });
});
