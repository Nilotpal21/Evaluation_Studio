import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { User } from '../models/user.model.js';
import { ApiKey } from '../models/api-key.model.js';
import { Organization } from '../models/organization.model.js';
import { OrgMember } from '../models/org-member.model.js';
import { Tenant } from '../models/tenant.model.js';
import { TenantMember } from '../models/tenant-member.model.js';
import { RoleDefinition } from '../models/role-definition.model.js';
import { ResourcePermission } from '../models/resource-permission.model.js';
import { ResourceType } from '../models/resource-type.model.js';
import { ResourceGroup } from '../models/resource-group.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── User Model ──────────────────────────────────────────────────────────────

describe('User', () => {
  const validUser = () => ({
    email: 'test@example.com',
    authProvider: 'google',
  });

  // Schema validation — no DB needed
  it('validates a valid user without errors', () => {
    const doc = new User(validUser());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new User(validUser());
    expect(doc._id).toBeDefined();
    expect(typeof doc._id).toBe('string');
    expect(doc._id.length).toBeGreaterThan(0);
    expect(doc.email).toBe('test@example.com');
    expect(doc.authProvider).toBe('google');
    expect(doc.name).toBeNull();
    expect(doc.avatarUrl).toBeNull();
    expect(doc.googleId).toBeNull();
    expect(doc.passwordHash).toBeNull();
    expect(doc.emailVerified).toBe(false);
    expect(doc.lastLoginAt).toBeNull();
    expect(doc.lastActiveTenantId).toBeNull();
    expect(doc.mfa).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('requires email', () => {
    const doc = new User({ authProvider: 'google' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.email).toBeDefined();
  });

  it('requires authProvider', () => {
    const doc = new User({ email: 'test@example.com' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authProvider).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique email index', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await User.create(validUser());
    await expect(User.create(validUser())).rejects.toThrow(/duplicate key/i);
  });

  it('sets timestamps on creation', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const user = await User.create(validUser());
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });
});

// ─── ApiKey Model ────────────────────────────────────────────────────────────

describe('ApiKey', () => {
  const validApiKey = () => ({
    tenantId: 'tenant-1',
    name: 'My API Key',
    clientId: 'client-1',
    keyHash: 'hash-abc-123',
    prefix: 'ak_',
    createdBy: 'user-1',
  });

  // Schema validation — no DB needed
  it('validates a valid api key without errors', () => {
    const doc = new ApiKey(validApiKey());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new ApiKey(validApiKey());
    expect(doc._id).toBeDefined();
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.name).toBe('My API Key');
    expect(doc.scopes).toEqual([]);
    expect(doc.projectIds).toEqual([]);
    expect(doc.environments).toEqual([]);
    expect(doc.expiresAt).toBeNull();
    expect(doc.lastUsedAt).toBeNull();
    expect(doc.revokedAt).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validApiKey();
    delete (data as any).tenantId;
    const err = new ApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires name', () => {
    const data = validApiKey();
    delete (data as any).name;
    const err = new ApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires clientId', () => {
    const data = validApiKey();
    delete (data as any).clientId;
    const err = new ApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.clientId).toBeDefined();
  });

  it('requires keyHash', () => {
    const data = validApiKey();
    delete (data as any).keyHash;
    const err = new ApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.keyHash).toBeDefined();
  });

  it('requires prefix', () => {
    const data = validApiKey();
    delete (data as any).prefix;
    const err = new ApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.prefix).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validApiKey();
    delete (data as any).createdBy;
    const err = new ApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique keyHash', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ApiKey.create(validApiKey());
    await expect(ApiKey.create(validApiKey())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── Organization Model ─────────────────────────────────────────────────────

describe('Organization', () => {
  const validOrg = () => ({
    name: 'Acme Corp',
    slug: 'acme-corp',
    ownerId: 'user-1',
  });

  // Schema validation — no DB needed
  it('validates a valid organization without errors', () => {
    const doc = new Organization(validOrg());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new Organization(validOrg());
    expect(doc._id).toBeDefined();
    expect(doc.name).toBe('Acme Corp');
    expect(doc.slug).toBe('acme-corp');
    expect(doc.ownerId).toBe('user-1');
    expect(doc.billingEmail).toBeNull();
    expect(doc.billingConfig).toBeNull();
    expect(doc.settings).toBeNull();
    expect(doc.ssoConfigs).toEqual([]);
    expect(doc.domainMappings).toEqual([]);
    expect(doc._v).toBe(1);
  });

  it('requires name', () => {
    const doc = new Organization({ slug: 'x', ownerId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires slug', () => {
    const doc = new Organization({ name: 'X', ownerId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.slug).toBeDefined();
  });

  it('requires ownerId', () => {
    const doc = new Organization({ name: 'X', slug: 'x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.ownerId).toBeDefined();
  });

  it('stores ssoConfigs with enum validation', () => {
    const doc = new Organization({
      ...validOrg(),
      ssoConfigs: [
        {
          id: 'sso-1',
          protocol: 'saml',
          encryptedConfig: 'enc-data',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.ssoConfigs).toHaveLength(1);
    expect(doc.ssoConfigs[0].protocol).toBe('saml');
  });

  it('rejects invalid SSO protocol', () => {
    const doc = new Organization({
      ...validOrg(),
      slug: 'unique-slug-sso',
      ssoConfigs: [
        {
          id: 'sso-1',
          protocol: 'invalid',
          encryptedConfig: 'enc-data',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['ssoConfigs.0.protocol']).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique slug', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Organization.create(validOrg());
    await expect(Organization.create(validOrg())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── OrgMember Model ────────────────────────────────────────────────────────

describe('OrgMember', () => {
  const validMember = () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'ORG_MEMBER',
  });

  // Schema validation — no DB needed
  it('validates a valid org member without errors', () => {
    const doc = new OrgMember(validMember());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new OrgMember(validMember());
    expect(doc.organizationId).toBe('org-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.role).toBe('ORG_MEMBER');
    expect(doc._v).toBe(1);
  });

  it('requires organizationId', () => {
    const doc = new OrgMember({ userId: 'u', role: 'ORG_MEMBER' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.organizationId).toBeDefined();
  });

  it('requires userId', () => {
    const doc = new OrgMember({ organizationId: 'o', role: 'ORG_MEMBER' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires role', () => {
    const doc = new OrgMember({ organizationId: 'o', userId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  it('validates role enum', () => {
    const doc = new OrgMember({
      ...validMember(),
      role: 'INVALID_ROLE',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  it('accepts valid role values', () => {
    const roles = ['ORG_OWNER', 'ORG_ADMIN', 'ORG_MEMBER', 'ORG_BILLING'];
    for (const role of roles) {
      const doc = new OrgMember({ ...validMember(), role });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.role).toBe(role);
    }
  });

  // DB-dependent tests
  it('enforces unique organizationId+userId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await OrgMember.create(validMember());
    await expect(OrgMember.create(validMember())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── Tenant Model ───────────────────────────────────────────────────────────

describe('Tenant', () => {
  const validTenant = () => ({
    name: 'My Workspace',
    slug: 'my-workspace',
    ownerId: 'user-1',
  });

  // Schema validation — no DB needed
  it('validates a valid tenant without errors', () => {
    const doc = new Tenant(validTenant());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new Tenant(validTenant());
    expect(doc.name).toBe('My Workspace');
    expect(doc.slug).toBe('my-workspace');
    expect(doc.ownerId).toBe('user-1');
    expect(doc.organizationId).toBeNull();
    expect(doc.retentionDays).toBe(7);
    expect(doc.settings).toBeNull();
    expect(doc.status).toBe('active');
    expect(doc.llmPolicy).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('requires name', () => {
    const doc = new Tenant({ slug: 'x', ownerId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires slug', () => {
    const doc = new Tenant({ name: 'X', ownerId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.slug).toBeDefined();
  });

  it('requires ownerId', () => {
    const doc = new Tenant({ name: 'X', slug: 'x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.ownerId).toBeDefined();
  });

  it('validates status enum', () => {
    const doc = new Tenant({
      ...validTenant(),
      status: 'invalid',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['active', 'suspended', 'archived', 'transferring'];
    for (const status of statuses) {
      const doc = new Tenant({ ...validTenant(), status });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.status).toBe(status);
    }
  });

  // DB-dependent tests
  it('enforces unique slug', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await Tenant.create(validTenant());
    await expect(Tenant.create(validTenant())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── TenantMember Model ─────────────────────────────────────────────────────

describe('TenantMember', () => {
  const validMember = () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'admin',
  });

  // Schema validation — no DB needed
  it('validates a valid tenant member without errors', () => {
    const doc = new TenantMember(validMember());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new TenantMember(validMember());
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.role).toBe('admin');
    expect(doc.customRoleId).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('requires tenantId', () => {
    const doc = new TenantMember({ userId: 'u', role: 'admin' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires userId', () => {
    const doc = new TenantMember({ tenantId: 't', role: 'admin' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires role', () => {
    const doc = new TenantMember({ tenantId: 't', userId: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique tenantId+userId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await TenantMember.create(validMember());
    await expect(TenantMember.create(validMember())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── RoleDefinition Model ───────────────────────────────────────────────────

describe('RoleDefinition', () => {
  const validRole = () => ({
    tenantId: 'tenant-1',
    name: 'Editor',
    createdBy: 'user-1',
  });

  // Schema validation — no DB needed
  it('validates a valid role definition without errors', () => {
    const doc = new RoleDefinition(validRole());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new RoleDefinition(validRole());
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.name).toBe('Editor');
    expect(doc.description).toBeNull();
    expect(doc.isSystem).toBe(false);
    expect(doc.permissions).toEqual([]);
    expect(doc.parentRoleId).toBeNull();
    expect(doc.createdBy).toBe('user-1');
    expect(doc._v).toBe(1);
  });

  it('requires tenantId', () => {
    const doc = new RoleDefinition({ name: 'X', createdBy: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires name', () => {
    const doc = new RoleDefinition({ tenantId: 't', createdBy: 'u' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires createdBy', () => {
    const doc = new RoleDefinition({ tenantId: 't', name: 'X' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique tenantId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await RoleDefinition.create(validRole());
    await expect(RoleDefinition.create(validRole())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ResourcePermission Model ───────────────────────────────────────────────

describe('ResourcePermission', () => {
  const validPerm = () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    resourceType: 'project',
    resourceId: 'proj-1',
    grantedBy: 'admin-1',
  });

  // Schema validation — no DB needed
  it('validates a valid resource permission without errors', () => {
    const doc = new ResourcePermission(validPerm());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new ResourcePermission(validPerm());
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.resourceType).toBe('project');
    expect(doc.resourceId).toBe('proj-1');
    expect(doc.operations).toEqual([]);
    expect(doc.grantedBy).toBe('admin-1');
    expect(doc.expiresAt).toBeNull();
    expect(doc._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validPerm();
    delete (data as any).tenantId;
    const err = new ResourcePermission(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires userId', () => {
    const data = validPerm();
    delete (data as any).userId;
    const err = new ResourcePermission(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires resourceType', () => {
    const data = validPerm();
    delete (data as any).resourceType;
    const err = new ResourcePermission(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.resourceType).toBeDefined();
  });

  it('requires resourceId', () => {
    const data = validPerm();
    delete (data as any).resourceId;
    const err = new ResourcePermission(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.resourceId).toBeDefined();
  });

  it('requires grantedBy', () => {
    const data = validPerm();
    delete (data as any).grantedBy;
    const err = new ResourcePermission(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.grantedBy).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique compound index', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ResourcePermission.create(validPerm());
    await expect(ResourcePermission.create(validPerm())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ResourceType Model ─────────────────────────────────────────────────────

describe('ResourceType', () => {
  const validType = () => ({
    name: 'project',
    displayName: 'Project',
  });

  // Schema validation — no DB needed
  it('validates a valid resource type without errors', () => {
    const doc = new ResourceType(validType());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new ResourceType(validType());
    expect(doc.name).toBe('project');
    expect(doc.displayName).toBe('Project');
    expect(doc.description).toBeNull();
    expect(doc.isSystem).toBe(false);
    expect(doc.operations).toEqual([]);
    expect(doc._v).toBe(1);
  });

  it('requires name', () => {
    const doc = new ResourceType({ displayName: 'X' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires displayName', () => {
    const doc = new ResourceType({ name: 'x' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.displayName).toBeDefined();
  });

  it('stores operations subdocuments', () => {
    const doc = new ResourceType({
      ...validType(),
      operations: [
        {
          id: 'op-1',
          name: 'read',
          displayName: 'Read',
        },
      ],
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.operations).toHaveLength(1);
    expect(doc.operations[0].name).toBe('read');
  });

  // DB-dependent tests
  it('enforces unique name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ResourceType.create(validType());
    await expect(ResourceType.create(validType())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── ResourceGroup Model ────────────────────────────────────────────────────

describe('ResourceGroup', () => {
  const validGroup = () => ({
    tenantId: 'tenant-1',
    name: 'My Group',
  });

  // Schema validation — no DB needed
  it('validates a valid resource group without errors', () => {
    const doc = new ResourceGroup(validGroup());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default fields', () => {
    const doc = new ResourceGroup(validGroup());
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.name).toBe('My Group');
    expect(doc.description).toBeNull();
    expect(doc.icon).toBeNull();
    expect(doc.metadata).toBeNull();
    expect(doc.members).toEqual([]);
    expect(doc._v).toBe(1);
  });

  it('requires tenantId', () => {
    const doc = new ResourceGroup({ name: 'X' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires name', () => {
    const doc = new ResourceGroup({ tenantId: 't' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  // DB-dependent tests
  it('enforces unique tenantId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ResourceGroup.create(validGroup());
    await expect(ResourceGroup.create(validGroup())).rejects.toThrow(/duplicate key/i);
  });
});
