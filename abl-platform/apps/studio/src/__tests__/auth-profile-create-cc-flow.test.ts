/**
 * Unit tests for executeClientCredentialsCreateFlow.
 *
 * Pure function — tests pass stub deps directly. No vi.mock of platform modules.
 * Covers: happy path (status flip + AUTHORIZED trace), failure path (delete +
 * AUTHORIZE_FAILED trace + sanitized message), error sanitization invariant.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeClientCredentialsCreateFlow,
  type CreateCCFlowDeps,
  type CreateCCFlowProfile,
  type CreateCCFlowInput,
} from '@/app/api/auth-profiles/_create-cc-flow';

const FIXED_TIME = new Date('2026-04-28T12:00:00.000Z');

function makeProfile(overrides: Partial<CreateCCFlowProfile> = {}): CreateCCFlowProfile {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    scope: 'project',
    authType: 'oauth2_client_credentials',
    status: 'pending_authorization',
    profileVersion: 1,
    config: { tokenUrl: 'https://oauth.example.com/token', scopes: ['read:data'] },
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateCCFlowInput> = {}): CreateCCFlowInput {
  return {
    profile: makeProfile(),
    secrets: { clientId: 'client-1', clientSecret: 'super-secret' },
    scopes: ['read:data'],
    tokenUrl: 'https://oauth.example.com/token',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CreateCCFlowDeps> = {}): CreateCCFlowDeps & {
  emitTrace: ReturnType<typeof vi.fn>;
  AuthProfile: {
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
  ConnectorConnection: {
    deleteOne: ReturnType<typeof vi.fn>;
  };
  resolveClientCredentialsToken: ReturnType<typeof vi.fn>;
} {
  const findOneAndUpdate = vi.fn().mockResolvedValue({
    _id: 'profile-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    scope: 'project',
    authType: 'oauth2_client_credentials',
    status: 'active',
    config: { tokenUrl: 'https://oauth.example.com/token' },
  });
  const deleteOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const deleteBridgeOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const resolveClientCredentialsToken = vi.fn().mockResolvedValue({
    accessToken: 'acc-token',
    expiresAt: '2026-04-28T13:00:00.000Z',
    cached: false,
  });
  const emitTrace = vi.fn();

  return {
    resolveClientCredentialsToken,
    AuthProfile: { findOneAndUpdate, deleteOne },
    ConnectorConnection: { deleteOne: deleteBridgeOne },
    serviceDeps: { redis: undefined },
    emitTrace,
    traceEventNames: {
      AUTHORIZED: 'auth_profile.authorized',
      AUTHORIZE_FAILED: 'auth_profile.authorize_failed',
    },
    now: () => FIXED_TIME,
    ...overrides,
  } as ReturnType<typeof makeDeps>;
}

describe('executeClientCredentialsCreateFlow', () => {
  it('CC-1: happy path — flips pending_authorization to active and emits AUTHORIZED', async () => {
    const deps = makeDeps();
    const result = await executeClientCredentialsCreateFlow(makeInput(), deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.status).toBe('active');
      expect(result.cacheHit).toBe(false);
    }
    expect(deps.AuthProfile.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'profile-1',
        tenantId: 'tenant-1',
        status: 'pending_authorization',
      },
      { $set: { status: 'active', lastValidatedAt: FIXED_TIME } },
      { new: true },
    );
    expect(deps.emitTrace).toHaveBeenCalledWith({
      eventType: 'auth_profile.authorized',
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_client_credentials',
      timestamp: FIXED_TIME.toISOString(),
      metadata: { scope: 'project', cached: false },
    });
    expect(deps.AuthProfile.deleteOne).not.toHaveBeenCalled();
    expect(deps.ConnectorConnection.deleteOne).not.toHaveBeenCalled();
  });

  it('CC-2: failure — token exchange throws → deletes pending row, returns sanitized error', async () => {
    const deps = makeDeps();
    deps.resolveClientCredentialsToken.mockRejectedValue(
      new Error(
        'Client credentials exchange failed with status 401: tenant=tenant-1 secret=super-secret',
      ),
    );

    const result = await executeClientCredentialsCreateFlow(makeInput(), deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AUTH_PROFILE_AUTHORIZE_FAILED');
      // Sanitization: no tenant/profile/secret/tokenUrl host leak.
      expect(result.userFacingMessage).not.toContain('tenant-1');
      expect(result.userFacingMessage).not.toContain('profile-1');
      expect(result.userFacingMessage).not.toContain('super-secret');
      expect(result.userFacingMessage).not.toContain('oauth.example.com');
      // Should be the canned safe message.
      expect(result.userFacingMessage).toContain('client credentials authorization failed');
    }
    expect(deps.AuthProfile.deleteOne).toHaveBeenCalledWith({
      _id: 'profile-1',
      tenantId: 'tenant-1',
      status: 'pending_authorization',
    });
    expect(deps.ConnectorConnection.deleteOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authProfileId: 'profile-1',
    });
    expect(deps.AuthProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('CC-3: failure emits AUTHORIZE_FAILED with metric label', async () => {
    const deps = makeDeps();
    deps.resolveClientCredentialsToken.mockRejectedValue(new Error('connection refused'));

    await executeClientCredentialsCreateFlow(makeInput(), deps);

    expect(deps.emitTrace).toHaveBeenCalledWith({
      eventType: 'auth_profile.authorize_failed',
      profileId: 'profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_client_credentials',
      timestamp: FIXED_TIME.toISOString(),
      metadata: {
        reason: 'token_exchange_failed',
        scope: 'project',
        metric: 'auth_profile_authorize_failed_total',
      },
    });
  });

  it('CC-4: tenant scope — uses scope: "tenant" in trace metadata for workspace profiles', async () => {
    const deps = makeDeps();
    deps.AuthProfile.findOneAndUpdate.mockResolvedValue({
      _id: 'profile-1',
      tenantId: 'tenant-1',
      projectId: null,
      scope: 'tenant',
      status: 'active',
    });

    const result = await executeClientCredentialsCreateFlow(
      makeInput({ profile: makeProfile({ projectId: null, scope: 'tenant' }) }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.emitTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth_profile.authorized',
        metadata: expect.objectContaining({ scope: 'tenant' }),
      }),
    );
  });

  it('CC-5: cached token — propagates cacheHit=true to caller', async () => {
    const deps = makeDeps();
    deps.resolveClientCredentialsToken.mockResolvedValue({
      accessToken: 'acc-token',
      expiresAt: '2026-04-28T13:00:00.000Z',
      cached: true,
    });

    const result = await executeClientCredentialsCreateFlow(makeInput(), deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cacheHit).toBe(true);
    }
    expect(deps.emitTrace).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ cached: true }) }),
    );
  });

  it('CC-6: passes scopes and tokenUrl through to the token exchanger', async () => {
    const deps = makeDeps();
    await executeClientCredentialsCreateFlow(
      makeInput({
        scopes: ['scope-a', 'scope-b'],
        tokenUrl: 'https://provider.test/oauth/token',
      }),
      deps,
    );

    expect(deps.resolveClientCredentialsToken).toHaveBeenCalledWith(
      'profile-1',
      'tenant-1',
      1,
      'https://provider.test/oauth/token',
      'client-1',
      'super-secret',
      ['scope-a', 'scope-b'],
      { redis: undefined },
    );
  });

  it('CC-7: idempotent — does not throw if findOneAndUpdate returns null (already active)', async () => {
    const deps = makeDeps();
    deps.AuthProfile.findOneAndUpdate.mockResolvedValue(null);

    const result = await executeClientCredentialsCreateFlow(makeInput(), deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Even with a null update, we still report status: 'active' since the
      // grant succeeded — the null only means another writer already flipped it.
      expect(result.profile.status).toBe('active');
    }
  });

  it('CC-8: log.warn called with raw error context on failure (raw context kept off the user message)', async () => {
    const log = { warn: vi.fn() };
    const deps = makeDeps({ log });
    deps.resolveClientCredentialsToken.mockRejectedValue(new Error('upstream returned 401'));

    await executeClientCredentialsCreateFlow(makeInput(), deps);

    expect(log.warn).toHaveBeenCalledWith(
      'cc_grant_failed',
      expect.objectContaining({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        tokenUrl: 'https://oauth.example.com/token',
        error: 'upstream returned 401',
      }),
    );
  });
});
