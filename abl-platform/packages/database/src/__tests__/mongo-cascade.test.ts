/**
 * Cascade Delete Tests
 *
 * Tests the cascade delete functions by mocking the model imports
 * since they depend on the full model schema ecosystem.
 * We validate the correct ordering and count aggregation logic.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCK MODELS
// =============================================================================

/**
 * Create a mock Mongoose model with find, deleteMany, and updateMany.
 * The model tracks calls for assertions.
 */
function createMockModel(findResults: any[] = [], deleteCount = 0, updateCount = 0) {
  return {
    find: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(findResults),
    }),
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: deleteCount }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: updateCount }),
  };
}

// We mock the dynamic import of '../models/index.js' used by cascade-delete
vi.mock('../models/index.js', () => {
  const models: Record<string, ReturnType<typeof createMockModel>> = {};

  function getOrCreate(name: string, findData: any[] = [], delCount = 0, updCount = 0) {
    if (!models[name]) {
      models[name] = createMockModel(findData, delCount, updCount);
    }
    return models[name];
  }

  return {
    // Entities that return find results for IDs
    Project: getOrCreate('Project', [{ _id: 'proj-1' }, { _id: 'proj-2' }], 2),
    ProjectAgent: getOrCreate('ProjectAgent', [{ _id: 'agent-1' }], 1),
    Session: getOrCreate('Session', [{ _id: 'sess-1' }, { _id: 'sess-2' }], 2),
    Message: getOrCreate('Message', [], 10),
    AgentVersion: getOrCreate('AgentVersion', [], 3),
    Deployment: getOrCreate('Deployment', [], 1),
    Contact: getOrCreate('Contact', [], 2),
    TenantMember: getOrCreate('TenantMember', [], 1),
    ApiKey: getOrCreate('ApiKey', [], 1),
    Workflow: getOrCreate('Workflow', [], 0),
    LLMUsageMetric: getOrCreate('LLMUsageMetric', [], 5),
    Attachment: getOrCreate('Attachment', [], 0),
    DeletionRequest: getOrCreate('DeletionRequest', [], 0),
    SDKChannel: getOrCreate('SDKChannel', [], 0),
    LLMCredential: getOrCreate('LLMCredential', [], 0),
    PublicApiKey: getOrCreate('PublicApiKey', [], 0),
    WidgetConfig: getOrCreate('WidgetConfig', [], 0),
    Fact: getOrCreate('Fact', [], 0),
    AuditLog: getOrCreate('AuditLog', [], 0, 5),
    PIIAuditLog: getOrCreate('PIIAuditLog', [], 4),
    PIITokenVault: getOrCreate('PIITokenVault', [], 6),
    Tenant: getOrCreate('Tenant', [], 1),
    ProjectMember: getOrCreate('ProjectMember', [], 0),
    Subscription: getOrCreate('Subscription', [], 1),
    ProjectLLMConfig: getOrCreate('ProjectLLMConfig', [], 0),
    ProjectRuntimeConfig: getOrCreate('ProjectRuntimeConfig', [], 0),
    ModelConfig: getOrCreate('ModelConfig', [], 0),
    AgentModelConfig: getOrCreate('AgentModelConfig', [], 0),
    ProjectSettings: getOrCreate('ProjectSettings', [], 0),
    ProjectSettingsVersion: getOrCreate('ProjectSettingsVersion', [], 0),
    ConnectorConnection: getOrCreate('ConnectorConnection', [], 0),
    AuthProfile: getOrCreate('AuthProfile', [], 0),
    AuthProfileAuditEvent: getOrCreate('AuthProfileAuditEvent', [], 0),
    EndUserOAuthToken: getOrCreate('EndUserOAuthToken', [], 0),
    VariableNamespaceMembership: getOrCreate('VariableNamespaceMembership', [], 0),
    VariableNamespace: getOrCreate('VariableNamespace', [], 0),
    DeploymentVariableSnapshot: getOrCreate('DeploymentVariableSnapshot', [], 0),
    EnvironmentVariable: getOrCreate('EnvironmentVariable', [], 0),
    ProjectConfigVariable: getOrCreate('ProjectConfigVariable', [], 0),
    AgentAssistBinding: getOrCreate('AgentAssistBinding', [], 0),
    ProjectAgentAssistSettings: getOrCreate('ProjectAgentAssistSettings', [], 0),
    PlatformAccessRequest: getOrCreate('PlatformAccessRequest', [], 0),
    PlatformAdmin: getOrCreate('PlatformAdmin', [], 0),
    PlatformAllowedDomain: getOrCreate('PlatformAllowedDomain', [], 0),
    PlatformAllowedEmail: getOrCreate('PlatformAllowedEmail', [], 0),
    WorkspaceInvitation: getOrCreate('WorkspaceInvitation', [], 0),

    // User cascade
    User: getOrCreate('User', [], 1),
    OrgMember: getOrCreate('OrgMember', [], 1),
    RefreshToken: getOrCreate('RefreshToken', [], 2),
    DebugToken: getOrCreate('DebugToken', [], 0),
    EmailVerificationToken: getOrCreate('EmailVerificationToken', [], 0),
    PasswordResetToken: getOrCreate('PasswordResetToken', [], 0),
    ModuleRelease: getOrCreate('ModuleRelease', [], 0),
    ProjectModuleDependency: getOrCreate('ProjectModuleDependency', [], 0),
    DeploymentModuleSnapshot: getOrCreate('DeploymentModuleSnapshot', [], 0),
    ModuleEnvironmentPointer: getOrCreate('ModuleEnvironmentPointer', [], 0),
    ContactCapabilityConsent: getOrCreate('ContactCapabilityConsent', [], 0),
    OmnichannelProjectSettings: getOrCreate('OmnichannelProjectSettings', [], 0),

    // Workflow event-sourcing cascade (ABLP-2 Phase 4). `deleteTenant` in
    // `cascade-delete.ts` drops workflow_executions + workflow-mailbox
    // human_tasks + the outbox collection so the 7-store cascade (feature
    // spec §10) stays complete.
    WorkflowExecution: getOrCreate('WorkflowExecution', [], 0),
    HumanTask: getOrCreate('HumanTask', [], 0),
    WorkflowEventOutboxModel: getOrCreate('WorkflowEventOutboxModel', [], 0),
    PromptLibraryVersion: getOrCreate('PromptLibraryVersion', [], 0),
    PromptLibraryItem: getOrCreate('PromptLibraryItem', [], 0),
    ExternalAgentConfig: getOrCreate('ExternalAgentConfig', [], 0),
    MCPServerConfig: getOrCreate('MCPServerConfig', [], 0),
    // ABLP-155 right-to-erasure: TriggerRegistration carries user-supplied
    // webhook callback display tokens + connector triggerParams; must drop
    // with the parent tenant/project cascade.
    TriggerRegistration: getOrCreate('TriggerRegistration', [], 0),

    // Governance cascade (deepest first: versions → overrides → policies)
    GovernancePolicyVersion: getOrCreate('GovernancePolicyVersion', [], 0),
    GovernanceOverride: getOrCreate('GovernanceOverride', [], 0),
    GovernancePolicy: getOrCreate('GovernancePolicy', [], 0),
    CrawlError: getOrCreate('CrawlError', [], 0),
  };
});

