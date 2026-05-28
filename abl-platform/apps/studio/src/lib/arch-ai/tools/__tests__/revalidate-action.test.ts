import { describe, it, expect, afterEach, vi } from 'vitest';
import { executeIntegrationOps } from '../integration-ops';
import type { ToolPermissionContext } from '../../guards';

function makeTestCtx(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    user: {
      tenantId: 't1',
      userId: 'u1',
      permissions: ['project:read', 'project:update'],
    },
    projectId: 'p1',
    sessionId: 's1',
    authToken: 'tok',
    ...overrides,
  };
}

interface MockableDraft {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string | null;
  source: 'in_project' | 'onboarding';
  status: string;
  title: string;
  providerKey: string | null;
  toolIds: string[];
  authProfileIds: string[];
  envVarKeys: string[];
  configVarKeys: string[];
  variableNamespaceIds: string[];
  targetAgentNames: string[];
  pendingSteps: string[];
  connectionIds: string[];
  save: () => Promise<void>;
}

function makeDraft(overrides: Partial<MockableDraft> = {}): MockableDraft {
  return {
    _id: 'draft_1',
    tenantId: 't1',
    projectId: 'p1',
    sessionId: 's1',
    source: 'in_project',
    status: 'ready_to_test',
    title: 'Slack Provider Setup',
    providerKey: 'slack',
    toolIds: [],
    authProfileIds: [],
    envVarKeys: [],
    configVarKeys: [],
    variableNamespaceIds: [],
    targetAgentNames: [],
    pendingSteps: [],
    connectionIds: [],
    save: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('executeIntegrationOps revalidate action', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects deleted entity and adds pendingSteps', async () => {
    const draft = makeDraft({
      authProfileIds: ['ap_does_not_exist'],
    });

    const { ArchIntegrationDraft, AuthProfile } = await import('@agent-platform/database/models');
    vi.spyOn(ArchIntegrationDraft, 'findOne').mockResolvedValue(
      draft as unknown as Awaited<ReturnType<typeof ArchIntegrationDraft.findOne>>,
    );
    // Profile lookup returns null -> simulates deletion.
    vi.spyOn(AuthProfile, 'findOne').mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof AuthProfile.findOne>>,
    );

    const result = await executeIntegrationOps(
      { action: 'revalidate', draftId: 'draft_1' },
      makeTestCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as
      | {
          status: string;
          changes: Array<{
            entityType: string;
            entityId: string;
            change: string;
            summary: string;
          }>;
          pendingSteps: Array<{ id: string; description: string }>;
        }
      | undefined;
    expect(data?.changes).toContainEqual(
      expect.objectContaining({
        entityType: 'auth_profile',
        change: 'deleted_externally',
      }),
    );
    expect(data?.status).toBe('needs_input');
    expect(data?.pendingSteps).toContainEqual(
      expect.objectContaining({
        id: expect.stringContaining('recreate_auth_profile_'),
      }),
    );
    expect(draft.save).toHaveBeenCalledTimes(1);
  });

  it('returns unchanged when entities still match', async () => {
    const draft = makeDraft({
      authProfileIds: ['ap_existing'],
    });

    const { ArchIntegrationDraft, AuthProfile } = await import('@agent-platform/database/models');
    vi.spyOn(ArchIntegrationDraft, 'findOne').mockResolvedValue(
      draft as unknown as Awaited<ReturnType<typeof ArchIntegrationDraft.findOne>>,
    );
    vi.spyOn(AuthProfile, 'findOne').mockResolvedValue({
      _id: 'ap_existing',
      tenantId: 't1',
      projectId: 'p1',
      name: 'My API Key',
      authType: 'api_key',
    } as unknown as Awaited<ReturnType<typeof AuthProfile.findOne>>);

    const result = await executeIntegrationOps(
      { action: 'revalidate', draftId: 'draft_1' },
      makeTestCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as
      | {
          changes: Array<{
            entityType: string;
            entityId: string;
            change: string;
            summary: string;
          }>;
        }
      | undefined;
    expect(data?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ change: 'unchanged' })]),
    );
  });

  it('detects expired oauth grant for oauth2_token profile', async () => {
    const draft = makeDraft({
      authProfileIds: ['ap_oauth_token'],
    });

    const { ArchIntegrationDraft, AuthProfile, EndUserOAuthToken } =
      await import('@agent-platform/database/models');
    vi.spyOn(ArchIntegrationDraft, 'findOne').mockResolvedValue(
      draft as unknown as Awaited<ReturnType<typeof ArchIntegrationDraft.findOne>>,
    );
    vi.spyOn(AuthProfile, 'findOne').mockResolvedValue({
      _id: 'ap_oauth_token',
      tenantId: 't1',
      projectId: 'p1',
      name: 'Slack User Token',
      authType: 'oauth2_token',
      linkedAppProfileId: 'ap_oauth_app',
    } as unknown as Awaited<ReturnType<typeof AuthProfile.findOne>>);
    // No EndUserOAuthToken row -> simulates missing grant.
    vi.spyOn(EndUserOAuthToken, 'findOne').mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof EndUserOAuthToken.findOne>>,
    );

    const result = await executeIntegrationOps(
      { action: 'revalidate', draftId: 'draft_1' },
      makeTestCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as
      | {
          changes: Array<{
            entityType: string;
            entityId: string;
            change: string;
            summary: string;
          }>;
        }
      | undefined;
    expect(data?.changes).toContainEqual(
      expect.objectContaining({
        entityType: 'auth_profile',
        change: 'newly_invalid',
        summary: expect.stringContaining('oauth_grant_missing_or_expired'),
      }),
    );
  });
});
