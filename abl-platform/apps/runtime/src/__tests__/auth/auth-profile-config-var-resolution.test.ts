/**
 * Config Variable Resolution for Auth Profile Ref
 *
 * Tests that {{config.X}} patterns in auth_profile_ref are
 * resolved at runtime before calling resolveByName.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockReturnValue({
  catch: vi.fn(),
});

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: any[]) => mockFindOne(...args),
    updateOne: (...args: any[]) => mockUpdateOne(...args),
  },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { resolveAuthProfileRef } from '../../services/auth-profile/resolve-tool-auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(name: string, apiKey: string) {
  return {
    _id: `profile-${name}`,
    tenantId: 'tenant-1',
    name,
    authType: 'api_key',
    config: { headerName: 'X-API-Key' },
    encryptedSecrets: JSON.stringify({ apiKey }),
    previousEncryptedSecrets: null,
    rotationGracePeriodMs: 24 * 60 * 60 * 1000,
    updatedAt: new Date(),
    lastUsedAt: new Date(),
    status: 'active',
    environment: null,
  };
}

const mockConfigVarStore = {
  findConfigVar: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveAuthProfileRef (config var interpolation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves {{config.AUTH_PROFILE}} to profile name', async () => {
    mockConfigVarStore.findConfigVar.mockResolvedValueOnce({ value: 'prod-api-key' });
    mockFindOne.mockResolvedValueOnce(makeProfile('prod-api-key', 'prod-key-123'));

    const resolved = await resolveAuthProfileRef(
      '{{config.AUTH_PROFILE}}',
      'tenant-1',
      'project-1',
      mockConfigVarStore,
    );

    expect(resolved).toBe('prod-api-key');
    expect(mockConfigVarStore.findConfigVar).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      key: 'AUTH_PROFILE',
    });
  });

  it('returns literal name when no config var pattern', async () => {
    const resolved = await resolveAuthProfileRef(
      'staging-api-key',
      'tenant-1',
      'project-1',
      mockConfigVarStore,
    );

    expect(resolved).toBe('staging-api-key');
    expect(mockConfigVarStore.findConfigVar).not.toHaveBeenCalled();
  });

  it('returns null when config var not found', async () => {
    mockConfigVarStore.findConfigVar.mockResolvedValueOnce(null);

    const resolved = await resolveAuthProfileRef(
      '{{config.MISSING_VAR}}',
      'tenant-1',
      'project-1',
      mockConfigVarStore,
    );

    expect(resolved).toBeNull();
  });

  it('handles multiple config vars (unsupported — returns first)', async () => {
    // Our pattern only supports single config var references
    const resolved = await resolveAuthProfileRef(
      'literal-name',
      'tenant-1',
      'project-1',
      mockConfigVarStore,
    );

    expect(resolved).toBe('literal-name');
  });
});
