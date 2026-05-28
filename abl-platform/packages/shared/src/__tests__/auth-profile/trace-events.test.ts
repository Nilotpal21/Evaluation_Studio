/**
 * Task 39: Trace events tests
 */
import { describe, it, expect, vi } from 'vitest';
import {
  emitAuthProfileTraceEvent,
  AUTH_PROFILE_TRACE_EVENTS,
} from '@agent-platform/shared-auth-profile';

describe('AUTH_PROFILE_TRACE_EVENTS', () => {
  it('exports distinct trace event types with no duplicates', () => {
    const events = Object.values(AUTH_PROFILE_TRACE_EVENTS);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events).size).toBe(events.length);
  });

  it('all events start with auth_profile. prefix', () => {
    for (const event of Object.values(AUTH_PROFILE_TRACE_EVENTS)) {
      expect(event).toMatch(/^auth_profile\./);
    }
  });
});

describe('emitAuthProfileTraceEvent', () => {
  it('emits a trace event without throwing', () => {
    expect(() =>
      emitAuthProfileTraceEvent({
        eventType: AUTH_PROFILE_TRACE_EVENTS.CREDENTIAL_RESOLVED,
        profileId: 'ap-1',
        tenantId: 'tenant-1',
        authType: 'bearer',
        timestamp: new Date().toISOString(),
        metadata: { cached: false },
      }),
    ).not.toThrow();
  });
});
