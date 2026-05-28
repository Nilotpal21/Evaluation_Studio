/**
 * isAuthorized Computation Tests
 *
 * Tests the `computeIsAuthorized` and `deriveProfileType` helper functions
 * from auth-profile.service.ts.
 * Uses dependency injection (DI) via the `deps` parameter — no vi.mock needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeIsAuthorized,
  deriveProfileType,
  type ComputeIsAuthorizedDeps,
} from '../../services/auth-profile.service.js';

function buildDeps(findOneFn?: ComputeIsAuthorizedDeps['findOne']): ComputeIsAuthorizedDeps {
  return {
    findOne: findOneFn ?? vi.fn().mockResolvedValue(null),
  };
}

describe('deriveProfileType', () => {
  it('returns existing profileType when set to "integration"', () => {
    expect(deriveProfileType({ profileType: 'integration', connector: 'slack' })).toBe(
      'integration',
    );
  });

  it('returns existing profileType when set to "custom"', () => {
    expect(deriveProfileType({ profileType: 'custom', connector: undefined })).toBe('custom');
  });

  it('derives "integration" when profileType is null and connector is present', () => {
    expect(deriveProfileType({ profileType: null, connector: 'github' })).toBe('integration');
  });

  it('derives "custom" when profileType is null and connector is absent', () => {
    expect(deriveProfileType({ profileType: null, connector: undefined })).toBe('custom');
  });

  it('derives "integration" when profileType is undefined and connector is present', () => {
    expect(deriveProfileType({ connector: 'jira' })).toBe('integration');
  });

  it('derives "custom" when profileType is undefined and connector is absent', () => {
    expect(deriveProfileType({})).toBe('custom');
  });

  it('derives "custom" when connector is empty string', () => {
    expect(deriveProfileType({ connector: '' })).toBe('custom');
  });
});

describe('computeIsAuthorized', () => {
  const ctx = { tenantId: 'tenant-1', projectId: 'project-1', userId: 'user-1' };

  // ─── Preconfigured: authorized ────────────────────────────────────

  it('returns true for preconfigured profile with encryptedSecrets', async () => {
    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        usageMode: 'preconfigured',
        encryptedSecrets: '{"accessToken":"abc"}',
      },
      ctx,
    );
    expect(result).toBe(true);
  });

  // ─── Preconfigured: NOT authorized ────────────────────────────────

  it('returns false for preconfigured profile without encryptedSecrets', async () => {
    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        usageMode: 'preconfigured',
        encryptedSecrets: null,
      },
      ctx,
    );
    expect(result).toBe(false);
  });

  it('returns false for preconfigured profile with empty encryptedSecrets', async () => {
    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        usageMode: 'preconfigured',
        encryptedSecrets: '   ',
      },
      ctx,
    );
    expect(result).toBe(false);
  });

  it('returns true for default usageMode (preconfigured) with secrets', async () => {
    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        encryptedSecrets: '{"token":"val"}',
      },
      ctx,
    );
    expect(result).toBe(true);
  });

  // ─── JIT: authorized ──────────────────────────────────────────────

  it('returns true for JIT profile when EndUserOAuthToken exists', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue({ _id: 'token-1' }));

    const result = await computeIsAuthorized({ _id: 'profile-1', usageMode: 'jit' }, ctx, deps);
    expect(result).toBe(true);
    expect(deps.findOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        provider: 'auth-profile:profile-1',
        revokedAt: null,
      },
      { _id: 1 },
    );
  });

  it('returns false for pending OAuth app profiles even when app credentials are present', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue({ _id: 'token-1' }));

    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        usageMode: 'preconfigured',
        authType: 'oauth2_app',
        status: 'pending_authorization',
        encryptedSecrets: '{"clientId":"abc","clientSecret":"def"}',
      },
      ctx,
      deps,
    );

    expect(result).toBe(false);
    expect(deps.findOne).not.toHaveBeenCalled();
  });

  it('checks the tenant shared grant for shared OAuth app profiles', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue({ _id: 'token-1' }));

    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        usageMode: 'preconfigured',
        authType: 'oauth2_app',
        status: 'active',
        visibility: 'shared',
      },
      ctx,
      deps,
    );

    expect(result).toBe(true);
    expect(deps.findOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: '__tenant__',
        provider: 'auth-profile:profile-1',
        revokedAt: null,
      },
      { _id: 1 },
    );
  });

  it('checks the current user grant for personal OAuth app profiles', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue({ _id: 'token-1' }));

    const result = await computeIsAuthorized(
      {
        _id: 'profile-1',
        usageMode: 'preconfigured',
        authType: 'oauth2_app',
        status: 'active',
        visibility: 'personal',
      },
      ctx,
      deps,
    );

    expect(result).toBe(true);
    expect(deps.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        provider: 'auth-profile:profile-1',
      }),
      { _id: 1 },
    );
  });

  // ─── JIT: NOT authorized ──────────────────────────────────────────

  it('returns false for JIT profile when no EndUserOAuthToken exists', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue(null));

    const result = await computeIsAuthorized({ _id: 'profile-1', usageMode: 'jit' }, ctx, deps);
    expect(result).toBe(false);
  });

  it('returns false for JIT profile when no userId provided', async () => {
    const deps = buildDeps();
    const result = await computeIsAuthorized(
      { _id: 'profile-1', usageMode: 'jit' },
      { tenantId: 'tenant-1', projectId: 'project-1' },
      deps,
    );
    expect(result).toBe(false);
    expect(deps.findOne).not.toHaveBeenCalled();
  });

  // ─── Preflight: authorized ────────────────────────────────────────

  it('returns true for preflight profile when EndUserOAuthToken exists', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue({ _id: 'token-1' }));

    const result = await computeIsAuthorized(
      { _id: 'profile-1', usageMode: 'preflight' },
      ctx,
      deps,
    );
    expect(result).toBe(true);
  });

  // ─── Preflight: NOT authorized ────────────────────────────────────

  it('returns false for preflight profile when no token exists', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue(null));

    const result = await computeIsAuthorized(
      { _id: 'profile-1', usageMode: 'preflight' },
      ctx,
      deps,
    );
    expect(result).toBe(false);
  });

  // ─── user_token mode ──────────────────────────────────────────────

  it('returns true for user_token mode when EndUserOAuthToken exists', async () => {
    const deps = buildDeps(vi.fn().mockResolvedValue({ _id: 'token-1' }));

    const result = await computeIsAuthorized(
      { _id: 'profile-1', usageMode: 'user_token' },
      ctx,
      deps,
    );
    expect(result).toBe(true);
  });

  it('returns false for user_token mode when no userId', async () => {
    const deps = buildDeps();
    const result = await computeIsAuthorized(
      { _id: 'profile-1', usageMode: 'user_token' },
      { tenantId: 'tenant-1', projectId: 'project-1' },
      deps,
    );
    expect(result).toBe(false);
  });

  // ─── Error Handling ───────────────────────────────────────────────

  it('returns false on DB lookup error', async () => {
    const deps = buildDeps(vi.fn().mockRejectedValue(new Error('DB error')));

    const result = await computeIsAuthorized({ _id: 'profile-1', usageMode: 'jit' }, ctx, deps);
    expect(result).toBe(false);
  });
});
