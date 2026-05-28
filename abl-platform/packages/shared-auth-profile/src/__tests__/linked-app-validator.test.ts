import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

import { AuthProfileError, validateLinkedAppProfile } from '../linked-app-validator.js';

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'app-profile-1',
    tenantId: 'tenant-1',
    authType: 'oauth2_app',
    status: 'active',
    scope: 'tenant',
    visibility: 'shared',
    projectId: null,
    createdBy: 'user-1',
    config: {},
    encryptedSecrets: '{"clientId":"cid","clientSecret":"secret"}',
    ...overrides,
  };
}

describe('validateLinkedAppProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a workspace-shared oauth2_app when required scope matches', async () => {
    mockFindOne.mockResolvedValueOnce(makeProfile());

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        requiredScope: 'tenant',
        requiredVisibility: 'shared',
        requiredProjectId: null,
      }),
    ).resolves.toMatchObject({
      _id: 'app-profile-1',
      scope: 'tenant',
      visibility: 'shared',
      projectId: null,
    });
  });

  it('rejects project-scoped linked app profiles when workspace scope is required', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        scope: 'project',
        projectId: 'project-1',
      }),
    );

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        requiredScope: 'tenant',
        requiredVisibility: 'shared',
        requiredProjectId: null,
      }),
    ).rejects.toThrow(AuthProfileError);
  });

  it('rejects personal linked app profiles when shared visibility is required', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        visibility: 'personal',
      }),
    );

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        requiredScope: 'tenant',
        requiredVisibility: 'shared',
        requiredProjectId: null,
      }),
    ).rejects.toThrow(AuthProfileError);
  });

  it('rejects expired linked app profiles', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        requiredScope: 'tenant',
        requiredVisibility: 'shared',
        requiredProjectId: null,
      }),
    ).rejects.toThrow(/has expired/);
  });

  it('rejects linked personal app owned by another user', async () => {
    mockFindOne.mockResolvedValueOnce(
      makeProfile({
        scope: 'project',
        visibility: 'personal',
        projectId: 'project-1',
        createdBy: 'other-user',
      }),
    );

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        requiredScope: 'project',
        requiredVisibility: 'personal',
        requiredProjectId: 'project-1',
        requiredOwnerId: 'user-1',
      }),
    ).rejects.toThrow(/same owner/);
  });
});
