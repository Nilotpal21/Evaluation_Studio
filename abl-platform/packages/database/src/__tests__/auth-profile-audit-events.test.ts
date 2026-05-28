import { describe, test, expect } from 'vitest';
import { AUTH_PROFILE_AUDIT_EVENTS } from '../auth-profile/audit-events.js';

describe('AuthProfile audit event constants', () => {
  test('exports exactly 14 distinct audit events', () => {
    const events = Object.values(AUTH_PROFILE_AUDIT_EVENTS);
    expect(events).toHaveLength(14);
    expect(new Set(events).size).toBe(14);
  });

  test('each event starts with AUTH_PROFILE_ prefix', () => {
    for (const event of Object.values(AUTH_PROFILE_AUDIT_EVENTS)) {
      expect(event).toMatch(/^AUTH_PROFILE_/);
    }
  });

  test('contains all required event types', () => {
    expect(AUTH_PROFILE_AUDIT_EVENTS.CREATED).toBe('AUTH_PROFILE_CREATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.UPDATED).toBe('AUTH_PROFILE_UPDATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.DELETED).toBe('AUTH_PROFILE_DELETED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.REVOKED).toBe('AUTH_PROFILE_REVOKED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.VALIDATED).toBe('AUTH_PROFILE_VALIDATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.SECRET_ROTATED).toBe('AUTH_PROFILE_SECRET_ROTATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.TOKEN_REFRESHED).toBe('AUTH_PROFILE_TOKEN_REFRESHED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.OAUTH_INITIATED).toBe('AUTH_PROFILE_OAUTH_INITIATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.OAUTH_COMPLETED).toBe('AUTH_PROFILE_OAUTH_COMPLETED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.OAUTH_FAILED).toBe('AUTH_PROFILE_OAUTH_FAILED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.CONSUMER_LINKED).toBe('AUTH_PROFILE_CONSUMER_LINKED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.CONSUMER_UNLINKED).toBe('AUTH_PROFILE_CONSUMER_UNLINKED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.ACCESS_DENIED).toBe('AUTH_PROFILE_ACCESS_DENIED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.DECRYPTION_FAILED).toBe('AUTH_PROFILE_DECRYPTION_FAILED');
  });
});
