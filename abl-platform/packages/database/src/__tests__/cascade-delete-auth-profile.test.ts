import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockAuthProfileDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
const mockAuthProfileUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockEndUserOAuthTokenDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
const mockPlatformAccessRequestDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
const mockPlatformAdminDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
const mockUserFindOne = vi.fn();

vi.mock('../models/index.js', () => {
  const makeModel = (extra = {}) => ({
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    ...extra,
  });
  return {
    Session: makeModel(),
    Message: makeModel(),
    Project: makeModel(),
    ProjectAgent: makeModel(),
    AgentVersion: makeModel(),
    Deployment: makeModel(),
    Contact: makeModel(),
    TenantMember: makeModel(),
    ApiKey: makeModel(),
    Workflow: makeModel(),
    LLMUsageMetric: makeModel(),
    DeletionRequest: makeModel(),
    SDKChannel: makeModel(),
    LLMCredential: makeModel(),
    PublicApiKey: makeModel(),
    WidgetConfig: makeModel(),
    Fact: makeModel(),
    AuditLog: makeModel(),
    PIIAuditLog: makeModel(),
    PIITokenVault: makeModel(),
    Tenant: makeModel(),
    ProjectMember: makeModel(),
    Attachment: makeModel(),
    ConnectorConnection: makeModel(),
    ProjectLLMConfig: makeModel(),
    ProjectRuntimeConfig: makeModel(),
    ModelConfig: makeModel(),
    AgentModelConfig: makeModel(),
    ProjectSettings: makeModel(),
    ProjectSettingsVersion: makeModel(),
    User: makeModel({
      findOne: (...args: unknown[]) => mockUserFindOne(...args),
    }),
    OrgMember: makeModel(),
    RefreshToken: makeModel(),
    DebugToken: makeModel(),
    EmailVerificationToken: makeModel(),
    PasswordResetToken: makeModel(),
    AuthProfile: makeModel({
      deleteMany: mockAuthProfileDeleteMany,
      updateMany: mockAuthProfileUpdateMany,
    }),
    AuthProfileAuditEvent: makeModel(),
    EndUserOAuthToken: makeModel({
      deleteMany: mockEndUserOAuthTokenDeleteMany,
    }),
    VariableNamespaceMembership: makeModel(),
    VariableNamespace: makeModel(),
    DeploymentVariableSnapshot: makeModel(),
    EnvironmentVariable: makeModel(),
    ProjectConfigVariable: makeModel(),
    AgentAssistBinding: makeModel(),
    ProjectAgentAssistSettings: makeModel(),
    PlatformAccessRequest: makeModel({
      deleteMany: mockPlatformAccessRequestDeleteMany,
    }),
    PlatformAdmin: makeModel({
      deleteMany: mockPlatformAdminDeleteMany,
    }),
    PlatformAllowedDomain: makeModel(),
    PlatformAllowedEmail: makeModel(),
    WorkspaceInvitation: makeModel(),
    Subscription: makeModel(),
    ModuleRelease: makeModel(),
    ProjectModuleDependency: makeModel(),
    DeploymentModuleSnapshot: makeModel(),
    ModuleEnvironmentPointer: makeModel(),
    ContactCapabilityConsent: makeModel(),
    OmnichannelProjectSettings: makeModel(),
    // Workflow event-sourcing cascade (ABLP-2 Phase 4).
    WorkflowExecution: makeModel(),
    HumanTask: makeModel(),
    WorkflowEventOutboxModel: makeModel(),
    PromptLibraryVersion: makeModel(),
    PromptLibraryItem: makeModel(),
    ExternalAgentConfig: makeModel(),
    MCPServerConfig: makeModel(),
    GovernancePolicyVersion: makeModel(),
    GovernanceOverride: makeModel(),
    GovernancePolicy: makeModel(),
    // ABLP-155 right-to-erasure: trigger registrations carry user-supplied
    // webhook tokens + connector triggerParams — included in both tenant and
    // project cascade.
    TriggerRegistration: makeModel(),
    CrawlError: makeModel(),
  };
});

vi.mock('../cascade/event-cascade-hooks.js', () => ({
  getEventCascadeHook: vi.fn(() => null),
}));

import { deleteTenant, deleteProject, deleteUser } from '../cascade/cascade-delete.js';

describe('GDPR cascade — AuthProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: User.findOne().select().lean() returns a doc with an email for deleteUser tests.
    mockUserFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ email: 'user@example.com' }),
      }),
    });
  });

  test('deleteTenant deletes all AuthProfiles for the tenant', async () => {
    const result = await deleteTenant('tenant-1');
    expect(mockAuthProfileDeleteMany).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(result.counts.AuthProfile).toBeDefined();
  });

  test('deleteTenant deletes all EndUserOAuthTokens for the tenant', async () => {
    const result = await deleteTenant('tenant-1');
    expect(mockEndUserOAuthTokenDeleteMany).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(result.counts.EndUserOAuthToken).toBeDefined();
  });

  test('deleteProject deletes all AuthProfiles for the project', async () => {
    const result = await deleteProject('proj-1');
    expect(mockAuthProfileDeleteMany).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(result.counts.AuthProfile).toBeDefined();
  });

  test('deleteProject deletes all EndUserOAuthTokens for the project', async () => {
    const result = await deleteProject('proj-1');
    expect(mockEndUserOAuthTokenDeleteMany).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(result.counts.EndUserOAuthToken).toBeDefined();
  });

  test('deleteUser deletes personal AuthProfiles and anonymizes shared ones', async () => {
    const result = await deleteUser('user-1');
    expect(mockAuthProfileDeleteMany).toHaveBeenCalledWith({
      createdBy: 'user-1',
      visibility: 'personal',
    });
    expect(result.counts.AuthProfile).toBeDefined();
    expect(mockAuthProfileUpdateMany).toHaveBeenCalledWith(
      { createdBy: 'user-1', visibility: { $ne: 'personal' } },
      { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
    );
  });

  test('deleteUser deletes all EndUserOAuthTokens for the user', async () => {
    const result = await deleteUser('user-1');
    expect(mockEndUserOAuthTokenDeleteMany).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(result.counts.EndUserOAuthToken).toBeDefined();
  });

  test('deleteUser erases PlatformAccessRequest records keyed by the user email', async () => {
    const result = await deleteUser('user-1');
    expect(mockPlatformAccessRequestDeleteMany).toHaveBeenCalledWith({
      email: 'user@example.com',
    });
    expect(result.counts.PlatformAccessRequest).toBeDefined();
  });

  test('deleteUser erases PlatformAdmin records keyed by the user email', async () => {
    const result = await deleteUser('user-1');
    expect(mockPlatformAdminDeleteMany).toHaveBeenCalledWith({ email: 'user@example.com' });
    expect(result.counts.PlatformAdmin).toBeDefined();
  });

  test('deleteUser skips platform erasure when the user document has no email', async () => {
    mockUserFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });
    await deleteUser('user-1');
    expect(mockPlatformAccessRequestDeleteMany).not.toHaveBeenCalled();
    expect(mockPlatformAdminDeleteMany).not.toHaveBeenCalled();
  });
});
