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

import {
  resolveAuthProfileCredentials,
  getAuthProfileCache,
} from '../../services/auth-profile-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    authType: 'api_key',
    config: { headerName: 'X-Api-Key' },
    encryptedSecrets: '{"apiKey":"primary-key"}',
    previousEncryptedSecrets: null,
    rotationGracePeriodMs: 24 * 60 * 60 * 1000, // 24h
    updatedAt: new Date(),
    lastUsedAt: new Date(),
    status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveAuthProfileCredentials — grace period', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthProfileCache().clear();
  });

  it('returns primary secrets when they parse successfully', async () => {
    mockFindOne.mockResolvedValue(makeProfile());

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');
    expect(result).not.toBeNull();
    expect(result!.secrets).toEqual({ apiKey: 'primary-key' });
  });

  it('falls back to previousEncryptedSecrets when primary fails and within grace period', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        encryptedSecrets: 'corrupted-not-json', // Will fail JSON.parse
        previousEncryptedSecrets: '{"apiKey":"fallback-key"}',
        updatedAt: new Date(), // Just updated — within grace period
      }),
    );

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');
    expect(result).not.toBeNull();
    expect(result!.secrets).toEqual({ apiKey: 'fallback-key' });
  });

  it('throws when grace period has expired', async () => {
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    mockFindOne.mockResolvedValue(
      makeProfile({
        encryptedSecrets: 'corrupted-not-json',
        previousEncryptedSecrets: '{"apiKey":"fallback-key"}',
        updatedAt: longAgo,
        rotationGracePeriodMs: 24 * 60 * 60 * 1000,
      }),
    );

    await expect(resolveAuthProfileCredentials('profile-1', 'tenant-1')).rejects.toThrow();
  });

  it('returns null when profile not found', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await resolveAuthProfileCredentials('nonexistent', 'tenant-1');
    expect(result).toBeNull();
  });

  it('returns null when an oauth2_token profile points at a revoked linked app', async () => {
    mockFindOne
      .mockResolvedValueOnce(
        makeProfile({
          _id: 'profile-token',
          authType: 'oauth2_token',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
          linkedAppProfileId: 'app-1',
          encryptedSecrets: '{"accessToken":"oauth-token"}',
        }),
      )
      .mockResolvedValueOnce(
        makeProfile({
          _id: 'app-1',
          authType: 'oauth2_app',
          status: 'revoked',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
        }),
      );

    const result = await resolveAuthProfileCredentials('profile-token', 'tenant-1');
    expect(result).toBeNull();
  });

  it('throws when encryptedSecrets is malformed', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        encryptedSecrets: { apiKey: 'object-key' },
      }),
    );

    await expect(resolveAuthProfileCredentials('profile-1', 'tenant-1')).rejects.toThrow();
  });

  it('does not fall back when rotationGracePeriodMs is not set', async () => {
    mockFindOne.mockResolvedValue(
      makeProfile({
        encryptedSecrets: 'corrupted',
        previousEncryptedSecrets: '{"apiKey":"fallback"}',
        rotationGracePeriodMs: undefined,
        updatedAt: new Date(), // recent
      }),
    );

    await expect(resolveAuthProfileCredentials('profile-1', 'tenant-1')).rejects.toThrow();
  });

  it('revalidates cached credentials against updatedAt before reusing them', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        updatedAt: new Date('2026-03-18T10:00:00.000Z'),
        encryptedSecrets: '{"apiKey":"old-key"}',
      }),
    );

    const first = await resolveAuthProfileCredentials('profile-1', 'tenant-1');
    expect(first?.secrets).toEqual({ apiKey: 'old-key' });

    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        updatedAt: new Date('2026-03-18T10:05:00.000Z'),
        encryptedSecrets: '{"apiKey":"rotated-key"}',
      }),
    );

    const second = await resolveAuthProfileCredentials('profile-1', 'tenant-1');
    expect(second?.secrets).toEqual({ apiKey: 'rotated-key' });
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('does not reuse cached oauth2_token credentials after the linked app becomes invalid', async () => {
    const updatedAt = new Date('2026-03-18T10:00:00.000Z');
    mockFindOne
      .mockResolvedValueOnce(
        makeProfile({
          _id: 'profile-token',
          authType: 'oauth2_token',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
          linkedAppProfileId: 'app-1',
          encryptedSecrets: '{"accessToken":"oauth-token"}',
          updatedAt,
        }),
      )
      .mockResolvedValueOnce(
        makeProfile({
          _id: 'app-1',
          authType: 'oauth2_app',
          status: 'active',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
        }),
      )
      .mockResolvedValueOnce(
        makeProfile({
          _id: 'profile-token',
          authType: 'oauth2_token',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
          linkedAppProfileId: 'app-1',
          encryptedSecrets: '{"accessToken":"oauth-token"}',
          updatedAt,
        }),
      )
      .mockResolvedValueOnce(
        makeProfile({
          _id: 'app-1',
          authType: 'oauth2_app',
          status: 'revoked',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
        }),
      );

    const first = await resolveAuthProfileCredentials('profile-token', 'tenant-1');
    expect(first?.secrets).toEqual({ accessToken: 'oauth-token' });

    const second = await resolveAuthProfileCredentials('profile-token', 'tenant-1');
    expect(second).toBeNull();
    expect(mockFindOne).toHaveBeenCalledTimes(4);
  });
});