// Import after mocking
import {
  deleteTenant,
  deleteProject,
  deleteUser,
  deleteSession,
  deleteSubscription,
} from '../cascade/cascade-delete.js';

// =============================================================================
// TESTS
// =============================================================================

describe('Cascade Delete', () => {
  describe('deleteTenant', () => {
    test('returns cascade delete result with counts', async () => {
      const result = await deleteTenant('tenant-123');

      expect(result).toBeDefined();
      expect(result.counts).toBeDefined();
      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(typeof result.total).toBe('number');
    });

    test('includes per-model deletion counts', async () => {
      const result = await deleteTenant('tenant-123');

      // Verify that expected model keys exist in counts
      expect(result.counts).toHaveProperty('Message');
      expect(result.counts).toHaveProperty('Session');
      expect(result.counts).toHaveProperty('ProjectAgent');
      expect(result.counts).toHaveProperty('Project');
      expect(result.counts).toHaveProperty('Tenant');
      expect(result.counts).toHaveProperty('PIIAuditLog');
      expect(result.counts).toHaveProperty('PIITokenVault');
      expect(result.counts).toHaveProperty('ProjectRuntimeConfig');
      expect(result.counts).toHaveProperty('ProjectLLMConfig');
      expect(result.counts).toHaveProperty('ModelConfig');
      expect(result.counts).toHaveProperty('AgentModelConfig');
      expect(result.counts).toHaveProperty('TriggerRegistration');
      expect(result.counts).toHaveProperty('EndUserOAuthToken');
      expect(result.counts).toHaveProperty('AuthProfileAuditEvent');
    });

    test('erases trigger registrations scoped to tenant (right-to-erasure)', async () => {
      const models = await import('../models/index.js');
      await deleteTenant('tenant-123');
      expect(models.TriggerRegistration.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
      });
    });

    test('deletes tenant runtime and model config state by tenant scope', async () => {
      const models = await import('../models/index.js');

      await deleteTenant('tenant-123');

      expect(models.ProjectRuntimeConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
      });
      expect(models.ProjectLLMConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
      });
      expect(models.ModelConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
      });
      expect(models.AgentModelConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
      });
    });

    test('anonymizes audit logs instead of deleting', async () => {
      const result = await deleteTenant('tenant-123');

      expect(result.anonymized).toBeDefined();
      expect(result.anonymized).toHaveProperty('AuditLog');
    });

    test('total equals sum of all counts', async () => {
      const result = await deleteTenant('tenant-123');

      const calculatedTotal = Object.values(result.counts).reduce((sum, c) => sum + c, 0);
      expect(result.total).toBe(calculatedTotal);
    });
  });

  describe('deleteProject', () => {
    test('returns cascade delete result', async () => {
      const result = await deleteProject('proj-123');

      expect(result).toBeDefined();
      expect(result.counts).toBeDefined();
      expect(typeof result.total).toBe('number');
    });

    test('includes expected model counts', async () => {
      const result = await deleteProject('proj-123');

      expect(result.counts).toHaveProperty('Message');
      expect(result.counts).toHaveProperty('Session');
      expect(result.counts).toHaveProperty('ProjectAgent');
      expect(result.counts).toHaveProperty('AgentVersion');
      expect(result.counts).toHaveProperty('AgentAssistBinding');
      expect(result.counts).toHaveProperty('ProjectAgentAssistSettings');
      expect(result.counts).toHaveProperty('Project');
      expect(result.counts).toHaveProperty('PIIAuditLog');
      expect(result.counts).toHaveProperty('PIITokenVault');
      expect(result.counts).toHaveProperty('ProjectRuntimeConfig');
      expect(result.counts).toHaveProperty('ProjectLLMConfig');
      expect(result.counts).toHaveProperty('ModelConfig');
      expect(result.counts).toHaveProperty('AgentModelConfig');
      expect(result.counts).toHaveProperty('EndUserOAuthToken');
      expect(result.counts).toHaveProperty('AuthProfileAuditEvent');
    });

    test('deletes project runtime and model config state with tenant project scope', async () => {
      const models = await import('../models/index.js');

      await deleteProject('proj-123', 'tenant-123');

      expect(models.ProjectRuntimeConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        projectId: 'proj-123',
      });
      expect(models.ProjectLLMConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        projectId: 'proj-123',
      });
      expect(models.ModelConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        projectId: 'proj-123',
      });
      expect(models.AgentModelConfig.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        projectId: 'proj-123',
      });
    });

    test('has empty anonymized object', async () => {
      const result = await deleteProject('proj-123');

      expect(result.anonymized).toEqual({});
    });

    test('total equals sum of counts', async () => {
      const result = await deleteProject('proj-123');

      const calculatedTotal = Object.values(result.counts).reduce((sum, c) => sum + c, 0);
      expect(result.total).toBe(calculatedTotal);
    });
  });

  describe('deleteUser', () => {
    test('returns cascade delete result', async () => {
      const result = await deleteUser('user-123');

      expect(result).toBeDefined();
      expect(result.counts).toBeDefined();
      expect(typeof result.total).toBe('number');
    });

    test('includes token and membership deletions', async () => {
      const result = await deleteUser('user-123');

      expect(result.counts).toHaveProperty('RefreshToken');
      expect(result.counts).toHaveProperty('OrgMember');
      expect(result.counts).toHaveProperty('TenantMember');
      expect(result.counts).toHaveProperty('User');
      expect(result.counts).toHaveProperty('EndUserOAuthToken');
    });

    test('anonymizes audit logs for GDPR', async () => {
      const result = await deleteUser('user-123');

      expect(result.anonymized).toHaveProperty('AuditLog');
    });
  });

  describe('deleteSession', () => {
    test('deletes session and its messages', async () => {
      const result = await deleteSession('sess-123');

      expect(result).toBeDefined();
      expect(result.counts).toHaveProperty('Message');
      expect(result.counts).toHaveProperty('LLMUsageMetric');
      expect(result.counts).toHaveProperty('PIITokenVault');
      expect(result.counts).toHaveProperty('Session');
    });

    test('has empty anonymized object', async () => {
      const result = await deleteSession('sess-123');

      expect(result.anonymized).toEqual({});
    });

    test('total equals sum of counts', async () => {
      const result = await deleteSession('sess-123');

      const calculatedTotal = Object.values(result.counts).reduce((sum, c) => sum + c, 0);
      expect(result.total).toBe(calculatedTotal);
    });
  });

  describe('deleteSubscription', () => {
    test('deletes the subscription', async () => {
      const result = await deleteSubscription('sub-123');

      expect(result).toBeDefined();
      expect(result.counts).toHaveProperty('Subscription');
    });

    test('has empty anonymized object', async () => {
      const result = await deleteSubscription('sub-123');

      expect(result.anonymized).toEqual({});
    });

    test('total equals sum of counts', async () => {
      const result = await deleteSubscription('sub-123');

      const calculatedTotal = Object.values(result.counts).reduce((sum, c) => sum + c, 0);
      expect(result.total).toBe(calculatedTotal);
    });
  });

  describe('CascadeDeleteResult shape', () => {
    test('result has counts, total, and anonymized fields', async () => {
      const result = await deleteSession('any-id');

      expect(result).toHaveProperty('counts');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('anonymized');
    });

    test('counts values are numbers', async () => {
      const result = await deleteSession('any-id');

      for (const value of Object.values(result.counts)) {
        expect(typeof value).toBe('number');
      }
    });
  });
});
