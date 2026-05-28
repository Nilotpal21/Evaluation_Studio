import { describe, it, expect } from 'vitest';
import { resolveConsentState } from '../services/auth-profile/consent-state-resolver.js';
import type { AuthRequirementIR } from '@abl/compiler';

function makeReq(overrides: Partial<AuthRequirementIR> = {}): AuthRequirementIR {
  return {
    connector: 'gmail',
    auth_profile_ref: 'google-creds',
    connection_mode: 'per_user',
    consent_mode: 'preflight',
    ...overrides,
  };
}

describe('resolveConsentState', () => {
  const context = {
    sessionId: 'session-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
  };

  it('returns all pending when no tokens exist', async () => {
    const reqs = [makeReq(), makeReq({ auth_profile_ref: 'sf-creds', connector: 'salesforce' })];
    const lookups = {
      hasSessionToken: async () => false,
      hasUserToken: async () => false,
      hasTenantToken: async () => false,
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.satisfied)).toBe(true);
  });

  it('satisfies via session token (tier 1)', async () => {
    const reqs = [makeReq()];
    const lookups = {
      hasSessionToken: async () => true,
      hasUserToken: async () => false,
      hasTenantToken: async () => false,
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results[0].satisfied).toBe(true);
    expect(results[0].resolvedVia).toBe('session');
  });

  it('satisfies via user token (tier 2) when session token missing', async () => {
    const reqs = [makeReq()];
    const lookups = {
      hasSessionToken: async () => false,
      hasUserToken: async () => true,
      hasTenantToken: async () => false,
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results[0].satisfied).toBe(true);
    expect(results[0].resolvedVia).toBe('user');
  });

  it('satisfies via tenant token (tier 3) for shared connection_mode', async () => {
    const reqs = [makeReq({ connection_mode: 'shared' })];
    const lookups = {
      hasSessionToken: async () => false,
      hasUserToken: async () => false,
      hasTenantToken: async () => true,
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results[0].satisfied).toBe(true);
    expect(results[0].resolvedVia).toBe('tenant');
  });

  it('does not check tenant token for per_user connection_mode', async () => {
    const reqs = [makeReq({ connection_mode: 'per_user' })];
    const lookups = {
      hasSessionToken: async () => false,
      hasUserToken: async () => false,
      hasTenantToken: async () => true, // would match, but per_user skips it
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results[0].satisfied).toBe(false);
  });

  it('does not reuse tenant tokens when tenant fallback is disabled for session-scoped SDK auth', async () => {
    const reqs = [makeReq({ connection_mode: 'shared' })];
    const lookups = {
      hasSessionToken: async () => false,
      hasUserToken: async () => false,
      hasTenantToken: async () => true,
    };

    const results = await resolveConsentState(
      reqs,
      { ...context, allowTenantTokenReuse: false },
      lookups,
    );

    expect(results[0].satisfied).toBe(false);
    expect(results[0].resolvedVia).toBeUndefined();
  });

  it('skips reusable user tokens for session-scoped SDK auth', async () => {
    const reqs = [makeReq()];
    const lookups = {
      hasSessionToken: async () => false,
      hasUserToken: async () => true,
      hasTenantToken: async () => false,
    };

    const results = await resolveConsentState(reqs, { ...context, authScope: 'session' }, lookups);

    expect(results[0].satisfied).toBe(false);
    expect(results[0].resolvedVia).toBeUndefined();
  });

  it('handles lookup errors gracefully (treats as pending)', async () => {
    const reqs = [makeReq()];
    const lookups = {
      hasSessionToken: async () => {
        throw new Error('Redis down');
      },
      hasUserToken: async () => false,
      hasTenantToken: async () => false,
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results[0].satisfied).toBe(false);
  });

  it('prioritizes session token over user token', async () => {
    const reqs = [makeReq()];
    const lookups = {
      hasSessionToken: async () => true,
      hasUserToken: async () => true,
      hasTenantToken: async () => true,
    };

    const results = await resolveConsentState(reqs, context, lookups);
    expect(results[0].satisfied).toBe(true);
    expect(results[0].resolvedVia).toBe('session');
  });
});
