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

const mockFind = vi.fn();
const mockUpdateOne = vi.fn().mockReturnValue({
  catch: vi.fn(),
});

function makeFindResult(profiles: unknown | unknown[] | null) {
  const resolved = profiles == null ? [] : Array.isArray(profiles) ? profiles : [profiles];
  return {
    limit: () => Promise.resolve(resolved),
    then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(resolved).then(onFulfilled),
  };
}

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    find: (...args: unknown[]) => mockFind(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { resolveByName } from '../services/auth-profile-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'profile-1',
    tenantId: 'tenant-1',
    name: 'my-profile',
    authType: 'api_key',
    profileVersion: 1,
    config: { headerName: 'X-Api-Key' },
    encryptedSecrets: '{"apiKey":"test-key-123"}',
    previousEncryptedSecrets: null,
    rotationGracePeriodMs: 24 * 60 * 60 * 1000,
    updatedAt: new Date(),
    lastUsedAt: new Date(),
    status: 'active',
    environment: null,
    projectId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveByName (search-ai, FR-10 unified $or)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockReset();
  });

  it('resolves a profile by name and tenantId', async () => {
    mockFind.mockReturnValueOnce(makeFindResult(makeProfile()));

    const result = await resolveByName('my-profile', 'tenant-1');

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('test-key-123');
  });

  it('returns null for wrong tenantId', async () => {
    mockFind.mockReturnValueOnce(makeFindResult([]));

    const result = await resolveByName('my-profile', 'wrong-tenant');

    expect(result).toBeNull();
  });

  it('resolves environment-specific profile with fallback', async () => {
    const defaultProfile = makeProfile({
      _id: 'profile-default',
      environment: null,
      encryptedSecrets: '{"apiKey":"default-key"}',
    });

    mockFind
      .mockReturnValueOnce(makeFindResult([])) // env=unknown-env query
      .mockReturnValueOnce(makeFindResult(defaultProfile)); // env=null fallback

    const result = await resolveByName('my-profile', 'tenant-1', 'unknown-env');

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('default-key');
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  it('returns null when profile has no apiKey', async () => {
    mockFind.mockReturnValueOnce(
      makeFindResult(makeProfile({ encryptedSecrets: '{"someOtherField":"value"}' })),
    );

    const result = await resolveByName('my-profile', 'tenant-1');

    expect(result).toBeNull();
  });

  it('FR-10: applies $or projectId filter and prefers project-scoped row', async () => {
    mockFind.mockReturnValueOnce(
      makeFindResult([
        makeProfile({
          _id: 'profile-workspace',
          projectId: null,
          encryptedSecrets: '{"apiKey":"workspace-key"}',
        }),
        makeProfile({
          _id: 'profile-project',
          projectId: 'project-1',
          encryptedSecrets: '{"apiKey":"project-key"}',
        }),
      ]),
    );

    const result = await resolveByName('my-profile', 'tenant-1', undefined, 'project-1');

    expect(result?.apiKey).toBe('project-key');

    const filter = mockFind.mock.calls[0][0];
    expect(filter).toMatchObject({
      name: 'my-profile',
      tenantId: 'tenant-1',
      status: 'active',
    });
    expect(filter.$and).toContainEqual({
      $or: [{ projectId: 'project-1' }, { projectId: null }, { projectId: { $exists: false } }],
    });
  });

  it('FR-10: workspace profile resolves through project-scoped lookup when no project row exists', async () => {
    mockFind.mockReturnValueOnce(
      makeFindResult(
        makeProfile({
          _id: 'profile-workspace',
          projectId: null,
          encryptedSecrets: '{"apiKey":"workspace-key"}',
        }),
      ),
    );

    const result = await resolveByName('my-profile', 'tenant-1', undefined, 'project-1');

    expect(result?.apiKey).toBe('workspace-key');
  });
});
