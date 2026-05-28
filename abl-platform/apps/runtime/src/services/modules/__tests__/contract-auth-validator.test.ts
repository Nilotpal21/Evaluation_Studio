/**
 * Unit tests for contract-auth-validator.ts
 *
 * Covers: happy path, missing profiles, type mismatches,
 * DB error fail-closed, multi-dependency aggregation,
 * and edge cases (empty deps, null contractSnapshot).
 *
 * GAP-011 closure
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ModuleReleaseContract } from '@agent-platform/database/models';

// ─── Mock the database models ────────────────────────────────────────────

const mockFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockFindOne(...args),
    }),
  },
}));

// ─── Import under test ──────────────────────────────────────────────────

import { validateContractAuthProfiles } from '../contract-auth-validator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const TENANT_ID = 'test-tenant';
const PROJECT_ID = 'test-project';

function makeContract(overrides: Partial<ModuleReleaseContract> = {}): ModuleReleaseContract {
  return {
    providedAgents: [],
    providedTools: [],
    requiredConfigKeys: [],
    requiredEnvVars: [],
    requiredAuthProfiles: [],
    requiredConnectors: [],
    requiredMcpServers: [],
    warnings: [],
    ...overrides,
  };
}

function makeDep(
  alias: string,
  requiredAuthProfiles: Array<{
    name: string;
    authType?: string;
    scope?: string;
    referencedBy?: string[];
  }>,
) {
  return {
    alias,
    contractSnapshot: makeContract({
      requiredAuthProfiles: requiredAuthProfiles.map((p) => ({
        ...p,
        referencedBy: p.referencedBy ?? [alias],
      })),
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('validateContractAuthProfiles', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
  });

  it('returns success when no dependencies have auth profile requirements', async () => {
    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [makeDep('idv', [])]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('normalizes legacy auth_profile_ref payloads before lookup', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-legacy',
      name: 'billing-shared',
      authType: 'oauth2',
    });

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('billing', [{ name: 'auth_profile_ref billing-shared', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: 'billing-shared',
        status: 'active',
        environment: null,
        visibility: 'shared',
      }),
    );
  });

  it('skips config-backed auth profile templates because they resolve at runtime', async () => {
    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('crm', [{ name: '{{config.CRM_AUTH_PROFILE}}', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('returns success when all required auth profiles exist at project scope', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-1',
      name: 'twilio-auth',
      authType: 'oauth2',
    });

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('sms', [{ name: 'twilio-auth', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('returns success when profile found at tenant scope (projectId: null)', async () => {
    // First call: project-scoped → null, second call: tenant-scoped → found
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'ap-2',
      name: 'shared-auth',
      authType: 'api_key',
    });

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('shared', [{ name: 'shared-auth', authType: 'api_key' }]),
    ]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);

    // Verify it checked project scope first, then tenant scope
    expect(mockFindOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: 'shared-auth',
        status: 'active',
        visibility: 'shared',
      }),
    );
    expect(mockFindOne).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        tenantId: TENANT_ID,
        projectId: null,
        name: 'shared-auth',
        status: 'active',
        visibility: 'shared',
      }),
    );
  });

  it('uses runtime environment, visibility, expiry, and user filters during lookup', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-prod',
      name: 'prod-personal-auth',
      authType: 'api_key',
    });

    const result = await validateContractAuthProfiles(
      TENANT_ID,
      PROJECT_ID,
      [makeDep('prod', [{ name: 'prod-personal-auth', authType: 'api_key' }])],
      { environment: 'production', userId: 'user-1' },
    );

    expect(result.success).toBe(true);
    expect(mockFindOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: 'prod-personal-auth',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        environment: 'production',
        visibility: 'personal',
        createdBy: 'user-1',
        status: 'active',
        $or: expect.any(Array),
      }),
    );
  });

  it('reports missing profile when not found at either scope', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('payment', [{ name: 'stripe-auth', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      profileName: 'stripe-auth',
      referencedBy: 'payment',
      status: 'missing',
      expectedType: 'oauth2',
    });
  });

  it('reports type_mismatch when profile exists but authType differs', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-3',
      name: 'salesforce-auth',
      authType: 'api_key',
    });

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('crm', [{ name: 'salesforce-auth', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      profileName: 'salesforce-auth',
      referencedBy: 'crm',
      status: 'type_mismatch',
      expectedType: 'oauth2',
      actualType: 'api_key',
    });
  });

  it('skips type check when expectedType is not specified in contract', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-4',
      name: 'generic-auth',
      authType: 'oauth2',
    });

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('util', [{ name: 'generic-auth' }]),
    ]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('collects issues from multiple dependencies', async () => {
    mockFindOne.mockImplementation(async (query: Record<string, unknown>) => {
      if (query.name === 'b-auth') {
        return { _id: 'ap-5', name: 'b-auth', authType: 'api_key' };
      }
      return null;
    });

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('dep-a', [{ name: 'a-auth', authType: 'oauth2' }]),
      makeDep('dep-b', [{ name: 'b-auth', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].status).toBe('missing');
    expect(result.issues[0].referencedBy).toBe('dep-a');
    expect(result.issues[1].status).toBe('type_mismatch');
    expect(result.issues[1].referencedBy).toBe('dep-b');
  });

  it('fails closed when DB throws an error', async () => {
    mockFindOne.mockRejectedValue(new Error('Connection timeout'));

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('payment', [{ name: 'stripe-auth', authType: 'oauth2' }]),
    ]);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      profileName: 'unknown',
      referencedBy: 'system',
      status: 'missing',
    });
  });

  it('fails closed when DB throws a non-Error value', async () => {
    mockFindOne.mockRejectedValue('ECONNREFUSED');

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('util', [{ name: 'some-auth' }]),
    ]);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  it('handles dependency with null contractSnapshot gracefully', async () => {
    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      { alias: 'legacy', contractSnapshot: null as unknown as ModuleReleaseContract },
    ]);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('returns success for empty dependencies array', async () => {
    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, []);

    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('handles multiple profiles in one dependency with mixed results', async () => {
    mockFindOne
      // Profile 1: found, correct type
      .mockResolvedValueOnce({ _id: 'ap-ok', name: 'ok-auth', authType: 'oauth2' })
      // Profile 2: not found
      .mockResolvedValueOnce(null) // project scope
      .mockResolvedValueOnce(null); // tenant scope

    const result = await validateContractAuthProfiles(TENANT_ID, PROJECT_ID, [
      makeDep('multi', [
        { name: 'ok-auth', authType: 'oauth2' },
        { name: 'missing-auth', authType: 'api_key' },
      ]),
    ]);

    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].profileName).toBe('missing-auth');
  });
});
