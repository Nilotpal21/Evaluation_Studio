import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
      handler({
        request,
        tenantId: 'tenant-1',
        user: {
          id: 'user-1',
          permissions: ['auth_profile:read', 'auth_profile:write'],
        },
        params: await ctx.params,
        project: { id: 'project-1', tenantId: 'tenant-1' },
      }),
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    AUTH_PROFILE_READ: 'auth_profile:read',
    AUTH_PROFILE_WRITE: 'auth_profile:write',
    AUTH_PROFILE_DECRYPT: 'auth_profile:decrypt',
  },
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/app/api/auth-profiles/_auth-profile-route-utils', () => ({
  buildAuthProfileVisibilityFilter: vi.fn(() => ({})),
  ensureReadableAuthProfile: vi.fn(() => null),
  ensureMutableAuthProfile: vi.fn(() => null),
  parseAuthProfileSecrets: vi.fn(() => ({})),
}));

const mockLoadModelMap = vi.fn();
const mockSummarizeDeleteBlockers = vi.fn();

vi.mock('@/app/api/auth-profiles/_bulk-handler', () => ({
  loadModelMap: (...args: unknown[]) => mockLoadModelMap(...args),
  summarizeDeleteBlockers: (...args: unknown[]) => mockSummarizeDeleteBlockers(...args),
  hasDeleteBlockers: (summary: { visibleConsumers?: unknown[]; hiddenBlockers?: boolean }) =>
    (summary.visibleConsumers?.length ?? 0) > 0 || summary.hiddenBlockers === true,
  canAutoCascadeInternalDeleteBlockers: vi.fn(() => false),
  cleanupAutoCascadeInternalDependencies: vi.fn(),
  formatDeleteBlockerLabel: (consumer: { label: string; name: string }) =>
    `${consumer.label} ${consumer.name}`,
}));

vi.mock('@/app/api/auth-profiles/_save-gating', () => ({
  evaluateSaveGating: vi.fn(),
}));

vi.mock('@/app/api/auth-profiles/_bridge-cascade', () => ({
  cascadeDeleteBridge: vi.fn(),
}));

vi.mock('@agent-platform/shared/validation', () => ({
  UpdateAuthProfileSchema: {},
  AUTH_TYPE_CONFIG_SCHEMAS: {},
  getAuthProfileUsageModeValidationError: vi.fn(),
  getMaterializedAuthProfileValidationErrors: vi.fn(() => []),
  mergeOAuth2AppConfig: vi.fn(),
  normalizeOAuth2AppConfig: vi.fn(),
  resolveAuthProfileUsageMode: vi.fn((authType: string) =>
    authType === 'oauth2_token' ? 'user_token' : 'preconfigured',
  ),
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  getAuthProfileMigrationState: vi.fn(() => ({ status: 'active' })),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: vi.fn(() => ({})),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

const mockAuthProfileFindOne = vi.fn();
const mockAuthProfileFindOneAndDelete = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
    findOneAndDelete: (...args: unknown[]) => mockAuthProfileFindOneAndDelete(...args),
  },
}));

function deleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/auth-profiles/auth-profile-1', {
    method: 'DELETE',
    headers: { authorization: 'Bearer token' },
  });
}

describe('Auth profile Git consumer lifecycle scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'auth-profile-1',
        name: 'GitHub PAT',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        scope: 'project',
        visibility: 'shared',
        authType: 'bearer',
        status: 'active',
        encryptedSecrets: '{}',
      }),
    });
    mockLoadModelMap.mockResolvedValue({
      GitIntegration: { modelName: 'GitIntegration' },
    });
    mockSummarizeDeleteBlockers.mockResolvedValue({
      visibleConsumers: [
        {
          type: 'git_integration',
          id: 'git-integration-1',
          name: 'github: https://github.com/acme/support',
          label: 'Git Integration',
        },
      ],
      hiddenBlockers: false,
    });
  });

  it('blocks deleting an auth profile that is still referenced by a Git integration', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/auth-profiles/[profileId]/route');

    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: 'project-1', profileId: 'auth-profile-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: 'PROFILE_IN_USE',
          consumers: expect.arrayContaining([
            expect.objectContaining({
              type: 'git_integration',
              id: 'git-integration-1',
            }),
          ]),
        }),
      }),
    );
    expect(mockAuthProfileFindOneAndDelete).not.toHaveBeenCalled();
  });
});
