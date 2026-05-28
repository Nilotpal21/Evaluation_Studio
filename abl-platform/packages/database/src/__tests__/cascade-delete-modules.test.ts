/**
 * Cascade Delete Module Tests
 *
 * Tests the module-specific cascade delete logic by mocking model imports.
 * Validates:
 * - Path A: Module project deletion (blocks on consumers, deletes pointers/releases)
 * - Path B: Consumer project deletion (deletes dependencies/snapshots)
 * - softDeleteModuleProject: Archives project and releases
 * - deleteTenant: Includes all 4 module collections
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCK MODELS
// =============================================================================

function createMockModel(findResults: any[] = [], deleteCount = 0, updateCount = 0) {
  const leanResult = { lean: vi.fn().mockResolvedValue(findResults) };
  const limitResult = { limit: vi.fn().mockReturnValue(leanResult), lean: leanResult.lean };
  return {
    find: vi.fn().mockReturnValue(limitResult),
    findOne: vi.fn().mockResolvedValue(null),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: deleteCount }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: updateCount }),
    countDocuments: vi.fn().mockResolvedValue(0),
  };
}

const Project = createMockModel([{ _id: 'proj-1', tenantId: 'tenant-1', kind: 'application' }], 1);
const ProjectAgent = createMockModel([{ _id: 'agent-1' }], 1);
const Session = createMockModel([{ _id: 'sess-1' }], 1);
const Message = createMockModel([], 5);
const AgentVersion = createMockModel([], 2);
const Deployment = createMockModel([], 1);
const Contact = createMockModel([], 0);
const TenantMember = createMockModel([], 0);
const ApiKey = createMockModel([], 0);
const Workflow = createMockModel([], 0);
const LLMUsageMetric = createMockModel([], 0);
const Attachment = createMockModel([], 0);
const DeletionRequest = createMockModel([], 0);
const SDKChannel = createMockModel([], 0);
const LLMCredential = createMockModel([], 0);
const PublicApiKey = createMockModel([], 0);
const WidgetConfig = createMockModel([], 0);
const Fact = createMockModel([], 0);
const AuditLog = createMockModel([], 0, 3);
const PIIAuditLog = createMockModel([], 0);
const PIITokenVault = createMockModel([], 0);
const Tenant = createMockModel([], 1);
const ProjectMember = createMockModel([], 0);
const ProjectLLMConfig = createMockModel([], 0);
const ProjectRuntimeConfig = createMockModel([], 0);
const ModelConfig = createMockModel([], 0);
const AgentModelConfig = createMockModel([], 0);
const ProjectSettings = createMockModel([], 0);
const ProjectSettingsVersion = createMockModel([], 0);
const ConnectorConnection = createMockModel([], 0);
const AuthProfile = createMockModel([], 0);
const AuthProfileAuditEvent = createMockModel([], 0);
const EndUserOAuthToken = createMockModel([], 0);
const User = createMockModel([], 0);
const VariableNamespaceMembership = createMockModel([], 0);
const VariableNamespace = createMockModel([], 0);
const DeploymentVariableSnapshot = createMockModel([], 0);
const EnvironmentVariable = createMockModel([], 0);
const ProjectConfigVariable = createMockModel([], 0);
const AgentAssistBinding = createMockModel([], 0);
const ProjectAgentAssistSettings = createMockModel([], 0);
const PlatformAccessRequest = createMockModel([], 0);
const PlatformAdmin = createMockModel([], 0);
const PlatformAllowedDomain = createMockModel([], 0);
const PlatformAllowedEmail = createMockModel([], 0);
const WorkspaceInvitation = createMockModel([], 0);

// Module-specific models
const ModuleRelease = createMockModel([], 3, 2);
const ModuleEnvironmentPointer = createMockModel([], 2);
const ProjectModuleDependency = createMockModel([], 1);
const DeploymentModuleSnapshot = createMockModel([], 1);
const ContactCapabilityConsent = createMockModel([], 0);
const OmnichannelProjectSettings = createMockModel([], 0);

// Prompt Library
const PromptLibraryVersion = createMockModel([], 0);
const PromptLibraryItem = createMockModel([], 0);

// Workflow event-sourcing cascade (ABLP-2 Phase 4).
const WorkflowExecution = createMockModel([], 0);
const HumanTask = createMockModel([], 0);
const WorkflowEventOutboxModel = createMockModel([], 0);
const ExternalAgentConfig = createMockModel([], 0);
const MCPServerConfig = createMockModel([], 0);

// Governance models (ABLP-698)
const GovernancePolicyVersion = createMockModel([], 0);
const GovernanceOverride = createMockModel([], 0);
const GovernancePolicy = createMockModel([], 0);

// ABLP-155 right-to-erasure — trigger registrations are part of both tenant
// and project cascades so user-supplied webhook tokens + triggerParams erase
// with the parent.
const TriggerRegistration = createMockModel([], 0);

vi.mock('../models/index.js', () => ({
  Project,
  ProjectAgent,
  Session,
  Message,
  AgentVersion,
  Deployment,
  Contact,
  TenantMember,
  ApiKey,
  Workflow,
  LLMUsageMetric,
  Attachment,
  DeletionRequest,
  SDKChannel,
  LLMCredential,
  PublicApiKey,
  WidgetConfig,
  Fact,
  AuditLog,
  PIIAuditLog,
  PIITokenVault,
  Tenant,
  ProjectMember,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  ModelConfig,
  AgentModelConfig,
  ProjectSettings,
  ProjectSettingsVersion,
  ConnectorConnection,
  AuthProfile,
  AuthProfileAuditEvent,
  EndUserOAuthToken,
  User,
  VariableNamespaceMembership,
  VariableNamespace,
  DeploymentVariableSnapshot,
  EnvironmentVariable,
  ProjectConfigVariable,
  AgentAssistBinding,
  ProjectAgentAssistSettings,
  PlatformAccessRequest,
  PlatformAdmin,
  PlatformAllowedDomain,
  PlatformAllowedEmail,
  WorkspaceInvitation,
  ModuleRelease,
  ModuleEnvironmentPointer,
  ProjectModuleDependency,
  DeploymentModuleSnapshot,
  ContactCapabilityConsent,
  OmnichannelProjectSettings,
  WorkflowExecution,
  HumanTask,
  WorkflowEventOutboxModel,
  PromptLibraryVersion,
  PromptLibraryItem,
  ExternalAgentConfig,
  MCPServerConfig,
  GovernancePolicyVersion,
  GovernanceOverride,
  GovernancePolicy,
  TriggerRegistration,
  CrawlError: createMockModel([], 0),
}));

// Import after mocking
import {
  deleteTenant,
  deleteProject,
  softDeleteModuleProject,
  CascadeDeleteBlockedError,
} from '../cascade/cascade-delete.js';

// =============================================================================
// TESTS
// =============================================================================

describe('Cascade Delete — Module Paths', () => {
  beforeEach(() => {
    // Reset call counts but keep implementations
    const allModels = [
      Project,
      ProjectAgent,
      Session,
      Message,
      AgentVersion,
      Deployment,
      Contact,
      TenantMember,
      ApiKey,
      Workflow,
      LLMUsageMetric,
      Attachment,
      DeletionRequest,
      SDKChannel,
      LLMCredential,
      PublicApiKey,
      WidgetConfig,
      Fact,
      AuditLog,
      PIIAuditLog,
      PIITokenVault,
      Tenant,
      ProjectMember,
      ProjectLLMConfig,
      ProjectRuntimeConfig,
      ModelConfig,
      AgentModelConfig,
      ProjectSettings,
      ProjectSettingsVersion,
      ConnectorConnection,
      AuthProfile,
      AuthProfileAuditEvent,
      EndUserOAuthToken,
      VariableNamespaceMembership,
      VariableNamespace,
      DeploymentVariableSnapshot,
      EnvironmentVariable,
      ProjectConfigVariable,
      AgentAssistBinding,
      ProjectAgentAssistSettings,
      ModuleRelease,
      ModuleEnvironmentPointer,
      ProjectModuleDependency,
      DeploymentModuleSnapshot,
      ContactCapabilityConsent,
      OmnichannelProjectSettings,
      ExternalAgentConfig,
      MCPServerConfig,
      GovernancePolicyVersion,
      GovernanceOverride,
      GovernancePolicy,
    ];
    for (const model of allModels) {
      vi.mocked(model.deleteMany).mockClear();
      vi.mocked(model.updateMany).mockClear();
      vi.mocked(model.countDocuments).mockClear();
      vi.mocked(model.findOneAndUpdate).mockClear();
    }
  });

  // ── Path A: Module project with active consumers (BLOCKED) ──────────

  describe('deleteProject — Path A: module project with consumers', () => {
    test('blocks when active consumer dependencies exist', async () => {
      // Configure Project.find to return a module project
      Project.find = vi.fn().mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([{ _id: 'mod-proj-1', tenantId: 'tenant-1', kind: 'module' }]),
      });

      // Configure ProjectModuleDependency.countDocuments to indicate active consumers
      ProjectModuleDependency.countDocuments = vi.fn().mockResolvedValue(2);

      // Configure ProjectModuleDependency.find to return consumer project IDs
      const leanMock = vi
        .fn()
        .mockResolvedValue([{ projectId: 'consumer-proj-1' }, { projectId: 'consumer-proj-2' }]);
      ProjectModuleDependency.find = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ lean: leanMock }),
        lean: leanMock,
      });

      await expect(deleteProject('mod-proj-1', 'tenant-1')).rejects.toThrow(
        CascadeDeleteBlockedError,
      );

      try {
        await deleteProject('mod-proj-1', 'tenant-1');
      } catch (err) {
        expect(err).toBeInstanceOf(CascadeDeleteBlockedError);
        const blocked = err as CascadeDeleteBlockedError;
        expect(blocked.code).toBe('MODULE_DELETE_BLOCKED');
        expect(blocked.consumerProjectIds).toEqual(['consumer-proj-1', 'consumer-proj-2']);
      }
    });
  });

  // ── Path A: Module project with NO consumers (deletes pointers + releases) ──

  describe('deleteProject — Path A: module project without consumers', () => {
    test('deletes pointers and releases when no consumers exist', async () => {
      // Configure Project.find to return a module project
      Project.find = vi.fn().mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([{ _id: 'mod-proj-1', tenantId: 'tenant-1', kind: 'module' }]),
      });

      // No consumers
      ProjectModuleDependency.countDocuments = vi.fn().mockResolvedValue(0);

      // Reset module deletes to track counts
      ModuleEnvironmentPointer.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 3 });
      ModuleRelease.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 5 });
      ProjectModuleDependency.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
      DeploymentModuleSnapshot.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });

      const result = await deleteProject('mod-proj-1', 'tenant-1');

      // Verify pointers deleted with correct scope
      expect(ModuleEnvironmentPointer.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        moduleProjectId: 'mod-proj-1',
      });

      // Verify releases deleted with correct scope
      expect(ModuleRelease.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        moduleProjectId: 'mod-proj-1',
      });

      expect(result.counts.ModuleEnvironmentPointer).toBe(3);
      expect(result.counts.ModuleRelease).toBe(5);
    });
  });

  // ── Path B: Consumer project (deletes dependencies + snapshots) ──────

  describe('deleteProject — Path B: consumer project', () => {
    test('deletes ProjectModuleDependency and DeploymentModuleSnapshot', async () => {
      // Configure Project.find to return a non-module project
      Project.find = vi.fn().mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([
            { _id: 'consumer-proj-1', tenantId: 'tenant-1', kind: 'application' },
          ]),
      });

      ProjectModuleDependency.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 2 });
      DeploymentModuleSnapshot.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
      PIIAuditLog.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 2 });
      PIITokenVault.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 3 });

      const result = await deleteProject('consumer-proj-1', 'tenant-1');

      // Verify dependency cleanup scoped to consumer project
      expect(ProjectModuleDependency.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'consumer-proj-1',
      });

      // Verify snapshot cleanup scoped to consumer project
      expect(DeploymentModuleSnapshot.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'consumer-proj-1',
      });
      expect(PIIAuditLog.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'consumer-proj-1',
      });
      expect(PIITokenVault.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'consumer-proj-1',
      });

      expect(result.counts.ProjectModuleDependency).toBe(2);
      expect(result.counts.DeploymentModuleSnapshot).toBe(1);
      expect(result.counts.PIIAuditLog).toBe(2);
      expect(result.counts.PIITokenVault).toBe(3);
    });
  });

  // ── softDeleteModuleProject ──────────────────────────────────────────

  describe('softDeleteModuleProject', () => {
    test('sets archivedAt and archivedBy on project and releases', async () => {
      Project.findOneAndUpdate = vi.fn().mockResolvedValue({});
      ModuleRelease.updateMany = vi.fn().mockResolvedValue({ modifiedCount: 4 });

      const result = await softDeleteModuleProject('mod-proj-1', 'tenant-1', 'user-admin');

      // Verify project was archived (kind: 'module' added by Sprint 1 audit)
      expect(Project.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'mod-proj-1', tenantId: 'tenant-1', kind: 'module' },
        { $set: expect.objectContaining({ archivedBy: 'user-admin' }) },
      );

      // Verify the $set includes archivedAt as a Date
      const projectCall = vi.mocked(Project.findOneAndUpdate).mock.calls[0];
      expect((projectCall[1] as any).$set.archivedAt).toBeInstanceOf(Date);

      // Verify releases were archived
      expect(ModuleRelease.updateMany).toHaveBeenCalledWith(
        { tenantId: 'tenant-1', moduleProjectId: 'mod-proj-1' },
        { $set: expect.objectContaining({ archivedBy: 'user-admin' }) },
      );

      expect(result.archivedReleases).toBe(4);
    });
  });

  // ── deleteTenant includes all 4 module collections ───────────────────

  describe('deleteTenant — module collection cascade', () => {
    test('deletes all 4 module collections in dependency order', async () => {
      // Reset to track fresh calls
      DeploymentModuleSnapshot.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 10 });
      ProjectModuleDependency.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 5 });
      ModuleEnvironmentPointer.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 3 });
      ModuleRelease.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 8 });
      PIIAuditLog.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 6 });
      PIITokenVault.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 7 });

      // Reconfigure standard find results
      Project.find = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'proj-1' }]),
      });
      ProjectAgent.find = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'agent-1' }]),
      });
      Session.find = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      });

      const result = await deleteTenant('tenant-1');

      // All 4 module models deleted with tenantId scope
      expect(DeploymentModuleSnapshot.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });
      expect(ProjectModuleDependency.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });
      expect(ModuleEnvironmentPointer.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });
      expect(ModuleRelease.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });
      expect(PIIAuditLog.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });
      expect(PIITokenVault.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });

      // Counts present in result
      expect(result.counts.DeploymentModuleSnapshot).toBe(10);
      expect(result.counts.ProjectModuleDependency).toBe(5);
      expect(result.counts.ModuleEnvironmentPointer).toBe(3);
      expect(result.counts.ModuleRelease).toBe(8);
      expect(result.counts.PIIAuditLog).toBe(6);
      expect(result.counts.PIITokenVault).toBe(7);

      // Total includes module counts
      expect(result.total).toBeGreaterThanOrEqual(26); // 10 + 5 + 3 + 8 = 26 minimum
    });
  });

  // ── CascadeDeleteBlockedError shape ──────────────────────────────────

  describe('CascadeDeleteBlockedError', () => {
    test('has correct error properties', () => {
      const err = new CascadeDeleteBlockedError(['proj-a', 'proj-b']);
      expect(err.name).toBe('CascadeDeleteBlockedError');
      expect(err.code).toBe('MODULE_DELETE_BLOCKED');
      expect(err.consumerProjectIds).toEqual(['proj-a', 'proj-b']);
      expect(err.message).toContain('2 consumer project(s)');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
