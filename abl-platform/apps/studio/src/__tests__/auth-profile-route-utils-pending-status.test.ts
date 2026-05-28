/**
 * ABLP-619 — route-utils helpers must admit `pending_authorization` so the
 * Phase-4 two-phase create flow can find the parent profile during OAuth
 * initiate / callback. These helpers are pure functions; the test passes
 * inputs and asserts on the returned filters / errors directly — no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  ensureUsableOAuthAppProfile,
  buildProjectOAuthAppLookupFilter,
  buildTenantOAuthAppLookupFilter,
} from '../app/api/auth-profiles/_auth-profile-route-utils';
import type { IAuthProfile } from '@agent-platform/database/models';

function makeProfile(overrides: Partial<IAuthProfile> = {}): IAuthProfile {
  return {
    _id: 'ap-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Test OAuth App',
    authType: 'oauth2_app',
    usageMode: 'preconfigured',
    visibility: 'shared',
    status: 'active',
    scope: 'project',
    connectionMode: 'shared',
    environment: null,
    createdBy: 'user-1',
    config: {},
    encryptedSecrets: '{}',
    encryptionKeyVersion: 1,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as IAuthProfile;
}

const actor = { id: 'user-1', permissions: [] };

describe('ensureUsableOAuthAppProfile — pending_authorization', () => {
  it('returns null (usable) for status=active', () => {
    const result = ensureUsableOAuthAppProfile(makeProfile({ status: 'active' }), actor);
    expect(result).toBeNull();
  });

  it('returns null (usable) for status=pending_authorization (Phase 4 two-phase create)', () => {
    const result = ensureUsableOAuthAppProfile(
      makeProfile({ status: 'pending_authorization' }),
      actor,
    );
    expect(result).toBeNull();
  });

  it('returns 400 error for status=revoked', () => {
    const result = ensureUsableOAuthAppProfile(makeProfile({ status: 'revoked' }), actor);
    expect(result).not.toBeNull();
  });

  it('returns 400 error for status=expired', () => {
    const result = ensureUsableOAuthAppProfile(makeProfile({ status: 'expired' }), actor);
    expect(result).not.toBeNull();
  });

  it('returns 400 error for status=invalid', () => {
    const result = ensureUsableOAuthAppProfile(makeProfile({ status: 'invalid' }), actor);
    expect(result).not.toBeNull();
  });

  it('returns 400 error when authType is not oauth2_app (regression)', () => {
    const result = ensureUsableOAuthAppProfile(
      makeProfile({ authType: 'oauth2_client_credentials' as unknown as 'oauth2_app' }),
      actor,
    );
    expect(result).not.toBeNull();
  });

  // ABLP-1123: re-authorize from revoked — initiate routes pass allowRevoked.
  it('admits status=revoked when allowRevoked: true (re-authorize path)', () => {
    const result = ensureUsableOAuthAppProfile(makeProfile({ status: 'revoked' }), actor, {
      allowRevoked: true,
    });
    expect(result).toBeNull();
  });

  it('still rejects status=revoked when allowRevoked is omitted (runtime path)', () => {
    const result = ensureUsableOAuthAppProfile(makeProfile({ status: 'revoked' }), actor);
    expect(result).not.toBeNull();
  });
});

describe('buildProjectOAuthAppLookupFilter — pending_authorization', () => {
  it('admits both active and pending_authorization via $in', () => {
    const filter = buildProjectOAuthAppLookupFilter({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      identifier: { _id: 'ap-1' },
    });
    expect(filter).toMatchObject({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: { $in: ['active', 'pending_authorization'] },
    });
  });

  it('preserves the visibility/scope $or branches (regression — no scope leakage)', () => {
    const filter = buildProjectOAuthAppLookupFilter({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      identifier: { name: 'github' },
    });
    expect(filter.$or).toHaveLength(4);
    expect(filter.name).toBe('github');
  });

  // ABLP-1123: status filter widens to include 'revoked' when re-authorize is in flight.
  it('admits revoked when allowRevoked: true (initiate route re-authorize)', () => {
    const filter = buildProjectOAuthAppLookupFilter({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      identifier: { _id: 'ap-1' },
      allowRevoked: true,
    });
    expect(filter).toMatchObject({
      status: { $in: ['active', 'pending_authorization', 'revoked'] },
    });
  });

  it('omits revoked when allowRevoked is unset (runtime / user-consent path)', () => {
    const filter = buildProjectOAuthAppLookupFilter({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      identifier: { _id: 'ap-1' },
    });
    expect(filter).toMatchObject({
      status: { $in: ['active', 'pending_authorization'] },
    });
  });
});

describe('buildTenantOAuthAppLookupFilter — pending_authorization', () => {
  it('admits both active and pending_authorization via $in', () => {
    const filter = buildTenantOAuthAppLookupFilter({
      tenantId: 'tenant-1',
      userId: 'user-1',
      identifier: { _id: 'ap-1' },
    });
    expect(filter).toMatchObject({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: null,
      scope: 'tenant',
      authType: 'oauth2_app',
      status: { $in: ['active', 'pending_authorization'] },
    });
  });

  it('omits projectId field by setting it to null (workspace-only lookups)', () => {
    const filter = buildTenantOAuthAppLookupFilter({
      tenantId: 'tenant-1',
      userId: 'user-1',
      identifier: { _id: 'ap-1' },
    }) as { projectId: unknown };
    expect(filter.projectId).toBeNull();
  });
});
