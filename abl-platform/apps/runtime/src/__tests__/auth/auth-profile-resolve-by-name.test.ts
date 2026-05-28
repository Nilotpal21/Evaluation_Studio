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
  // The resolver calls `find(...).limit(2)` when the chain is supported, falls
  // back to plain `await find(...)` otherwise. Support both via a chainable
  // returned shape that is also thenable.
  const chain = {
    limit: () => Promise.resolve(resolved),
    then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(resolved).then(onFulfilled),
  };
  return chain;
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

import { resolveByName, getAuthProfileCache } from '../../services/auth-profile-resolver.js';

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
    visibility: 'shared',
    createdBy: 'user-default',
    projectId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveByName (FR-10 unified $or filter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockReset();
    getAuthProfileCache().clear();
  });

  it('resolves a profile by name and tenantId', async () => {
    mockFind.mockReturnValueOnce(makeFindResult(makeProfile()));

    const result = await resolveByName('my-profile', 'tenant-1');

    expect(result).not.toBeNull();
    expect(result!.profileId).toBe('profile-1');
    expect(result!.authType).toBe('api_key');
    expect(result!.secrets).toEqual({ apiKey: 'test-key-123' });

    // FR-10 query shape: name + tenant + status + composed $and (active-window
    // + projectId scope), plus per-cell environment + visibility filters.
    const filter = mockFind.mock.calls[0][0];
    expect(filter).toMatchObject({
      name: 'my-profile',
      tenantId: 'tenant-1',
      status: 'active',
      visibility: 'shared',
      environment: null,
    });
    expect(filter.$and).toEqual([
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: expect.any(Date) } }] },
      { $or: [{ projectId: null }, { projectId: { $exists: false } }] },
    ]);
  });

  it('returns null for wrong tenantId (tenant isolation)', async () => {
    mockFind.mockReturnValue(makeFindResult([]));

    const result = await resolveByName('my-profile', 'wrong-tenant');

    expect(result).toBeNull();
  });

  it('returns null for expired profile', async () => {
    mockFind.mockReturnValue(makeFindResult([])); // active-window filter strips expired rows

    const result = await resolveByName('expired-profile', 'tenant-1');

    expect(result).toBeNull();
  });

  it('resolves environment-specific profile with exact match', async () => {
    const stagingProfile = makeProfile({
      _id: 'profile-staging',
      environment: 'staging',
      encryptedSecrets: '{"apiKey":"staging-key"}',
    });
    mockFind.mockReturnValueOnce(makeFindResult(stagingProfile));

    const result = await resolveByName('my-profile', 'tenant-1', 'staging');

    expect(result).not.toBeNull();
    expect(result!.profileId).toBe('profile-staging');
    expect(result!.secrets).toEqual({ apiKey: 'staging-key' });
    expect(mockFind.mock.calls[0][0]).toMatchObject({ environment: 'staging' });
  });

  it('falls back to null-environment profile when specific environment not found', async () => {
    const defaultProfile = makeProfile({
      _id: 'profile-default',
      environment: null,
      encryptedSecrets: '{"apiKey":"default-key"}',
    });

    mockFind
      .mockReturnValueOnce(makeFindResult([])) // env=staging cell
      .mockReturnValueOnce(makeFindResult(defaultProfile)); // env=null cell

    const result = await resolveByName('my-profile', 'tenant-1', 'unknown-env');

    expect(result).not.toBeNull();
    expect(result!.profileId).toBe('profile-default');
    expect(result!.secrets).toEqual({ apiKey: 'default-key' });
    expect(mockFind).toHaveBeenCalledTimes(2);
    expect(mockFind.mock.calls[1][0]).toMatchObject({ environment: null });
  });

  it('skips legacy oauth2_token profiles during name resolution and continues lookup', async () => {
    mockFind
      .mockReturnValueOnce(
        makeFindResult(
          makeProfile({
            _id: 'profile-token',
            authType: 'oauth2_token',
            scope: 'project',
            visibility: 'shared',
            projectId: 'project-1',
            linkedAppProfileId: 'app-1',
            encryptedSecrets: '{"accessToken":"oauth-token"}',
          }),
        ),
      )
      .mockReturnValueOnce(
        makeFindResult(
          makeProfile({
            _id: 'profile-shared',
            authType: 'api_key',
            projectId: 'project-1',
            encryptedSecrets: '{"apiKey":"shared-key"}',
          }),
        ),
      );

    const result = await resolveByName('my-profile', 'tenant-1', undefined, 'project-1');

    expect(result?.profileId).toBe('profile-shared');
    expect(result?.authType).toBe('api_key');
    expect(result?.secrets).toEqual({ apiKey: 'shared-key' });
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  it('returns null when the only matching profile is a legacy oauth2_token', async () => {
    mockFind
      .mockReturnValueOnce(
        makeFindResult(
          makeProfile({
            _id: 'profile-token',
            authType: 'oauth2_token',
            scope: 'project',
            visibility: 'shared',
            projectId: 'project-1',
            linkedAppProfileId: 'app-1',
            encryptedSecrets: '{"accessToken":"oauth-token"}',
          }),
        ),
      )
      .mockReturnValue(makeFindResult([]));

    const result = await resolveByName('my-profile', 'tenant-1', undefined, 'project-1');

    expect(result).toBeNull();
  });

  it('returns null when both environment and fallback are not found', async () => {
    mockFind.mockReturnValue(makeFindResult([]));

    const result = await resolveByName('my-profile', 'tenant-1', 'unknown-env');

    expect(result).toBeNull();
    // 3 environment variants × 1 visibility cell = 3 queries (projectId axis is
    // collapsed into a single $or per cell after FR-10).
    expect(mockFind).toHaveBeenCalledTimes(3);
  });

  it('does not do environment fallback when no environment is specified', async () => {
    mockFind.mockReturnValue(makeFindResult([]));

    const result = await resolveByName('my-profile', 'tenant-1');

    expect(result).toBeNull();
    // 2 environment variants (null + missing) × 1 visibility = 2 queries.
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  it('falls back to default profile when environment-specific profile is expired', async () => {
    mockFind
      .mockReturnValueOnce(makeFindResult([])) // env=staging cell — expired filtered out
      .mockReturnValueOnce(
        makeFindResult(
          makeProfile({
            _id: 'profile-default',
            environment: null,
            encryptedSecrets: '{"apiKey":"default-key"}',
          }),
        ),
      );

    const result = await resolveByName('my-profile', 'tenant-1', 'staging');

    expect(result).not.toBeNull();
    expect(result!.profileId).toBe('profile-default');
    expect(result!.secrets).toEqual({ apiKey: 'default-key' });
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  it('updates lastUsedAt on resolution (debounced)', async () => {
    const oldDate = new Date(Date.now() - 10 * 60 * 1000);
    mockFind.mockReturnValueOnce(makeFindResult(makeProfile({ lastUsedAt: oldDate })));

    await resolveByName('my-profile', 'tenant-1');

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'profile-1', tenantId: 'tenant-1' },
      { $set: { lastUsedAt: expect.any(Date) } },
    );
  });

  it('prefers personal profiles for the requesting user before shared profiles', async () => {
    mockFind.mockReturnValueOnce(
      makeFindResult(
        makeProfile({
          _id: 'profile-personal',
          visibility: 'personal',
          createdBy: 'user-1',
          encryptedSecrets: '{"apiKey":"personal-key"}',
        }),
      ),
    );

    const result = await resolveByName('my-profile', 'tenant-1', undefined, undefined, 'user-1');

    expect(result?.profileId).toBe('profile-personal');
    expect(result?.secrets).toEqual({ apiKey: 'personal-key' });
    expect(mockFind.mock.calls[0][0]).toMatchObject({
      visibility: 'personal',
      createdBy: 'user-1',
    });
  });

  it('falls back to a shared profile when the requesting user has no personal profile', async () => {
    mockFind.mockReturnValueOnce(makeFindResult([])).mockReturnValueOnce(
      makeFindResult(
        makeProfile({
          _id: 'profile-shared',
          visibility: 'shared',
          encryptedSecrets: '{"apiKey":"shared-key"}',
        }),
      ),
    );

    const result = await resolveByName('my-profile', 'tenant-1', undefined, undefined, 'user-1');

    expect(result?.profileId).toBe('profile-shared');
    expect(mockFind.mock.calls[1][0]).toMatchObject({ visibility: 'shared' });
  });

  it('FR-10: project-scoped profile shadows workspace profile of the same name', async () => {
    // Both rows match the (name, env, visibility, $or-projectId) filter at the
    // database; the JS-side picker prefers the project-scoped row.
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

    const result = await resolveByName('my-profile', 'tenant-1', 'staging', 'project-1');

    expect(result?.profileId).toBe('profile-project');
    expect(result?.secrets).toEqual({ apiKey: 'project-key' });
    // Single query with `$or` — no per-axis iteration for projectId.
    expect(mockFind).toHaveBeenCalledTimes(1);
    const filter = mockFind.mock.calls[0][0];
    expect(filter.$and).toContainEqual({
      $or: [{ projectId: 'project-1' }, { projectId: null }, { projectId: { $exists: false } }],
    });
    expect(filter).toMatchObject({ environment: 'staging' });
  });

  it('FR-10: workspace profile resolves from a project-scoped lookup when no project profile exists', async () => {
    mockFind.mockReturnValueOnce(
      makeFindResult(
        makeProfile({
          _id: 'profile-workspace',
          projectId: null,
          encryptedSecrets: '{"apiKey":"workspace-key"}',
        }),
      ),
    );

    const result = await resolveByName('my-profile', 'tenant-1', 'staging', 'project-1');

    expect(result?.profileId).toBe('profile-workspace');
    expect(result?.secrets).toEqual({ apiKey: 'workspace-key' });
  });
});
