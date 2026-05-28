import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthProfileFindOne = vi.fn();

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
}));

function makeLeanQuery(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  };
}

describe('mcp-auth-profile-compat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthProfileFindOne.mockReset();
  });

  it('rejects api_key query placement for MCP auth profile compatibility', async () => {
    mockAuthProfileFindOne.mockReturnValue(
      makeLeanQuery({
        _id: 'profile-1',
        authType: 'api_key',
        connectionMode: 'shared',
        config: {
          placement: 'query',
        },
      }),
    );

    const { validateMcpAuthProfileCompatibility } = await import('@/lib/mcp-auth-profile-compat');
    const result = await validateMcpAuthProfileCompatibility({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      authProfileId: 'profile-1',
      transport: 'http',
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: 'AUTH_TYPE_NOT_MCP_COMPATIBLE',
    });
    expect(result.message).toContain('query placement');
  });

  it('allows api_key header placement for MCP auth profile compatibility', async () => {
    mockAuthProfileFindOne.mockReturnValue(
      makeLeanQuery({
        _id: 'profile-2',
        authType: 'api_key',
        connectionMode: 'shared',
        config: {
          placement: 'header',
        },
      }),
    );

    const { validateMcpAuthProfileCompatibility } = await import('@/lib/mcp-auth-profile-compat');
    const result = await validateMcpAuthProfileCompatibility({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      authProfileId: 'profile-2',
      transport: 'http',
      userId: 'user-1',
    });

    expect(result).toEqual({ ok: true });
  });

  it('rejects personal profiles for MCP bindings in compatibility query', async () => {
    mockAuthProfileFindOne.mockReturnValue(
      makeLeanQuery({
        _id: 'profile-3',
        authType: 'api_key',
        connectionMode: 'shared',
        visibility: 'shared',
        createdBy: 'user-1',
        config: { placement: 'header' },
      }),
    );

    const { validateMcpAuthProfileCompatibility } = await import('@/lib/mcp-auth-profile-compat');
    const result = await validateMcpAuthProfileCompatibility({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      authProfileId: 'profile-3',
      transport: 'http',
      userId: 'user-1',
    });

    expect(result).toEqual({ ok: true });
    expect(mockAuthProfileFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'profile-3',
        tenantId: 'tenant-1',
        status: 'active',
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              { projectId: 'project-1' },
              { projectId: null },
              { projectId: { $exists: false } },
            ]),
          }),
          expect.objectContaining({
            visibility: { $ne: 'personal' },
          }),
        ]),
      }),
    );
  });

  it('returns not found when env profile is outside scope/inaccessible', async () => {
    mockAuthProfileFindOne.mockReturnValue(makeLeanQuery(null));

    const { validateMcpEnvProfileCompatibility } = await import('@/lib/mcp-auth-profile-compat');
    const result = await validateMcpEnvProfileCompatibility({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      envProfileId: 'env-profile-1',
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: 'AUTH_PROFILE_NOT_FOUND',
    });
  });
});
