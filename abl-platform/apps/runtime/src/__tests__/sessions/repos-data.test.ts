/**
 * Data Repository Integration Tests
 *
 * Tests auth-repo.ts, rbac-repo.ts, security-repo.ts, channel-repo.ts,
 * tenant-model-repo.ts, and llm-resolution-repo.ts functions against
 * a real in-memory MongoDB.
 *
 * IMPORTANT: All imports from @agent-platform/database/models and repo
 * modules MUST be dynamic (inside beforeAll) because the models barrel
 * triggers an auto-connect on import.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';

// ─── Lazy-loaded Model references (populated in beforeAll after Mongo is ready) ─

let User: any;
let Tenant: any;
let TenantMember: any;
let ApiKey: any;
let RoleDefinition: any;
let ResourcePermission: any;
let PublicApiKey: any;
let SDKChannel: any;
let WidgetConfig: any;
let Project: any;
let ProjectAgent: any;
let TenantModel: any;
let TenantServiceInstance: any;
let LLMCredential: any;
let TenantLLMPolicy: any;
let AgentModelConfig: any;
let ModelConfig: any;
let ProjectLLMConfig: any;
let ProjectRuntimeConfig: any;
let OrgProxyConfig: any;
let EndUserOAuthToken: any;

// ─── Lazy-loaded Auth Repo functions ─────────────────────────────────────────

let findUserById: any;
let findUserByEmail: any;
let createUser: any;
let resolveTenantMembership: any;
let resolveDefaultTenant: any;
let resolveApiKey: any;

// ─── Lazy-loaded RBAC Repo functions ─────────────────────────────────────────

let findRoleDefinitions: any;
let findResourcePermissions: any;

// ─── Lazy-loaded Channel Repo functions ──────────────────────────────────────

let findPublicApiKey: any;
let findPublicApiKeyForSdk: any;
let updatePublicApiKeyLastUsed: any;
let createSDKChannel: any;
let findSDKChannels: any;
let findSDKChannelById: any;
let findSDKChannelByName: any;
let updateSDKChannel: any;
let deleteSDKChannel: any;
let findActivePublicApiKey: any;
let findWidgetConfig: any;

// ─── Lazy-loaded Security Repo functions ─────────────────────────────────────

let createOrgProxyConfig: any;
let findOrgProxyConfigs: any;
let countOrgProxyConfigs: any;
let findOrgProxyConfigById: any;
let updateOrgProxyConfig: any;
let deleteOrgProxyConfig: any;
let findEndUserOAuthTokens: any;
let countEndUserOAuthTokens: any;

// ─── Lazy-loaded Tenant Model Repo functions ─────────────────────────────────

let findTenantModel: any;
let findTenantModelWithConnections: any;
let findTenantModelAdmin: any;
let findTenantModelWithConnectionsAdmin: any;
let listTenantModels: any;
let countTenantModels: any;
let createTenantModel: any;
let updateTenantModel: any;
let updateTenantModelAdmin: any;
let updateTenantModelInference: any;
let findTenantModelConnections: any;
let createTenantModelConnection: any;
let findTenantModelConnectionById: any;
let updateTenantModelConnection: any;
let deleteTenantModelConnection: any;
let setConnectionPrimary: any;
let findTenantServiceInstance: any;
let listTenantServiceInstances: any;
let createTenantServiceInstance: any;
let updateTenantServiceInstance: any;
let deleteTenantServiceInstance: any;
let findLLMCredential: any;
let findTenant: any;
let findProjectsUsingTenantModel: any;

// ─── Lazy-loaded LLM Resolution Repo functions ──────────────────────────────

let isResolutionDatabaseAvailable: any;
let findAgentModelConfigResolution: any;
let findAgentModelConfigByDslNameResolution: any;
let findModelConfigByModelIdResolution: any;
let findModelConfigForTier: any;
let findAnyModelConfig: any;
let findTenantModelByIdWithPrimaryConnection: any;
let findDefaultTenantModelForTier: any;
let findTenantModelByProvider: any;
let findDefaultTenantModelForVoice: any;
let findTenantLLMPolicy: any;
let findProjectOperationTierOverrides: any;
let findDefaultUserCredential: any;
let findDefaultTenantCredential: any;
let findCredentialByIdResolution: any;

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Connect to in-memory MongoDB FIRST (before models auto-connect)
  await setupTestMongo();

  // Dynamic imports AFTER mongo is connected
  const models = await import('@agent-platform/database/models');

  // Set encryption master key before any model operations that use encryptionPlugin
  // (EnvironmentVariable, EndUserOAuthToken, TenantServiceInstance, LLMCredential, etc.)
  models.setMasterKey('a'.repeat(64));
  await initDEKFacade({ masterKeyHex: 'a'.repeat(64) });
  User = models.User;
  Tenant = models.Tenant;
  TenantMember = models.TenantMember;
  ApiKey = models.ApiKey;
  RoleDefinition = models.RoleDefinition;
  ResourcePermission = models.ResourcePermission;
  PublicApiKey = models.PublicApiKey;
  SDKChannel = models.SDKChannel;
  WidgetConfig = models.WidgetConfig;
  Project = models.Project;
  ProjectAgent = models.ProjectAgent;
  TenantModel = models.TenantModel;
  TenantServiceInstance = models.TenantServiceInstance;
  LLMCredential = models.LLMCredential;
  TenantLLMPolicy = models.TenantLLMPolicy;
  AgentModelConfig = models.AgentModelConfig;
  ModelConfig = models.ModelConfig;
  ProjectLLMConfig = models.ProjectLLMConfig;
  ProjectRuntimeConfig = models.ProjectRuntimeConfig;
  OrgProxyConfig = models.OrgProxyConfig;
  EndUserOAuthToken = models.EndUserOAuthToken;

  // Auth repo
  const authRepo = await import('../../repos/auth-repo.js');
  findUserById = authRepo.findUserById;
  findUserByEmail = authRepo.findUserByEmail;
  createUser = authRepo.createUser;
  resolveTenantMembership = authRepo.resolveTenantMembership;
  resolveDefaultTenant = authRepo.resolveDefaultTenant;
  resolveApiKey = authRepo.resolveApiKey;

  // RBAC repo
  const rbacRepo = await import('../../repos/rbac-repo.js');
  findRoleDefinitions = rbacRepo.findRoleDefinitions;
  findResourcePermissions = rbacRepo.findResourcePermissions;

  // Channel repo
  const channelRepo = await import('../../repos/channel-repo.js');
  findPublicApiKey = channelRepo.findPublicApiKey;
  findPublicApiKeyForSdk = channelRepo.findPublicApiKeyForSdk;
  updatePublicApiKeyLastUsed = channelRepo.updatePublicApiKeyLastUsed;
  createSDKChannel = channelRepo.createSDKChannel;
  findSDKChannels = channelRepo.findSDKChannels;
  findSDKChannelById = channelRepo.findSDKChannelById;
  findSDKChannelByName = channelRepo.findSDKChannelByName;
  updateSDKChannel = channelRepo.updateSDKChannel;
  deleteSDKChannel = channelRepo.deleteSDKChannel;
  findActivePublicApiKey = channelRepo.findActivePublicApiKey;
  findWidgetConfig = channelRepo.findWidgetConfig;

  // Security repo
  const secRepo = await import('@agent-platform/shared/repos');
  createOrgProxyConfig = secRepo.createOrgProxyConfig;
  findOrgProxyConfigs = secRepo.findOrgProxyConfigs;
  countOrgProxyConfigs = secRepo.countOrgProxyConfigs;
  findOrgProxyConfigById = secRepo.findOrgProxyConfigById;
  updateOrgProxyConfig = secRepo.updateOrgProxyConfig;
  deleteOrgProxyConfig = secRepo.deleteOrgProxyConfig;
  findEndUserOAuthTokens = secRepo.findEndUserOAuthTokens;
  countEndUserOAuthTokens = secRepo.countEndUserOAuthTokens;

  // Tenant Model repo
  const tmRepo = await import('../../repos/tenant-model-repo.js');
  findTenantModel = tmRepo.findTenantModel;
  findTenantModelWithConnections = tmRepo.findTenantModelWithConnections;
  findTenantModelAdmin = tmRepo.findTenantModelAdmin;
  findTenantModelWithConnectionsAdmin = tmRepo.findTenantModelWithConnectionsAdmin;
  listTenantModels = tmRepo.listTenantModels;
  countTenantModels = tmRepo.countTenantModels;
  createTenantModel = tmRepo.createTenantModel;
  updateTenantModel = tmRepo.updateTenantModel;
  updateTenantModelAdmin = tmRepo.updateTenantModelAdmin;
  updateTenantModelInference = tmRepo.updateTenantModelInference;
  findTenantModelConnections = tmRepo.findTenantModelConnections;
  createTenantModelConnection = tmRepo.createTenantModelConnection;
  findTenantModelConnectionById = tmRepo.findTenantModelConnectionById;
  updateTenantModelConnection = tmRepo.updateTenantModelConnection;
  deleteTenantModelConnection = tmRepo.deleteTenantModelConnection;
  setConnectionPrimary = tmRepo.setConnectionPrimary;
  findTenantServiceInstance = tmRepo.findTenantServiceInstance;
  listTenantServiceInstances = tmRepo.listTenantServiceInstances;
  createTenantServiceInstance = tmRepo.createTenantServiceInstance;
  updateTenantServiceInstance = tmRepo.updateTenantServiceInstance;
  deleteTenantServiceInstance = tmRepo.deleteTenantServiceInstance;
  findLLMCredential = tmRepo.findLLMCredential;
  findTenant = tmRepo.findTenant;
  findProjectsUsingTenantModel = tmRepo.findProjectsUsingTenantModel;

  // LLM Resolution repo
  const llmRepo = await import('../../repos/llm-resolution-repo.js');
  isResolutionDatabaseAvailable = llmRepo.isResolutionDatabaseAvailable;
  findAgentModelConfigResolution = llmRepo.findAgentModelConfig;
  findAgentModelConfigByDslNameResolution = llmRepo.findAgentModelConfigByDslName;
  findModelConfigByModelIdResolution = llmRepo.findModelConfigByModelId;
  findModelConfigForTier = llmRepo.findModelConfigForTier;
  findAnyModelConfig = llmRepo.findAnyModelConfig;
  findTenantModelByIdWithPrimaryConnection = llmRepo.findTenantModelByIdWithPrimaryConnection;
  findDefaultTenantModelForTier = llmRepo.findDefaultTenantModelForTier;
  findTenantModelByProvider = llmRepo.findTenantModelByProvider;
  findDefaultTenantModelForVoice = llmRepo.findDefaultTenantModelForVoice;
  findTenantLLMPolicy = llmRepo.findTenantLLMPolicy;
  findProjectOperationTierOverrides = llmRepo.findProjectOperationTierOverrides;
  findDefaultUserCredential = llmRepo.findDefaultUserCredential;
  findDefaultTenantCredential = llmRepo.findDefaultTenantCredential;
  findCredentialByIdResolution = llmRepo.findCredentialById;
}, 60_000);

afterAll(async () => {
  await teardownTestMongo();
}, 15_000);

beforeEach(async () => {
  await clearCollections();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTenantModel(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    displayName: `Model ${Date.now()}`,
    integrationType: 'easy',
    provider: 'openai',
    modelId: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsStructured: false,
    tier: 'standard',
    isDefault: false,
    isActive: true,
    inferenceEnabled: true,
    createdBy: 'user-1',
    connections: [],
    ...overrides,
  };
}

function plainOverrides(value: Record<string, string> | Map<string, string> | null) {
  if (!value) return null;
  return value instanceof Map ? Object.fromEntries(value) : value;
}

// #############################################################################
// auth-repo: User operations
// #############################################################################

describe('auth-repo: User operations', () => {
  it('createUser creates and returns user record', async () => {
    const user = await createUser({
      email: 'test@example.com',
      name: 'Test User',
      authProvider: 'google',
    });

    expect(user.email).toBe('test@example.com');
    expect(user.name).toBe('Test User');
    expect(user.id).toBeDefined();
  });

  it('findUserById returns user when found', async () => {
    const created = await User.create({
      email: 'find@example.com',
      name: 'Find Me',
      authProvider: 'google',
    });

    const result = await findUserById(created._id);

    expect(result).not.toBeNull();
    expect(result!.email).toBe('find@example.com');
    expect(result!.name).toBe('Find Me');
    expect(result!.id).toBe(created._id);
  });

  it('findUserById returns null when not found', async () => {
    const result = await findUserById('nonexistent-id');
    expect(result).toBeNull();
  });

  it('findUserByEmail returns user when found', async () => {
    await User.create({
      email: 'byemail@example.com',
      name: 'Email Lookup',
      authProvider: 'google',
    });

    const result = await findUserByEmail('byemail@example.com');

    expect(result).not.toBeNull();
    expect(result!.email).toBe('byemail@example.com');
  });

  it('findUserByEmail returns null when not found', async () => {
    const result = await findUserByEmail('nonexistent@example.com');
    expect(result).toBeNull();
  });
});

// #############################################################################
// auth-repo: Tenant Membership
// #############################################################################

describe('auth-repo: Tenant Membership', () => {
  it('resolveTenantMembership returns membership with role', async () => {
    const tenant = await Tenant.create({
      name: 'Test Workspace',
      slug: `ws-${Date.now()}`,
      ownerId: 'owner-1',
      organizationId: 'org-1',
    });

    await TenantMember.create({
      tenantId: tenant._id,
      userId: 'user-member-1',
      role: 'admin',
    });

    const result = await resolveTenantMembership('user-member-1', tenant._id);

    expect(result).not.toBeNull();
    expect(result!.role).toBe('admin');
    expect(result!.orgId).toBe('org-1');
  });

  it('resolveTenantMembership returns null when no membership', async () => {
    const tenant = await Tenant.create({
      name: 'No Membership WS',
      slug: `ws-no-${Date.now()}`,
      ownerId: 'owner-1',
    });

    const result = await resolveTenantMembership('nonexistent-user', tenant._id);
    expect(result).toBeNull();
  });

  it('resolveDefaultTenant returns earliest membership', async () => {
    const tenant1 = await Tenant.create({
      name: 'First WS',
      slug: `ws-first-${Date.now()}`,
      ownerId: 'owner-1',
      organizationId: 'org-1',
    });

    await TenantMember.create({
      tenantId: tenant1._id,
      userId: 'user-default',
      role: 'member',
    });

    const result = await resolveDefaultTenant('user-default');

    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe(tenant1._id);
    expect(result!.role).toBe('member');
  });

  it('resolveDefaultTenant returns null when no memberships', async () => {
    const result = await resolveDefaultTenant('orphan-user');
    expect(result).toBeNull();
  });
});

// #############################################################################
// auth-repo: API Key resolution
// #############################################################################

describe('auth-repo: resolveApiKey', () => {
  it('expands dot-separated platform scopes into runtime RBAC permissions', async () => {
    await ApiKey.create({
      tenantId: 'tenant-api',
      name: 'Test Key',
      clientId: 'client-1',
      keyHash: 'hash-abc-123',
      prefix: 'ap_',
      scopes: ['workflows.execute', 'deployments.write'],
      projectIds: ['proj-1'],
      environments: ['dev'],
      createdBy: 'user-1',
    });

    const result = await resolveApiKey('hash-abc-123', 'ap_');

    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe('tenant-api');
    expect(result!.scopes).toEqual(
      expect.arrayContaining([
        'workflow:read',
        'workflow:execute',
        'deployment:read',
        'deployment:create',
      ]),
    );
    expect(result!.clientId).toBe('client-1');
  });

  it('passes through legacy colon-separated scopes unchanged', async () => {
    await ApiKey.create({
      tenantId: 'tenant-legacy',
      name: 'Legacy Key',
      clientId: 'client-legacy',
      keyHash: 'hash-legacy',
      prefix: 'ap_',
      scopes: ['workflow:execute'],
      projectIds: ['proj-legacy'],
      environments: [],
      createdBy: 'user-legacy',
    });

    const result = await resolveApiKey('hash-legacy', 'ap_');

    expect(result).not.toBeNull();
    expect(result!.scopes).toEqual(['workflow:execute']);
  });

  it('fails closed for unknown dot scopes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ApiKey.create({
        tenantId: 'tenant-unknown',
        name: 'Unknown Scope Key',
        clientId: 'client-unknown',
        keyHash: 'hash-unknown',
        prefix: 'ap_',
        scopes: ['foo.bar'],
        projectIds: ['proj-unknown'],
        environments: [],
        createdBy: 'user-unknown',
      });

      const result = await resolveApiKey('hash-unknown', 'ap_');

      expect(result).not.toBeNull();
      expect(result!.scopes).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns null when prefix does not match', async () => {
    await ApiKey.create({
      tenantId: 'tenant-api2',
      name: 'Prefix Mismatch',
      clientId: 'client-2',
      keyHash: 'hash-prefix',
      prefix: 'ap_',
      createdBy: 'user-1',
    });

    const result = await resolveApiKey('hash-prefix', 'wrong_');
    expect(result).toBeNull();
  });

  it('returns null when key is revoked', async () => {
    await ApiKey.create({
      tenantId: 'tenant-revoked',
      name: 'Revoked Key',
      clientId: 'client-rev',
      keyHash: 'hash-revoked',
      prefix: 'ap_',
      createdBy: 'user-1',
      revokedAt: new Date(),
    });

    const result = await resolveApiKey('hash-revoked', 'ap_');
    expect(result).toBeNull();
  });

  it('returns null when key is expired', async () => {
    await ApiKey.create({
      tenantId: 'tenant-expired',
      name: 'Expired Key',
      clientId: 'client-exp',
      keyHash: 'hash-expired',
      prefix: 'ap_',
      createdBy: 'user-1',
      expiresAt: new Date(Date.now() - 10000),
    });

    const result = await resolveApiKey('hash-expired', 'ap_');
    expect(result).toBeNull();
  });

  it('returns null when key hash is not found', async () => {
    const result = await resolveApiKey('nonexistent-hash', 'ap_');
    expect(result).toBeNull();
  });

  it('does not resolve public SDK keys as generic runtime API keys', async () => {
    await PublicApiKey.create({
      projectId: 'proj-sdk-public',
      tenantId: 'tenant-sdk-public',
      keyPrefix: 'pk_public',
      keyHash: 'hash-sdk-public',
      name: 'SDK Public Key',
      isActive: true,
    });

    const result = await resolveApiKey('hash-sdk-public', 'pk_publi');
    expect(result).toBeNull();
  });
});

// #############################################################################
// rbac-repo
// #############################################################################

describe('rbac-repo', () => {
  it('findRoleDefinitions returns roles for a tenant', async () => {
    await RoleDefinition.create({
      tenantId: 'tenant-rbac',
      name: 'Admin',
      permissions: ['*'],
      createdBy: 'system',
    });
    await RoleDefinition.create({
      tenantId: 'tenant-rbac',
      name: 'Viewer',
      permissions: ['read'],
      createdBy: 'system',
    });

    const roles = await findRoleDefinitions('tenant-rbac');

    expect(roles).toHaveLength(2);
    expect(roles.map((r: any) => r.name).sort()).toEqual(['Admin', 'Viewer']);
  });

  it('findRoleDefinitions returns empty for unknown tenant', async () => {
    const roles = await findRoleDefinitions('nonexistent-tenant');
    expect(roles).toEqual([]);
  });

  it('findResourcePermissions returns permissions for a tenant+user', async () => {
    await ResourcePermission.create({
      tenantId: 'tenant-perm',
      userId: 'user-perm',
      resourceType: 'project',
      resourceId: 'proj-1',
      operations: ['read', 'write'],
      grantedBy: 'admin',
    });

    const perms = await findResourcePermissions({ tenantId: 'tenant-perm', userId: 'user-perm' });

    expect(perms).toHaveLength(1);
    expect(perms[0].operations).toEqual(['read', 'write']);
  });
});

// #############################################################################
// channel-repo: Public API Keys
// #############################################################################

describe('channel-repo: Public API Keys', () => {
  it('findPublicApiKey finds by keyHash', async () => {
    await PublicApiKey.create({
      projectId: 'proj-pk',
      keyPrefix: 'pk_',
      keyHash: 'hash-pk-123',
      name: 'Test Public Key',
    });

    const result = await findPublicApiKey({ keyHash: 'hash-pk-123' });
    expect(result).not.toBeNull();
    expect(result.name).toBe('Test Public Key');
  });

  it('findPublicApiKey returns null when not found', async () => {
    const result = await findPublicApiKey({ keyHash: 'nonexistent' });
    expect(result).toBeNull();
  });

  it('findPublicApiKeyForSdk returns key with project info', async () => {
    const project = await Project.create({
      name: 'SDK Project',
      slug: `sdk-proj-${Date.now()}`,
      ownerId: 'owner-1',
      tenantId: 'tenant-sdk',
    });

    await PublicApiKey.create({
      projectId: project._id,
      keyPrefix: 'pk_',
      keyHash: 'hash-sdk-key',
      name: 'SDK Key',
      isActive: true,
    });

    const result = await findPublicApiKeyForSdk('hash-sdk-key');

    expect(result).not.toBeNull();
    expect(result.project).toBeDefined();
    expect(result.project.tenantId).toBe('tenant-sdk');
  });

  it('findPublicApiKeyForSdk returns null for inactive key', async () => {
    await PublicApiKey.create({
      projectId: 'proj-inactive',
      keyPrefix: 'pk_',
      keyHash: 'hash-inactive',
      name: 'Inactive Key',
      isActive: false,
    });

    const result = await findPublicApiKeyForSdk('hash-inactive');
    expect(result).toBeNull();
  });

  it('findPublicApiKeyForSdk returns null for expired key', async () => {
    await PublicApiKey.create({
      projectId: 'proj-expired',
      keyPrefix: 'pk_',
      keyHash: 'hash-exp-key',
      name: 'Expired Key',
      isActive: true,
      expiresAt: new Date(Date.now() - 60000),
    });

    const result = await findPublicApiKeyForSdk('hash-exp-key');
    expect(result).toBeNull();
  });

  it('updatePublicApiKeyLastUsed sets lastUsedAt', async () => {
    const key = await PublicApiKey.create({
      projectId: 'proj-usage',
      keyPrefix: 'pk_',
      keyHash: 'hash-usage',
      name: 'Usage Key',
    });

    await updatePublicApiKeyLastUsed(key._id);

    const updated = await PublicApiKey.findById(key._id).lean();
    expect(updated!.lastUsedAt).toBeDefined();
  });

  it('findActivePublicApiKey returns active non-expired key', async () => {
    await PublicApiKey.create({
      projectId: 'proj-active',
      keyPrefix: 'pk_',
      keyHash: 'hash-active',
      name: 'Active Key',
      isActive: true,
    });

    const result = await findActivePublicApiKey('hash-active', 'proj-active');
    expect(result).not.toBeNull();
  });
});

// #############################################################################
// channel-repo: SDK Channels
// #############################################################################

describe('channel-repo: SDK Channels', () => {
  it('createSDKChannel creates and returns channel with normalized id', async () => {
    const project = await Project.create({
      name: 'Channel Repo Project',
      slug: `channel-repo-project-${Date.now()}`,
      ownerId: 'owner-channel-repo',
      tenantId: 'tenant-ch',
    });

    await PublicApiKey.create({
      _id: 'key-1',
      projectId: project._id,
      tenantId: 'tenant-ch',
      keyPrefix: 'pk_',
      keyHash: 'hash-channel-repo',
      name: 'Channel Repo Key',
      isActive: true,
    });

    const result = await createSDKChannel({
      tenantId: 'tenant-ch',
      projectId: String(project._id),
      name: 'Web Channel',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });

    expect(result).toBeDefined();
    expect(result.id ?? result._id).toBeDefined();
    expect(result.name).toBe('Web Channel');
  });

  it('findSDKChannels returns channels for project and tenant', async () => {
    await SDKChannel.create({
      tenantId: 'tenant-find',
      projectId: 'proj-find',
      name: 'Ch 1',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });
    await SDKChannel.create({
      tenantId: 'tenant-find',
      projectId: 'proj-find',
      name: 'Ch 2',
      channelType: 'sdk',
      publicApiKeyId: 'key-2',
    });

    const result = await findSDKChannels({ projectId: 'proj-find', tenantId: 'tenant-find' });

    expect(result).toHaveLength(2);
  });

  it('findSDKChannelById returns channel with scoped query', async () => {
    const ch = await SDKChannel.create({
      tenantId: 'tenant-byid',
      projectId: 'proj-byid',
      name: 'By ID Channel',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });

    const result = await findSDKChannelById(ch._id, 'proj-byid', 'tenant-byid');
    expect(result).not.toBeNull();
    expect(result.name).toBe('By ID Channel');
  });

  it('findSDKChannelById returns null for wrong tenant', async () => {
    const ch = await SDKChannel.create({
      tenantId: 'tenant-right',
      projectId: 'proj-right',
      name: 'Right Channel',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });

    const result = await findSDKChannelById(ch._id, 'proj-right', 'tenant-wrong');
    expect(result).toBeNull();
  });

  it('findSDKChannelByName finds by tenant, project, and name', async () => {
    await SDKChannel.create({
      tenantId: 'tenant-name',
      projectId: 'proj-name',
      name: 'Named Channel',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });

    const result = await findSDKChannelByName('tenant-name', 'proj-name', 'Named Channel');
    expect(result).not.toBeNull();
  });

  it('updateSDKChannel updates and returns modified channel', async () => {
    const ch = await SDKChannel.create({
      tenantId: 'tenant-update',
      projectId: 'proj-update',
      name: 'Update Me',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });

    const result = await updateSDKChannel(ch._id, 'proj-update', 'tenant-update', {
      name: 'Updated Name',
    });
    expect(result).not.toBeNull();
    expect(result.name).toBe('Updated Name');
  });

  it('deleteSDKChannel removes the channel', async () => {
    const ch = await SDKChannel.create({
      tenantId: 'tenant-del',
      projectId: 'proj-del',
      name: 'Delete Me',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });

    await deleteSDKChannel(ch._id, 'proj-del', 'tenant-del');

    const found = await SDKChannel.findById(ch._id).lean();
    expect(found).toBeNull();
  });
});

// #############################################################################
// channel-repo: Widget Config
// #############################################################################

describe('channel-repo: findWidgetConfig', () => {
  it('returns widget config when found', async () => {
    await WidgetConfig.create({
      tenantId: 'tenant-widget',
      projectId: 'proj-widget',
      mode: 'chat',
      position: 'bottom-right',
      voiceEnabled: false,
      chatEnabled: true,
    });

    const result = await findWidgetConfig('proj-widget', 'tenant-widget');
    expect(result).not.toBeNull();
  });

  it('returns null when not found', async () => {
    const result = await findWidgetConfig('nonexistent-proj', 'tenant-widget');
    expect(result).toBeNull();
  });
});

// #############################################################################
// security-repo: Org Proxy Configs
// #############################################################################

describe('security-repo: Org Proxy Configs', () => {
  it('CRUD operations work correctly', async () => {
    // Create
    const created = await createOrgProxyConfig({
      tenantId: 'tenant-proxy',
      name: 'Corp Proxy',
      proxyUrl: 'https://proxy.corp.com:8080',
      proxyAuthType: 'basic',
      urlPatterns: '*.openai.com',
      environment: 'dev',
      priority: 10,
      createdBy: 'admin-1',
    });
    expect(created).toBeDefined();

    // Find by ID
    const found = await findOrgProxyConfigById(created.id, 'tenant-proxy');
    expect(found).not.toBeNull();
    expect(found.name).toBe('Corp Proxy');

    // List
    const list = await findOrgProxyConfigs({ tenantId: 'tenant-proxy' });
    expect(list).toHaveLength(1);

    // Count
    const count = await countOrgProxyConfigs({ tenantId: 'tenant-proxy' });
    expect(count).toBe(1);

    // Update
    const updated = await updateOrgProxyConfig(created.id, 'tenant-proxy', { priority: 20 });
    expect(updated.priority).toBe(20);

    // Delete
    await deleteOrgProxyConfig(created.id, 'tenant-proxy');
    const deleted = await OrgProxyConfig.findById(created.id).lean();
    expect(deleted).toBeNull();
  });
});

// #############################################################################
// security-repo: End User OAuth Tokens
// #############################################################################

describe('security-repo: End User OAuth Tokens', () => {
  it('findEndUserOAuthTokens returns non-revoked tokens', async () => {
    await EndUserOAuthToken.create({
      tenantId: 'tenant-oauth',
      userId: 'user-oauth',
      provider: 'google',
      providerUserId: 'g-123',
      encryptedAccessToken: 'enc-token',
      scope: 'profile email',
      consentedAt: new Date(),
    });

    const result = await findEndUserOAuthTokens({ tenantId: 'tenant-oauth', userId: 'user-oauth' });
    expect(result).toHaveLength(1);
  });

  it('excludes revoked tokens', async () => {
    await EndUserOAuthToken.create({
      tenantId: 'tenant-oauth2',
      userId: 'user-oauth2',
      provider: 'github',
      providerUserId: 'gh-456',
      encryptedAccessToken: 'enc-token-2',
      scope: 'repo',
      consentedAt: new Date(),
      revokedAt: new Date(),
    });

    const result = await findEndUserOAuthTokens({
      tenantId: 'tenant-oauth2',
      userId: 'user-oauth2',
    });
    expect(result).toHaveLength(0);
  });

  it('countEndUserOAuthTokens returns correct count', async () => {
    await EndUserOAuthToken.create({
      tenantId: 'tenant-ocount',
      userId: 'user-ocount',
      provider: 'google',
      providerUserId: 'g-c1',
      encryptedAccessToken: 'enc-c1',
      scope: 'profile',
      consentedAt: new Date(),
    });

    const count = await countEndUserOAuthTokens({
      tenantId: 'tenant-ocount',
      userId: 'user-ocount',
    });
    expect(count).toBe(1);
  });
});

// #############################################################################
// tenant-model-repo: TenantModel CRUD
// #############################################################################

describe('tenant-model-repo: TenantModel CRUD', () => {
  it('createTenantModel creates and returns with normalized id', async () => {
    const result = await createTenantModel(makeTenantModel());

    expect(result).toBeDefined();
    expect(result.id ?? result._id).toBeDefined();
    expect(result.provider).toBe('openai');
  });

  it('findTenantModel returns model with normalized id', async () => {
    const tm = await TenantModel.create(makeTenantModel());

    const result = await findTenantModel(tm._id, tm.tenantId);

    expect(result).not.toBeNull();
    expect(result.id ?? result._id).toBe(tm._id);
  });

  it('findTenantModel returns null when not found', async () => {
    const result = await findTenantModel('nonexistent-tm', 'tenant-missing');
    expect(result).toBeNull();
  });

  it('findTenantModelAdmin returns model for explicit admin lookups', async () => {
    const tm = await TenantModel.create(makeTenantModel());

    const result = await findTenantModelAdmin(tm._id);

    expect(result).not.toBeNull();
    expect(result.id ?? result._id).toBe(tm._id);
  });

  it('findTenantModelWithConnections includes _count', async () => {
    const tm = await TenantModel.create(makeTenantModel());

    const result = await findTenantModelWithConnections(tm._id, tm.tenantId);

    expect(result).not.toBeNull();
    expect(result._count).toBeDefined();
    expect(result._count.projectBindings).toBe(0);
  });

  it('findTenantModelWithConnectionsAdmin includes _count for admin lookups', async () => {
    const tm = await TenantModel.create(makeTenantModel());

    const result = await findTenantModelWithConnectionsAdmin(tm._id);

    expect(result).not.toBeNull();
    expect(result._count).toBeDefined();
    expect(result._count.projectBindings).toBe(0);
  });

  it('listTenantModels filters and paginates', async () => {
    await TenantModel.create(makeTenantModel({ tenantId: 'tenant-list-tm', displayName: 'M1' }));
    await TenantModel.create(makeTenantModel({ tenantId: 'tenant-list-tm', displayName: 'M2' }));
    await TenantModel.create(makeTenantModel({ tenantId: 'other-tenant', displayName: 'M3' }));

    const result = await listTenantModels({ tenantId: 'tenant-list-tm' });
    expect(result).toHaveLength(2);
  });

  it('countTenantModels returns correct count', async () => {
    await TenantModel.create(makeTenantModel({ tenantId: 'tenant-count-tm', displayName: 'C1' }));

    const count = await countTenantModels({ tenantId: 'tenant-count-tm' });
    expect(count).toBe(1);
  });

  it('updateTenantModel updates specified fields', async () => {
    const tm = await TenantModel.create(makeTenantModel({ displayName: 'Before Update' }));

    const result = await updateTenantModel(tm._id, { displayName: 'After Update' }, tm.tenantId);

    expect(result).not.toBeNull();
    expect(result.displayName).toBe('After Update');
  });

  it('updateTenantModelAdmin updates specified fields for admin flows', async () => {
    const tm = await TenantModel.create(makeTenantModel({ displayName: 'Before Admin Update' }));

    const result = await updateTenantModelAdmin(tm._id, {
      displayName: 'After Admin Update',
    });

    expect(result).not.toBeNull();
    expect(result.displayName).toBe('After Admin Update');
  });

  it('updateTenantModelInference toggles inferenceEnabled', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-infer',
        displayName: 'InferModel',
        inferenceEnabled: true,
      }),
    );

    await updateTenantModelInference(tm._id, 'tenant-infer', false);

    const updated = await TenantModel.findById(tm._id).lean();
    expect(updated!.inferenceEnabled).toBe(false);
  });
});

// #############################################################################
// tenant-model-repo: Connections
// #############################################################################

describe('tenant-model-repo: TenantModel Connections', () => {
  it('createTenantModelConnection adds a connection to the model', async () => {
    const tm = await TenantModel.create(makeTenantModel({ displayName: 'Conn Model' }));

    const conn = await createTenantModelConnection({
      tenantModelId: tm._id,
      tenantId: tm.tenantId,
      credentialId: 'cred-primary-1',
      isActive: true,
      isPrimary: true,
      createdBy: 'user-1',
    });

    expect(conn).toBeDefined();
    expect(conn.credentialId).toBe('cred-primary-1');
    expect(conn.id).toBeDefined();
  });

  it('findTenantModelConnections returns connections for a model', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        displayName: 'Multi Conn',
        connections: [
          {
            id: 'conn-1',
            credentialId: 'cred-c1',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 'conn-2',
            credentialId: 'cred-c2',
            isActive: true,
            isPrimary: false,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const conns = await findTenantModelConnections(tm._id, { tenantId: tm.tenantId });
    expect(conns).toHaveLength(2);
  });

  it('findTenantModelConnectionById returns connection with parent model id', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        displayName: 'Find Conn',
        connections: [
          {
            id: 'conn-find-1',
            credentialId: 'cred-findable',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const result = await findTenantModelConnectionById('conn-find-1', tm.tenantId);

    expect(result).not.toBeNull();
    expect(result.credentialId).toBe('cred-findable');
    expect(result.tenantModelId).toBe(tm._id);
  });

  it('updateTenantModelConnection updates connection fields', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        displayName: 'Upd Conn',
        connections: [
          {
            id: 'conn-upd-1',
            credentialId: 'cred-before',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const result = await updateTenantModelConnection(
      'conn-upd-1',
      { credentialId: 'cred-after' },
      tm.tenantId,
    );

    expect(result).not.toBeNull();
    expect(result.credentialId).toBe('cred-after');
  });

  it('deleteTenantModelConnection removes the connection', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        displayName: 'Del Conn',
        connections: [
          {
            id: 'conn-del-1',
            credentialId: 'cred-delete-me',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    await deleteTenantModelConnection('conn-del-1', tm.tenantId);

    const updated = await TenantModel.findById(tm._id).lean();
    expect(updated!.connections).toHaveLength(0);
  });

  it('setConnectionPrimary toggles isPrimary correctly', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        displayName: 'Primary Toggle',
        connections: [
          {
            id: 'conn-p1',
            credentialId: 'cred-was-primary',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 'conn-p2',
            credentialId: 'cred-was-secondary',
            isActive: true,
            isPrimary: false,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    await setConnectionPrimary(tm._id, 'conn-p2', tm.tenantId);

    const updated = await TenantModel.findById(tm._id).lean();
    const c1 = updated!.connections.find((c: any) => c.id === 'conn-p1');
    const c2 = updated!.connections.find((c: any) => c.id === 'conn-p2');

    expect(c1!.isPrimary).toBe(false);
    expect(c2!.isPrimary).toBe(true);
  });
});

// #############################################################################
// tenant-model-repo: TenantServiceInstance
// #############################################################################

describe('tenant-model-repo: TenantServiceInstance', () => {
  it('CRUD operations work correctly', async () => {
    // Create
    const created = await createTenantServiceInstance({
      tenantId: 'tenant-si',
      displayName: 'Deepgram Instance',
      serviceType: 'speech_to_text',
      encryptedApiKey: 'enc-si-key',
      createdBy: 'user-1',
    });
    expect(created).toBeDefined();
    expect(created.id ?? created._id).toBeDefined();

    // Find
    const found = await findTenantServiceInstance(created.id ?? created._id, 'tenant-si');
    expect(found).not.toBeNull();
    expect(found.displayName).toBe('Deepgram Instance');

    // List
    const list = await listTenantServiceInstances({ tenantId: 'tenant-si' });
    expect(list).toHaveLength(1);

    // Update
    const updated = await updateTenantServiceInstance(
      created.id ?? created._id,
      {
        displayName: 'Updated Deepgram',
      },
      'tenant-si',
    );
    expect(updated.displayName).toBe('Updated Deepgram');

    // Delete
    await deleteTenantServiceInstance(created.id ?? created._id, 'tenant-si');
    const deleted = await TenantServiceInstance.findById(created.id ?? created._id).lean();
    expect(deleted).toBeNull();
  });
});

// #############################################################################
// tenant-model-repo: findLLMCredential, findTenant
// #############################################################################

describe('tenant-model-repo: lookups', () => {
  it('findLLMCredential rejects missing tenantId', async () => {
    const cred = await LLMCredential.create({
      tenantId: 'tenant-1',
      credentialScope: 'user',
      ownerId: 'user-cred',
      provider: 'openai',
      name: 'My OpenAI Key Missing Scope',
      encryptedApiKey: 'enc-key',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });

    await expect(findLLMCredential(cred._id)).rejects.toThrow('tenantId is required');
  });

  it('findLLMCredential returns credential with normalized id when tenant scope is provided', async () => {
    const cred = await LLMCredential.create({
      tenantId: 'tenant-1',
      credentialScope: 'user',
      ownerId: 'user-cred',
      provider: 'openai',
      name: 'My OpenAI Key',
      encryptedApiKey: 'enc-key',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });

    const result = await findLLMCredential(cred._id, 'tenant-1');
    expect(result).not.toBeNull();
    expect(result.provider).toBe('openai');
  });

  it('findTenant returns tenant with normalized id', async () => {
    const tenant = await Tenant.create({
      name: 'LookUp Tenant',
      slug: `lookup-${Date.now()}`,
      ownerId: 'owner-1',
    });

    const result = await findTenant(tenant._id);
    expect(result).not.toBeNull();
    expect(result.name).toBe('LookUp Tenant');
  });

  it('findProjectsUsingTenantModel ignores colliding ModelConfig rows from other tenants', async () => {
    await Project.create({
      _id: 'proj-impact-shared',
      tenantId: 'tenant-impact-local',
      name: 'Impact Local Project',
      slug: 'impact-local-project',
      ownerId: 'owner-impact-local',
    });
    await ModelConfig.create({
      tenantId: 'tenant-impact-local',
      projectId: 'proj-impact-shared',
      name: 'Local GPT-4o',
      modelId: 'gpt-4o',
      provider: 'openai',
      tenantModelId: 'tm-impact-shared',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'standard',
      isDefault: true,
      priority: 10,
    });
    await ModelConfig.create({
      tenantId: 'tenant-impact-foreign',
      projectId: 'proj-impact-shared',
      name: 'Foreign GPT-4o',
      modelId: 'gpt-4o',
      provider: 'openai',
      tenantModelId: 'tm-impact-shared',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'premium',
      isDefault: true,
      priority: 100,
    });

    const result = await findProjectsUsingTenantModel('tm-impact-shared', 'tenant-impact-local');

    expect(result).toEqual([
      {
        projectId: 'proj-impact-shared',
        projectName: 'Impact Local Project',
        tier: 'standard',
      },
    ]);
  });
});

// #############################################################################
// llm-resolution-repo
// #############################################################################

describe('llm-resolution-repo', () => {
  it('isResolutionDatabaseAvailable returns true', () => {
    expect(isResolutionDatabaseAvailable()).toBe(true);
  });

  it('findAgentModelConfig returns config with serialized operationModels', async () => {
    await AgentModelConfig.create({
      tenantId: 'tenant-amc',
      projectId: 'proj-amc',
      agentName: 'amc_agent',
      defaultModel: 'gpt-4o',
      operationModels: { extraction: 'gpt-4o-mini', routing: 'gpt-4o' },
    });

    const result = await findAgentModelConfigResolution('proj-amc', 'amc_agent');

    expect(result).not.toBeNull();
    expect(result.defaultModel).toBe('gpt-4o');
    expect(typeof result.operationModels).toBe('string');
    expect(JSON.parse(result.operationModels)).toEqual({
      extraction: 'gpt-4o-mini',
      routing: 'gpt-4o',
    });
  });

  it('findAgentModelConfig returns null when not found', async () => {
    const result = await findAgentModelConfigResolution('nonexistent', 'nonexistent');
    expect(result).toBeNull();
  });

  it('findAgentModelConfig fails closed when the project tenant does not match', async () => {
    await Project.create({
      _id: 'proj-amc-tenant-safe',
      tenantId: 'tenant-safe',
      name: 'Tenant Safe Project',
      slug: 'tenant-safe-project',
      ownerId: 'owner-safe',
    });
    await AgentModelConfig.create({
      tenantId: 'tenant-safe',
      projectId: 'proj-amc-tenant-safe',
      agentName: 'amc_agent',
      defaultModel: 'gpt-4o',
      operationModels: { extraction: 'gpt-4o-mini' },
    });

    const sameTenant = await findAgentModelConfigResolution(
      'proj-amc-tenant-safe',
      'amc_agent',
      'tenant-safe',
    );
    const wrongTenant = await findAgentModelConfigResolution(
      'proj-amc-tenant-safe',
      'amc_agent',
      'tenant-other',
    );

    expect(sameTenant).not.toBeNull();
    expect(wrongTenant).toBeNull();
  });

  it('findAgentModelConfigByDslName scopes the ProjectAgent mapping by tenant', async () => {
    await Project.create({
      _id: 'proj-dsl-tenant-safe',
      tenantId: 'tenant-dsl',
      name: 'DSL Tenant Safe Project',
      slug: 'dsl-tenant-safe-project',
      ownerId: 'owner-dsl',
    });
    await ProjectAgent.create({
      projectId: 'proj-dsl-tenant-safe',
      tenantId: 'tenant-dsl',
      name: 'supervisor',
      agentPath: 'proj-dsl-tenant-safe/supervisor',
      description: null,
      dslContent: 'SUPERVISOR: TravelDesk_Supervisor\nGOAL: Route travel requests\n',
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });
    await AgentModelConfig.create({
      tenantId: 'tenant-dsl',
      projectId: 'proj-dsl-tenant-safe',
      agentName: 'supervisor',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: {},
    });

    const sameTenant = await findAgentModelConfigByDslNameResolution(
      'proj-dsl-tenant-safe',
      'TravelDesk_Supervisor',
      'tenant-dsl',
    );
    const wrongTenant = await findAgentModelConfigByDslNameResolution(
      'proj-dsl-tenant-safe',
      'TravelDesk_Supervisor',
      'tenant-other',
    );

    expect(sameTenant?.agentName).toBe('supervisor');
    expect(wrongTenant).toBeNull();
  });

  it('findAgentModelConfigByDslName ignores ProjectAgent mappings with blocking draft errors', async () => {
    await Project.create({
      _id: 'proj-dsl-invalid-draft',
      tenantId: 'tenant-dsl',
      name: 'DSL Invalid Draft Project',
      slug: 'dsl-invalid-draft-project',
      ownerId: 'owner-dsl',
    });
    await ProjectAgent.create({
      projectId: 'proj-dsl-invalid-draft',
      tenantId: 'tenant-dsl',
      name: 'supervisor',
      agentPath: 'proj-dsl-invalid-draft/supervisor',
      description: null,
      dslContent: 'SUPERVISOR: TravelDesk_Supervisor\nGOAL: Route travel requests\n',
      dslValidationStatus: 'error',
      dslDiagnostics: [{ severity: 'error', message: 'Name mismatch' }],
    });
    await AgentModelConfig.create({
      tenantId: 'tenant-dsl',
      projectId: 'proj-dsl-invalid-draft',
      agentName: 'supervisor',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: {},
    });

    const result = await findAgentModelConfigByDslNameResolution(
      'proj-dsl-invalid-draft',
      'TravelDesk_Supervisor',
      'tenant-dsl',
    );

    expect(result).toBeNull();
  });

  it('findAgentModelConfigByDslName ignores unvalidated ProjectAgent mappings', async () => {
    await Project.create({
      _id: 'proj-dsl-unvalidated-draft',
      tenantId: 'tenant-dsl',
      name: 'DSL Unvalidated Draft Project',
      slug: 'dsl-unvalidated-draft-project',
      ownerId: 'owner-dsl',
    });
    await ProjectAgent.create({
      projectId: 'proj-dsl-unvalidated-draft',
      tenantId: 'tenant-dsl',
      name: 'supervisor',
      agentPath: 'proj-dsl-unvalidated-draft/supervisor',
      description: null,
      dslContent: 'SUPERVISOR: TravelDesk_Supervisor\nGOAL: Route travel requests\n',
      dslValidationStatus: null,
      dslDiagnostics: [],
    });
    await AgentModelConfig.create({
      tenantId: 'tenant-dsl',
      projectId: 'proj-dsl-unvalidated-draft',
      agentName: 'supervisor',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: {},
    });

    const result = await findAgentModelConfigByDslNameResolution(
      'proj-dsl-unvalidated-draft',
      'TravelDesk_Supervisor',
      'tenant-dsl',
    );

    expect(result).toBeNull();
  });

  it('findProjectOperationTierOverrides prefers tenant-scoped ProjectLLMConfig', async () => {
    await ProjectRuntimeConfig.create({
      tenantId: 'tenant-routing',
      projectId: 'proj-routing',
      operationTierOverrides: { response_gen: 'fast' },
    });
    await ProjectLLMConfig.create({
      tenantId: 'tenant-routing',
      projectId: 'proj-routing',
      operationTierOverrides: { response_gen: 'powerful' },
    });
    await ProjectLLMConfig.create({
      tenantId: 'tenant-other',
      projectId: 'proj-routing',
      operationTierOverrides: { response_gen: 'balanced' },
    });

    const result = await findProjectOperationTierOverrides('tenant-routing', 'proj-routing');

    expect(plainOverrides(result)).toEqual({ response_gen: 'powerful' });
  });

  it('findProjectOperationTierOverrides rejects invalid canonical ProjectLLMConfig overrides', async () => {
    await ProjectRuntimeConfig.create({
      tenantId: 'tenant-invalid-routing',
      projectId: 'proj-invalid-routing',
      operationTierOverrides: { response_gen: 'balanced' },
    });
    await ProjectLLMConfig.create({
      tenantId: 'tenant-invalid-routing',
      projectId: 'proj-invalid-routing',
      operationTierOverrides: { response_gen: 'voice' },
    });

    const result = await findProjectOperationTierOverrides(
      'tenant-invalid-routing',
      'proj-invalid-routing',
    );

    expect(result).toBeNull();
  });

  it('findProjectOperationTierOverrides falls back to ProjectRuntimeConfig compatibility data', async () => {
    await ProjectRuntimeConfig.create({
      tenantId: 'tenant-runtime-fallback',
      projectId: 'proj-runtime-fallback',
      operationTierOverrides: { reasoning: 'powerful' },
    });

    const result = await findProjectOperationTierOverrides(
      'tenant-runtime-fallback',
      'proj-runtime-fallback',
    );

    expect(plainOverrides(result)).toEqual({ reasoning: 'powerful' });
  });

  it('findProjectOperationTierOverrides does not read a colliding project id from another tenant', async () => {
    await ProjectLLMConfig.create({
      tenantId: 'tenant-foreign',
      projectId: 'proj-shared-id',
      operationTierOverrides: { response_gen: 'powerful' },
    });

    const result = await findProjectOperationTierOverrides('tenant-local', 'proj-shared-id');

    expect(result).toBeNull();
  });

  it('findModelConfigForTier returns default config for tier', async () => {
    await Project.create({
      _id: 'proj-mc-tier',
      tenantId: 'tenant-tier',
      name: 'Tier Project',
      slug: 'tier-project',
      ownerId: 'owner-tier',
    });
    await ModelConfig.create({
      tenantId: 'tenant-tier',
      projectId: 'proj-mc-tier',
      name: 'GPT-4o Tier',
      modelId: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'standard',
      isDefault: true,
      priority: 10,
    });

    const result = await findModelConfigForTier('proj-mc-tier', 'standard', 'tenant-tier');
    expect(result).not.toBeNull();
    expect(result.modelId).toBe('gpt-4o');
  });

  it('project model config lookups fail closed when the project tenant does not match', async () => {
    await Project.create({
      _id: 'proj-mc-tenant-safe',
      tenantId: 'tenant-model-safe',
      name: 'Model Tenant Safe Project',
      slug: 'model-tenant-safe-project',
      ownerId: 'owner-model-safe',
    });
    await ModelConfig.create({
      tenantId: 'tenant-model-safe',
      projectId: 'proj-mc-tenant-safe',
      name: 'GPT-4o Tenant Safe',
      modelId: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'standard',
      isDefault: true,
      priority: 10,
    });

    await expect(
      findModelConfigByModelIdResolution('proj-mc-tenant-safe', 'gpt-4o', 'tenant-model-safe'),
    ).resolves.toMatchObject({ modelId: 'gpt-4o' });
    await expect(
      findModelConfigByModelIdResolution('proj-mc-tenant-safe', 'gpt-4o', 'tenant-other'),
    ).resolves.toBeNull();
    await expect(
      findModelConfigForTier('proj-mc-tenant-safe', 'standard', 'tenant-other'),
    ).resolves.toBeNull();
    await expect(findAnyModelConfig('proj-mc-tenant-safe', 'tenant-other')).resolves.toBeNull();
  });

  it('findModelConfigByModelId deterministically orders duplicate model ids', async () => {
    await Project.create({
      _id: 'proj-mc-duplicate-model-id',
      tenantId: 'tenant-model-duplicate',
      name: 'Duplicate Model ID Project',
      slug: 'duplicate-model-id-project',
      ownerId: 'owner-model-duplicate',
    });

    await ModelConfig.collection.insertMany([
      {
        _id: 'mc-duplicate-non-default-high-priority',
        tenantId: 'tenant-model-duplicate',
        projectId: 'proj-mc-duplicate-model-id',
        name: 'Non Default High Priority',
        modelId: 'gpt-4.1',
        provider: 'openai',
        tier: 'standard',
        isDefault: false,
        priority: 100,
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      },
      {
        _id: 'mc-duplicate-default-a',
        tenantId: 'tenant-model-duplicate',
        projectId: 'proj-mc-duplicate-model-id',
        name: 'Default Tie A',
        modelId: 'gpt-4.1',
        provider: 'azure',
        tier: 'standard',
        isDefault: true,
        priority: 20,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        _id: 'mc-duplicate-default-b',
        tenantId: 'tenant-model-duplicate',
        projectId: 'proj-mc-duplicate-model-id',
        name: 'Default Tie B',
        modelId: 'gpt-4.1',
        provider: 'azure',
        tier: 'standard',
        isDefault: true,
        priority: 20,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await findModelConfigByModelIdResolution(
      'proj-mc-duplicate-model-id',
      'gpt-4.1',
      'tenant-model-duplicate',
    );

    expect(result).toMatchObject({
      _id: 'mc-duplicate-default-a',
      id: 'mc-duplicate-default-a',
      modelId: 'gpt-4.1',
      isDefault: true,
      priority: 20,
    });
  });

  it('project model config lookups ignore colliding rows from another tenant', async () => {
    await Project.create({
      _id: 'proj-mc-colliding-row',
      tenantId: 'tenant-model-local',
      name: 'Model Colliding Row Project',
      slug: 'model-colliding-row-project',
      ownerId: 'owner-model-local',
    });
    await ModelConfig.create({
      tenantId: 'tenant-model-foreign',
      projectId: 'proj-mc-colliding-row',
      name: 'Foreign GPT-4o',
      modelId: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'standard',
      isDefault: true,
      priority: 100,
    });

    await expect(
      findModelConfigByModelIdResolution('proj-mc-colliding-row', 'gpt-4o', 'tenant-model-local'),
    ).resolves.toBeNull();
    await expect(
      findModelConfigForTier('proj-mc-colliding-row', 'standard', 'tenant-model-local'),
    ).resolves.toBeNull();
    await expect(
      findAnyModelConfig('proj-mc-colliding-row', 'tenant-model-local'),
    ).resolves.toBeNull();
  });

  it('project model config lookups ignore tenant-less legacy rows after tenant backfill', async () => {
    await Project.create({
      _id: 'proj-mc-legacy-row',
      tenantId: 'tenant-model-legacy',
      name: 'Model Legacy Row Project',
      slug: 'model-legacy-row-project',
      ownerId: 'owner-model-legacy',
    });
    await ModelConfig.collection.insertOne({
      _id: 'legacy-model-config',
      projectId: 'proj-mc-legacy-row',
      name: 'Legacy GPT-4o',
      modelId: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'standard',
      isDefault: true,
      priority: 10,
    });

    await expect(
      findModelConfigByModelIdResolution('proj-mc-legacy-row', 'gpt-4o', 'tenant-model-legacy'),
    ).resolves.toBeNull();
    await expect(
      findModelConfigForTier('proj-mc-legacy-row', 'standard', 'tenant-model-legacy'),
    ).resolves.toBeNull();
    await expect(
      findAnyModelConfig('proj-mc-legacy-row', 'tenant-model-legacy'),
    ).resolves.toBeNull();
    await expect(
      findModelConfigByModelIdResolution('proj-mc-legacy-row', 'gpt-4o', 'tenant-other'),
    ).resolves.toBeNull();
  });

  it('findModelConfigForTier falls back within the requested tier only', async () => {
    await ModelConfig.create({
      tenantId: 'tenant-tier-fallback',
      projectId: 'proj-mc-tier-fallback',
      name: 'Balanced Default',
      modelId: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'balanced',
      isDefault: true,
      priority: 100,
    });

    await ModelConfig.create({
      tenantId: 'tenant-tier-fallback',
      projectId: 'proj-mc-tier-fallback',
      name: 'Voice Candidate',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      contextWindow: 128000,
      tier: 'voice',
      isDefault: false,
      priority: 10,
    });

    const result = await findModelConfigForTier('proj-mc-tier-fallback', 'voice');
    expect(result).not.toBeNull();
    expect(result.modelId).toBe('gpt-4o-realtime-preview-2025-06-03');
  });

  it('findAnyModelConfig returns any config for project', async () => {
    await ModelConfig.create({
      tenantId: 'tenant-any-mc',
      projectId: 'proj-any-mc',
      name: 'Any Config',
      modelId: 'claude-3',
      provider: 'anthropic',
      temperature: 0.5,
      maxTokens: 2048,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      contextWindow: 200000,
      tier: 'premium',
      isDefault: false,
      priority: 5,
    });

    const result = await findAnyModelConfig('proj-any-mc');
    expect(result).not.toBeNull();
    expect(result.provider).toBe('anthropic');
  });

  it('findTenantModelByIdWithPrimaryConnection filters to primary connections', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        displayName: 'Primary Filter',
        connections: [
          {
            id: 'pf-1',
            credentialId: 'cred-pf-primary',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 'pf-2',
            credentialId: 'cred-pf-secondary',
            isActive: true,
            isPrimary: false,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const result = await findTenantModelByIdWithPrimaryConnection(tm._id, tm.tenantId);

    expect(result).not.toBeNull();
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].isPrimary).toBe(true);
  });

  it('findDefaultTenantModelForTier finds default model', async () => {
    await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-tier',
        displayName: 'Default Std',
        tier: 'standard',
        isDefault: true,
        isActive: true,
        inferenceEnabled: true,
      }),
    );

    const result = await findDefaultTenantModelForTier('tenant-tier', 'standard');
    expect(result).not.toBeNull();
    expect(result.tier).toBe('standard');
  });

  it('findDefaultTenantModelForTier falls back to non-default active model', async () => {
    await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-fallback',
        displayName: 'Fallback Model',
        tier: 'premium',
        isDefault: false,
        isActive: true,
        inferenceEnabled: true,
      }),
    );

    const result = await findDefaultTenantModelForTier('tenant-fallback', 'premium');
    expect(result).not.toBeNull();
  });

  it('findTenantModelByProvider finds model by provider', async () => {
    await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-prov',
        displayName: 'Anthropic Model',
        provider: 'anthropic',
      }),
    );

    const result = await findTenantModelByProvider('tenant-prov', 'anthropic');
    expect(result).not.toBeNull();
    expect(result.provider).toBe('anthropic');
  });

  it('findTenantModelByProvider treats google and gemini as credential aliases', async () => {
    await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-gemini-alias',
        displayName: 'Legacy Gemini Model',
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
      }),
    );

    const result = await findTenantModelByProvider('tenant-gemini-alias', 'google');
    expect(result).not.toBeNull();
    expect(result.provider).toBe('gemini');
  });

  it('findDefaultTenantModelForVoice finds voice-capable model', async () => {
    await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-voice',
        displayName: 'Voice Model',
        capabilities: ['text', 'realtime_voice'],
        isDefault: true,
      }),
    );

    const result = await findDefaultTenantModelForVoice('tenant-voice');
    expect(result).not.toBeNull();
    expect(result.capabilities).toContain('realtime_voice');
  });

  it('findDefaultTenantModelForVoice returns null when no voice model', async () => {
    await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-no-voice',
        displayName: 'Text Only',
        capabilities: ['text'],
      }),
    );

    const result = await findDefaultTenantModelForVoice('tenant-no-voice');
    expect(result).toBeNull();
  });

  it('findTenantLLMPolicy returns policy with native allowedProviders array', async () => {
    await TenantLLMPolicy.create({
      tenantId: 'tenant-policy',
      allowedProviders: ['openai', 'anthropic'],
      credentialPolicy: 'tenant_managed',
      monthlyTokenBudget: 1000000,
      dailyTokenBudget: 50000,
      maxRequestsPerMinute: 60,
      allowProjectCredentials: false,
      platformDemoEnabled: false,
    });

    const result = await findTenantLLMPolicy('tenant-policy');

    expect(result).not.toBeNull();
    expect(Array.isArray(result.allowedProviders)).toBe(true);
    expect(result.allowedProviders).toEqual(['openai', 'anthropic']);
  });

  it('findTenantLLMPolicy returns null when not found', async () => {
    const result = await findTenantLLMPolicy('nonexistent-tenant');
    expect(result).toBeNull();
  });

  it('findDefaultUserCredential finds active default credential', async () => {
    await LLMCredential.create({
      tenantId: 'tenant-1',
      credentialScope: 'user',
      ownerId: 'user-def-cred',
      provider: 'openai',
      name: 'Default OpenAI',
      encryptedApiKey: 'enc-key',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });

    const result = await findDefaultUserCredential('user-def-cred', 'openai');
    expect(result).not.toBeNull();
    expect(result.name).toBe('Default OpenAI');
  });

  it('findDefaultUserCredential treats google and gemini as provider aliases', async () => {
    await LLMCredential.create({
      tenantId: 'tenant-user-alias',
      credentialScope: 'user',
      ownerId: 'user-gemini-cred',
      provider: 'gemini',
      name: 'User Gemini',
      encryptedApiKey: 'enc-key-gemini',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });

    const result = await findDefaultUserCredential('user-gemini-cred', 'google');
    expect(result).not.toBeNull();
    expect(result.name).toBe('User Gemini');
  });

  it('findDefaultTenantCredential finds active default tenant credential', async () => {
    await LLMCredential.create({
      tenantId: 'tenant-tc',
      credentialScope: 'tenant',
      ownerId: 'tenant-tc',
      provider: 'anthropic',
      name: 'Tenant Anthropic',
      encryptedApiKey: 'enc-key-tc',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });

    const result = await findDefaultTenantCredential('tenant-tc', 'anthropic');
    expect(result).not.toBeNull();
    expect(result.name).toBe('Tenant Anthropic');
  });

  it('findDefaultTenantCredential treats google and gemini as provider aliases', async () => {
    await LLMCredential.create({
      tenantId: 'tenant-tc-alias',
      credentialScope: 'tenant',
      ownerId: 'tenant-tc-alias',
      provider: 'gemini',
      name: 'Tenant Gemini',
      encryptedApiKey: 'enc-key-tc-gemini',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });

    const result = await findDefaultTenantCredential('tenant-tc-alias', 'google');
    expect(result).not.toBeNull();
    expect(result.name).toBe('Tenant Gemini');
  });
});

// #############################################################################
// tenant-model-repo: tenant isolation
// #############################################################################

describe('tenant-model-repo: tenant isolation', () => {
  it('findTenantModel returns null when tenantId does not match', async () => {
    const tm = await TenantModel.create(makeTenantModel({ tenantId: 'tenant-A' }));
    const result = await findTenantModel(tm._id, 'tenant-B');
    expect(result).toBeNull();
  });

  it('findTenantModel returns model when tenantId matches', async () => {
    const tm = await TenantModel.create(makeTenantModel({ tenantId: 'tenant-match' }));
    const result = await findTenantModel(tm._id, 'tenant-match');
    expect(result).not.toBeNull();
  });

  it('findTenantModelWithConnections returns null for wrong tenant', async () => {
    const tm = await TenantModel.create(makeTenantModel({ tenantId: 'tenant-A' }));
    const result = await findTenantModelWithConnections(tm._id, 'tenant-B');
    expect(result).toBeNull();
  });

  it('updateTenantModel returns null for wrong tenant', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({ tenantId: 'tenant-A', displayName: 'Original' }),
    );
    const result = await updateTenantModel(tm._id, { displayName: 'Hacked' }, 'tenant-B');
    expect(result).toBeNull();

    // Verify original is unchanged
    const original = await TenantModel.findById(tm._id).lean();
    expect(original!.displayName).toBe('Original');
  });

  it('findTenantServiceInstance returns null for wrong tenant', async () => {
    const si = await createTenantServiceInstance({
      tenantId: 'tenant-A',
      displayName: 'Service',
      serviceType: 'speech_to_text',
      encryptedApiKey: 'enc-key',
      createdBy: 'user-1',
    });
    const result = await findTenantServiceInstance(si.id ?? si._id, 'tenant-B');
    expect(result).toBeNull();
  });
});

// #############################################################################
// security-repo: tenant isolation
// #############################################################################

describe('security-repo: tenant isolation', () => {
  it('findOrgProxyConfigById returns null for wrong tenant', async () => {
    const config = await createOrgProxyConfig({
      tenantId: 'tenant-A',
      name: 'Proxy',
      proxyUrl: 'https://proxy.example.com',
      proxyAuthType: 'none',
      urlPatterns: '*',
      environment: 'dev',
      priority: 1,
      createdBy: 'admin-1',
    });
    const result = await findOrgProxyConfigById(config._id, 'tenant-B');
    expect(result).toBeNull();
  });
});

// #############################################################################
// llm-resolution-repo: tenant isolation
// #############################################################################

describe('llm-resolution-repo: tenant isolation', () => {
  it('findCredentialById restricts user-scoped credentials to the caller while still allowing tenant credentials', async () => {
    const ownCredential = await LLMCredential.create({
      tenantId: 'tenant-actor-scope',
      credentialScope: 'user',
      ownerId: 'user-1',
      provider: 'openai',
      name: 'Own Actor Credential',
      encryptedApiKey: 'enc-key',
      authType: 'api_key',
      isActive: true,
      isDefault: true,
    });
    const foreignCredential = await LLMCredential.create({
      tenantId: 'tenant-actor-scope',
      credentialScope: 'user',
      ownerId: 'user-2',
      provider: 'openai',
      name: 'Foreign Actor Credential',
      encryptedApiKey: 'enc-key',
      authType: 'api_key',
      isActive: true,
      isDefault: false,
    });
    const tenantCredential = await LLMCredential.create({
      tenantId: 'tenant-actor-scope',
      credentialScope: 'tenant',
      ownerId: 'tenant-actor-scope',
      provider: 'openai',
      name: 'Tenant Shared Credential',
      encryptedApiKey: 'enc-key',
      authType: 'api_key',
      isActive: true,
      isDefault: false,
    });

    const ownResult = await findCredentialByIdResolution(ownCredential._id, 'tenant-actor-scope', {
      actorUserId: 'user-1',
    });
    const tenantResult = await findCredentialByIdResolution(
      tenantCredential._id,
      'tenant-actor-scope',
      { actorUserId: 'user-1' },
    );
    const foreignResult = await findCredentialByIdResolution(
      foreignCredential._id,
      'tenant-actor-scope',
      { actorUserId: 'user-1' },
    );

    expect(ownResult).not.toBeNull();
    expect(tenantResult).not.toBeNull();
    expect(foreignResult).toBeNull();
  });

  it('findTenantModelByIdWithPrimaryConnection returns null for wrong tenant', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-A',
        displayName: 'Isolated Model',
        connections: [
          {
            id: 'iso-conn',
            connectionName: 'Primary',
            authType: 'api_key',
            credentialId: 'cred-iso',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const result = await findTenantModelByIdWithPrimaryConnection(tm._id, 'tenant-B');
    expect(result).toBeNull();
  });

  it('findTenantModelByIdWithPrimaryConnection returns model for correct tenant', async () => {
    const tm = await TenantModel.create(
      makeTenantModel({
        tenantId: 'tenant-correct-llm',
        displayName: 'Correct Model',
        connections: [
          {
            id: 'correct-conn',
            connectionName: 'Primary',
            authType: 'api_key',
            credentialId: 'cred-correct',
            isActive: true,
            isPrimary: true,
            createdBy: 'user-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const result = await findTenantModelByIdWithPrimaryConnection(tm._id, 'tenant-correct-llm');
    expect(result).not.toBeNull();
    expect(result.connections).toHaveLength(1);
  });
});

// ─── Deployment Repo ──────────────────────────────────────────────────────────

describe('retirePreviousActiveDeployment', () => {
  let Deployment: any;
  let retirePreviousActiveDeployment: any;

  beforeAll(async () => {
    const models = await import('@agent-platform/database/models');
    Deployment = models.Deployment;
    const deploymentRepo = await import('../../repos/deployment-repo.js');
    retirePreviousActiveDeployment = deploymentRepo.retirePreviousActiveDeployment;
  });

  it('retires existing active deployment and returns it', async () => {
    // Create an active deployment
    await Deployment.create({
      projectId: 'proj-retire',
      tenantId: 'tenant-retire',
      environment: 'production',
      entryAgentName: 'booking_agent',
      endpointSlug: 'proj-retire-prod-1',
      createdBy: 'user-1',
      status: 'active',
    });

    const retired = await retirePreviousActiveDeployment(
      'proj-retire',
      'tenant-retire',
      'production',
    );

    expect(retired).not.toBeNull();
    expect(retired.status).toBe('active'); // returns pre-update document
    expect(retired.projectId).toBe('proj-retire');

    // Verify the document is now retired in DB
    const updated = await Deployment.findOne({ projectId: 'proj-retire' }).lean();
    expect(updated.status).toBe('retired');
    expect(updated.retiredAt).toBeInstanceOf(Date);
  });

  it('returns null when no active deployment exists', async () => {
    // Create a retired deployment (not active)
    await Deployment.create({
      projectId: 'proj-noactive',
      tenantId: 'tenant-noactive',
      environment: 'staging',
      entryAgentName: 'booking_agent',
      endpointSlug: 'proj-noactive-stg',
      createdBy: 'user-1',
      status: 'retired',
      retiredAt: new Date(),
    });

    const result = await retirePreviousActiveDeployment(
      'proj-noactive',
      'tenant-noactive',
      'staging',
    );

    expect(result).toBeNull();
  });
});
