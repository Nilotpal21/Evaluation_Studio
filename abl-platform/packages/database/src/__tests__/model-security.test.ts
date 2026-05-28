import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';
import { AuditLog } from '../models/audit-log.model.js';
import { PublicApiKey } from '../models/public-api-key.model.js';
import { RefreshToken } from '../models/refresh-token.model.js';
import { PasswordResetToken } from '../models/password-reset-token.model.js';
import { EmailVerificationToken } from '../models/email-verification-token.model.js';
import { DebugToken } from '../models/debug-token.model.js';
import { KeyVersion } from '../models/key-version.model.js';
import { DeviceAuthRequest } from '../models/device-auth-request.model.js';
import { DeletionRequest } from '../models/deletion-request.model.js';
import { EndUserOAuthToken } from '../models/end-user-oauth-token.model.js';
import { VariableNamespace } from '../models/variable-namespace.model.js';
import { VariableNamespaceMembership } from '../models/variable-namespace-membership.model.js';
import { DeploymentVariableSnapshot } from '../models/deployment-variable-snapshot.model.js';
beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('ab'.repeat(32));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  if (!isMongoReady()) return;
  await clearCollections();
});

// ─── AuditLog Model ─────────────────────────────────────────────────────────

describe('AuditLog', () => {
  const validLog = () => ({ action: 'user.login' });

  it('sets default fields on instantiation', () => {
    const log = new AuditLog(validLog());
    expect(log._id).toBeDefined();
    expect(log.action).toBe('user.login');
    expect(log.userId).toBeNull();
    expect(log.tenantId).toBeNull();
    expect(log.ip).toBeNull();
    expect(log.userAgent).toBeNull();
    expect(log.metadata).toBeNull();
    expect(log._v).toBe(1);
  });

  it('sets createdAt via timestamps on save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const log = await AuditLog.create(validLog());
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it('requires action', () => {
    const doc = new AuditLog({});
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.action).toBeDefined();
  });

  it('accepts all optional fields', () => {
    const log = new AuditLog({
      action: 'project.create',
      userId: 'user-1',
      tenantId: 'tenant-1',
      ip: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      metadata: { projectId: 'proj-1' },
    });
    expect(log.userId).toBe('user-1');
    expect(log.tenantId).toBe('tenant-1');
    expect(log.ip).toBe('192.168.1.1');
    expect(log.userAgent).toBe('Mozilla/5.0');
    expect(log.metadata).toEqual({ projectId: 'proj-1' });
  });
});

// ─── PublicApiKey Model ─────────────────────────────────────────────────────

describe('PublicApiKey', () => {
  const validKey = () => ({
    projectId: 'proj-1',
    keyPrefix: 'pk_',
    keyHash: 'hash-public-123',
    name: 'Web Widget Key',
  });

  it('sets default fields on instantiation', () => {
    const key = new PublicApiKey(validKey());
    expect(key._id).toBeDefined();
    expect(key.projectId).toBe('proj-1');
    expect(key.keyPrefix).toBe('pk_');
    expect(key.keyHash).toBe('hash-public-123');
    expect(key.name).toBe('Web Widget Key');
    expect(key.allowedOrigins).toBeNull();
    expect(key.permissions).toBeNull();
    expect(key.lastUsedAt).toBeNull();
    expect(key.expiresAt).toBeNull();
    expect(key.isActive).toBe(true);
    expect(key._v).toBe(1);
  });

  it('requires projectId', () => {
    const data = validKey();
    delete (data as any).projectId;
    const err = new PublicApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires keyPrefix', () => {
    const data = validKey();
    delete (data as any).keyPrefix;
    const err = new PublicApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.keyPrefix).toBeDefined();
  });

  it('requires keyHash', () => {
    const data = validKey();
    delete (data as any).keyHash;
    const err = new PublicApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.keyHash).toBeDefined();
  });

  it('requires name', () => {
    const data = validKey();
    delete (data as any).name;
    const err = new PublicApiKey(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('enforces unique keyHash', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await PublicApiKey.create(validKey());
    await expect(PublicApiKey.create(validKey())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── RefreshToken Model ─────────────────────────────────────────────────────

describe('RefreshToken', () => {
  const validToken = () => ({
    token: 'rt-abc-123',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 86400000),
  });

  it('sets default fields on instantiation', () => {
    const rt = new RefreshToken(validToken());
    expect(rt._id).toBeDefined();
    expect(rt.token).toBe('rt-abc-123');
    expect(rt.userId).toBe('user-1');
    expect(rt.familyId).toEqual(expect.any(String));
    expect(rt.generation).toBe(1);
    expect(rt.expiresAt).toBeInstanceOf(Date);
    expect(rt.revokedAt).toBeNull();
    expect(rt._v).toBe(1);
  });

  it('requires token', () => {
    const err = new RefreshToken({ userId: 'u', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.token).toBeDefined();
  });

  it('requires userId', () => {
    const err = new RefreshToken({ token: 't', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires expiresAt', () => {
    const err = new RefreshToken({ token: 't', userId: 'u' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('enforces unique token', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await RefreshToken.create(validToken());
    await expect(RefreshToken.create(validToken())).rejects.toThrow(/duplicate key/i);
  });

  it('enforces unique generation within a refresh token family', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await RefreshToken.create({
      ...validToken(),
      token: 'rt-abc-123-a',
      familyId: 'family-1',
      generation: 1,
    });
    await expect(
      RefreshToken.create({
        ...validToken(),
        token: 'rt-abc-123-b',
        familyId: 'family-1',
        generation: 1,
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

// ─── PasswordResetToken Model ───────────────────────────────────────────────

describe('PasswordResetToken', () => {
  const validToken = () => ({
    userId: 'user-1',
    token: 'prt-abc-123',
    expiresAt: new Date(Date.now() + 3600000),
  });

  it('sets default fields on instantiation', () => {
    const prt = new PasswordResetToken(validToken());
    expect(prt._id).toBeDefined();
    expect(prt.userId).toBe('user-1');
    expect(prt.token).toBe('prt-abc-123');
    expect(prt.expiresAt).toBeInstanceOf(Date);
    expect(prt.usedAt).toBeNull();
    expect(prt._v).toBe(1);
  });

  it('requires userId', () => {
    const err = new PasswordResetToken({ token: 't', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires token', () => {
    const err = new PasswordResetToken({ userId: 'u', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.token).toBeDefined();
  });

  it('requires expiresAt', () => {
    const err = new PasswordResetToken({ userId: 'u', token: 't' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('enforces unique token', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await PasswordResetToken.create(validToken());
    await expect(PasswordResetToken.create(validToken())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── EmailVerificationToken Model ───────────────────────────────────────────

describe('EmailVerificationToken', () => {
  const validToken = () => ({
    userId: 'user-1',
    token: 'evt-abc-123',
    expiresAt: new Date(Date.now() + 86400000),
  });

  it('sets default fields on instantiation', () => {
    const evt = new EmailVerificationToken(validToken());
    expect(evt._id).toBeDefined();
    expect(evt.userId).toBe('user-1');
    expect(evt.token).toBe('evt-abc-123');
    expect(evt.expiresAt).toBeInstanceOf(Date);
    expect(evt.usedAt).toBeNull();
    expect(evt._v).toBe(1);
  });

  it('requires userId', () => {
    const err = new EmailVerificationToken({ token: 't', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires token', () => {
    const err = new EmailVerificationToken({ userId: 'u', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.token).toBeDefined();
  });

  it('requires expiresAt', () => {
    const err = new EmailVerificationToken({ userId: 'u', token: 't' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('enforces unique token', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await EmailVerificationToken.create(validToken());
    await expect(EmailVerificationToken.create(validToken())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── DebugToken Model ───────────────────────────────────────────────────────

describe('DebugToken', () => {
  const validToken = () => ({
    token: 'dt-abc-123',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 3600000),
  });

  it('sets default fields on instantiation', () => {
    const dt = new DebugToken(validToken());
    expect(dt._id).toBeDefined();
    expect(dt.token).toBe('dt-abc-123');
    expect(dt.userId).toBe('user-1');
    expect(dt.sessionIds).toEqual([]);
    expect(dt.scopes).toEqual([]);
    expect(dt.expiresAt).toBeInstanceOf(Date);
    expect(dt.lastUsedAt).toBeNull();
    expect(dt.revokedAt).toBeNull();
    expect(dt._v).toBe(1);
  });

  it('requires token', () => {
    const err = new DebugToken({ userId: 'u', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.token).toBeDefined();
  });

  it('requires userId', () => {
    const err = new DebugToken({ token: 't', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires expiresAt', () => {
    const err = new DebugToken({ token: 't', userId: 'u' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('enforces unique token', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DebugToken.create(validToken());
    await expect(DebugToken.create(validToken())).rejects.toThrow(/duplicate key/i);
  });

  it('stores sessionIds and scopes', () => {
    const dt = new DebugToken({
      ...validToken(),
      token: 'dt-xyz-789',
      sessionIds: ['s1', 's2'],
      scopes: ['read', 'trace'],
    });
    expect(dt.sessionIds).toEqual(['s1', 's2']);
    expect(dt.scopes).toEqual(['read', 'trace']);
  });
});

// ─── KeyVersion Model ──────────────────────────────────────────────────────

describe('KeyVersion', () => {
  const validKeyVersion = () => ({
    tenantId: 'tenant-1',
    version: 1,
    status: 'active',
    algorithm: 'aes-256-gcm',
  });

  it('sets default fields on instantiation', () => {
    const kv = new KeyVersion(validKeyVersion());
    expect(kv._id).toBeDefined();
    expect(kv.tenantId).toBe('tenant-1');
    expect(kv.version).toBe(1);
    expect(kv.status).toBe('active');
    expect(kv.algorithm).toBe('aes-256-gcm');
    expect(kv.rotatedAt).toBeNull();
    expect(kv.destroyedAt).toBeNull();
    expect(kv._v).toBe(1);
  });

  it('requires tenantId', () => {
    const err = new KeyVersion({ version: 1, status: 'active', algorithm: 'x' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires version', () => {
    const err = new KeyVersion({ tenantId: 't', status: 'active', algorithm: 'x' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.version).toBeDefined();
  });

  it('requires status', () => {
    const err = new KeyVersion({ tenantId: 't', version: 1, algorithm: 'x' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('validates status enum', () => {
    const err = new KeyVersion({
      ...validKeyVersion(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['active', 'decrypt_only', 'destroyed'];
    for (const status of statuses) {
      const kv = new KeyVersion({ ...validKeyVersion(), status });
      const err = kv.validateSync();
      expect(err).toBeUndefined();
      expect(kv.status).toBe(status);
    }
  });

  it('requires algorithm', () => {
    const err = new KeyVersion({ tenantId: 't', version: 1, status: 'active' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.algorithm).toBeDefined();
  });

  it('enforces unique tenantId+version', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await KeyVersion.create(validKeyVersion());
    await expect(KeyVersion.create(validKeyVersion())).rejects.toThrow(/duplicate key/i);
  });
});

// ─── DeviceAuthRequest Model ────────────────────────────────────────────────

describe('DeviceAuthRequest', () => {
  const validRequest = () => ({
    deviceCode: 'dc-abc-123',
    userCode: 'ABCD-1234',
    expiresAt: new Date(Date.now() + 600000),
  });

  it('sets default fields on instantiation', () => {
    const req = new DeviceAuthRequest(validRequest());
    expect(req._id).toBeDefined();
    expect(req.deviceCode).toBe('dc-abc-123');
    expect(req.userCode).toBe('ABCD-1234');
    expect(req.scopes).toEqual([]);
    expect(req.expiresAt).toBeInstanceOf(Date);
    expect(req.userId).toBeNull();
    expect(req.authorizedAt).toBeNull();
    expect(req.consumedAt).toBeNull();
    expect(req._v).toBe(1);
  });

  it('requires deviceCode', () => {
    const err = new DeviceAuthRequest({ userCode: 'u', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.deviceCode).toBeDefined();
  });

  it('requires userCode', () => {
    const err = new DeviceAuthRequest({ deviceCode: 'd', expiresAt: new Date() }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userCode).toBeDefined();
  });

  it('requires expiresAt', () => {
    const err = new DeviceAuthRequest({ deviceCode: 'd', userCode: 'u' }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.expiresAt).toBeDefined();
  });

  it('enforces unique deviceCode', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeviceAuthRequest.create(validRequest());
    await expect(
      DeviceAuthRequest.create({
        ...validRequest(),
        userCode: 'DIFF-CODE',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('enforces unique userCode', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeviceAuthRequest.create(validRequest());
    await expect(
      DeviceAuthRequest.create({
        ...validRequest(),
        deviceCode: 'dc-other',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

// ─── DeletionRequest Model ──────────────────────────────────────────────────

describe('DeletionRequest', () => {
  const validDeletion = () => ({
    tenantId: 'tenant-1',
    requestedBy: 'user-1',
    subjectId: 'contact-1',
    scope: 'full',
    slaDeadline: new Date(Date.now() + 2592000000),
  });

  it('sets default fields on instantiation', () => {
    const req = new DeletionRequest(validDeletion());
    expect(req._id).toBeDefined();
    expect(req.tenantId).toBe('tenant-1');
    expect(req.requestedBy).toBe('user-1');
    expect(req.subjectId).toBe('contact-1');
    expect(req.scope).toBe('full');
    expect(req.status).toBe('pending');
    expect(req.slaDeadline).toBeInstanceOf(Date);
    expect(req.escalatedAt).toBeNull();
    expect(req.retryCount).toBe(0);
    expect(req.completedAt).toBeNull();
    expect(req._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validDeletion();
    delete (data as any).tenantId;
    const err = new DeletionRequest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires requestedBy', () => {
    const data = validDeletion();
    delete (data as any).requestedBy;
    const err = new DeletionRequest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.requestedBy).toBeDefined();
  });

  it('requires subjectId', () => {
    const data = validDeletion();
    delete (data as any).subjectId;
    const err = new DeletionRequest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.subjectId).toBeDefined();
  });

  it('requires scope', () => {
    const data = validDeletion();
    delete (data as any).scope;
    const err = new DeletionRequest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.scope).toBeDefined();
  });

  it('requires slaDeadline', () => {
    const data = validDeletion();
    delete (data as any).slaDeadline;
    const err = new DeletionRequest(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.slaDeadline).toBeDefined();
  });

  it('validates status enum', () => {
    const err = new DeletionRequest({
      ...validDeletion(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    const statuses = ['pending', 'in_progress', 'completed', 'failed'];
    for (const status of statuses) {
      const req = new DeletionRequest({ ...validDeletion(), status });
      const err = req.validateSync();
      expect(err).toBeUndefined();
      expect(req.status).toBe(status);
    }
  });
});

// ─── EndUserOAuthToken Model ────────────────────────────────────────────────

describe('EndUserOAuthToken', () => {
  const validOAuth = () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    provider: 'salesforce',
    providerUserId: 'sf-user-123',
    encryptedAccessToken: 'enc-access-token',
    scope: 'read write',
    consentedAt: new Date(),
  });

  it('sets default fields on instantiation', () => {
    const token = new EndUserOAuthToken(validOAuth());
    expect(token._id).toBeDefined();
    expect(token.tenantId).toBe('tenant-1');
    expect(token.userId).toBe('user-1');
    expect(token.provider).toBe('salesforce');
    expect(token.providerUserId).toBe('sf-user-123');
    expect(token.encryptedAccessToken).toBe('enc-access-token');
    expect(token.encryptedRefreshToken).toBeNull();
    expect(token.scope).toBe('read write');
    expect(token.expiresAt).toBeNull();
    expect(token.refreshedAt).toBeNull();
    expect(token.consentedAt).toBeInstanceOf(Date);
    expect(token.revokedAt).toBeNull();
    expect(token.lastUsedAt).toBeNull();
    expect(token._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validOAuth();
    delete (data as any).tenantId;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires userId', () => {
    const data = validOAuth();
    delete (data as any).userId;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('requires provider', () => {
    const data = validOAuth();
    delete (data as any).provider;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.provider).toBeDefined();
  });

  it('requires providerUserId', () => {
    const data = validOAuth();
    delete (data as any).providerUserId;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.providerUserId).toBeDefined();
  });

  it('requires encryptedAccessToken', () => {
    const data = validOAuth();
    delete (data as any).encryptedAccessToken;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.encryptedAccessToken).toBeDefined();
  });

  it('requires scope', () => {
    const data = validOAuth();
    delete (data as any).scope;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.scope).toBeDefined();
  });

  it('requires consentedAt', () => {
    const data = validOAuth();
    delete (data as any).consentedAt;
    const err = new EndUserOAuthToken(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.consentedAt).toBeDefined();
  });

  it('enforces unique tenantId+projectId+userId+provider when projectId is a string', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const data = { ...validOAuth(), projectId: 'proj-1', profileId: 'profile-1' };
    await EndUserOAuthToken.create(data);
    await expect(EndUserOAuthToken.create({ ...data, _id: undefined })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows duplicate tenantId+userId+provider when projectId is null (legacy)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    // Partial unique index only applies when projectId is a string — null rows are exempt
    await EndUserOAuthToken.create(validOAuth());
    const second = await EndUserOAuthToken.create({ ...validOAuth(), _id: undefined });
    expect(second._id).toBeDefined();
  });
});

// ─── VariableNamespace Model ────────────────────────────────────────────────

describe('VariableNamespace', () => {
  const validNamespace = () => ({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'production',
    displayName: 'Production',
    createdBy: 'user-1',
  });

  it('sets default fields on instantiation', () => {
    const ns = new VariableNamespace(validNamespace());
    expect(ns._id).toBeDefined();
    expect(ns.tenantId).toBe('tenant-1');
    expect(ns.projectId).toBe('project-1');
    expect(ns.name).toBe('production');
    expect(ns.displayName).toBe('Production');
    expect(ns.description).toBeNull();
    expect(ns.icon).toBeNull();
    expect(ns.color).toBeNull();
    expect(ns.order).toBe(0);
    expect(ns.isDefault).toBe(false);
    expect(ns.createdBy).toBe('user-1');
    expect(ns.updatedBy).toBeNull();
    expect(ns._v).toBe(1);
  });

  it('requires tenantId', () => {
    const data = validNamespace();
    delete (data as any).tenantId;
    const err = new VariableNamespace(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validNamespace();
    delete (data as any).projectId;
    const err = new VariableNamespace(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires name', () => {
    const data = validNamespace();
    delete (data as any).name;
    const err = new VariableNamespace(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires displayName', () => {
    const data = validNamespace();
    delete (data as any).displayName;
    const err = new VariableNamespace(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.displayName).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validNamespace();
    delete (data as any).createdBy;
    const err = new VariableNamespace(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  it('defaults order to 0', () => {
    const ns = new VariableNamespace(validNamespace());
    expect(ns.order).toBe(0);
  });

  it('defaults isDefault to false', () => {
    const ns = new VariableNamespace(validNamespace());
    expect(ns.isDefault).toBe(false);
  });

  it('accepts valid hex color', () => {
    const ns = new VariableNamespace({
      ...validNamespace(),
      color: '#1a2b3c',
    });
    const err = ns.validateSync();
    expect(err).toBeUndefined();
    expect(ns.color).toBe('#1a2b3c');
  });

  it('rejects invalid color format', () => {
    const ns = new VariableNamespace({
      ...validNamespace(),
      color: 'invalid-color',
    });
    const err = ns.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.color).toBeDefined();
    expect(err!.errors.color.message).toContain('valid hex code');
  });

  it('rejects color without hash prefix', () => {
    const ns = new VariableNamespace({
      ...validNamespace(),
      color: '1a2b3c',
    });
    const err = ns.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.color).toBeDefined();
  });

  it('rejects color with wrong length', () => {
    const ns = new VariableNamespace({
      ...validNamespace(),
      color: '#1a2',
    });
    const err = ns.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.color).toBeDefined();
  });

  it('accepts null color', () => {
    const ns = new VariableNamespace({
      ...validNamespace(),
      color: null,
    });
    const err = ns.validateSync();
    expect(err).toBeUndefined();
    expect(ns.color).toBeNull();
  });

  it('enforces unique tenantId+projectId+name', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await VariableNamespace.create(validNamespace());
    await expect(VariableNamespace.create(validNamespace())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same name in different projects', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await VariableNamespace.create(validNamespace());
    const otherProject = {
      ...validNamespace(),
      projectId: 'project-2',
    };
    await expect(VariableNamespace.create(otherProject)).resolves.toBeDefined();
  });
});

// ─── VariableNamespaceMembership Model ──────────────────────────────────────

describe('VariableNamespaceMembership', () => {
  const validMembership = () => ({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    namespaceId: 'namespace-1',
    variableId: 'variable-1',
    variableType: 'env' as const,
  });

  it('sets default fields on instantiation', () => {
    const mem = new VariableNamespaceMembership(validMembership());
    expect(mem._id).toBeDefined();
    expect(mem.tenantId).toBe('tenant-1');
    expect(mem.projectId).toBe('project-1');
    expect(mem.namespaceId).toBe('namespace-1');
    expect(mem.variableId).toBe('variable-1');
    expect(mem.variableType).toBe('env');
  });

  it('requires tenantId', () => {
    const data = validMembership();
    delete (data as any).tenantId;
    const err = new VariableNamespaceMembership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validMembership();
    delete (data as any).projectId;
    const err = new VariableNamespaceMembership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires namespaceId', () => {
    const data = validMembership();
    delete (data as any).namespaceId;
    const err = new VariableNamespaceMembership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.namespaceId).toBeDefined();
  });

  it('requires variableId', () => {
    const data = validMembership();
    delete (data as any).variableId;
    const err = new VariableNamespaceMembership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.variableId).toBeDefined();
  });

  it('requires variableType', () => {
    const data = validMembership();
    delete (data as any).variableType;
    const err = new VariableNamespaceMembership(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.variableType).toBeDefined();
  });

  it('validates variableType enum', () => {
    const err = new VariableNamespaceMembership({
      ...validMembership(),
      variableType: 'invalid' as any,
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.variableType).toBeDefined();
  });

  it('accepts "env" variableType', () => {
    const mem = new VariableNamespaceMembership({
      ...validMembership(),
      variableType: 'env',
    });
    const err = mem.validateSync();
    expect(err).toBeUndefined();
    expect(mem.variableType).toBe('env');
  });

  it('accepts "config" variableType', () => {
    const mem = new VariableNamespaceMembership({
      ...validMembership(),
      variableType: 'config',
    });
    const err = mem.validateSync();
    expect(err).toBeUndefined();
    expect(mem.variableType).toBe('config');
  });

  it('enforces unique namespaceId+variableId+variableType', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await VariableNamespaceMembership.create(validMembership());
    await expect(VariableNamespaceMembership.create(validMembership())).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows same variable in different namespaces', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await VariableNamespaceMembership.create(validMembership());
    const otherNamespace = {
      ...validMembership(),
      namespaceId: 'namespace-2',
    };
    await expect(VariableNamespaceMembership.create(otherNamespace)).resolves.toBeDefined();
  });

  it('allows same variable with different types in same namespace', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await VariableNamespaceMembership.create(validMembership());
    const differentType = {
      ...validMembership(),
      variableType: 'config' as const,
    };
    await expect(VariableNamespaceMembership.create(differentType)).resolves.toBeDefined();
  });
});

// ─── DeploymentVariableSnapshot Model ───────────────────────────────────────

describe('DeploymentVariableSnapshot', () => {
  const validSnapshot = () => ({
    tenantId: 'tenant-1',
    projectId: 'project-1',
    deploymentId: 'deployment-1',
    environment: 'production',
    snapshotHash: 'sha256-abc123',
    createdBy: 'user-1',
  });

  it('sets default fields on instantiation', () => {
    const snap = new DeploymentVariableSnapshot(validSnapshot());
    expect(snap._id).toBeDefined();
    expect(snap.tenantId).toBe('tenant-1');
    expect(snap.projectId).toBe('project-1');
    expect(snap.deploymentId).toBe('deployment-1');
    expect(snap.environment).toBe('production');
    expect(snap.snapshotVersion).toBe(1);
    expect(snap.snapshotHash).toBe('sha256-abc123');
    expect(snap.envVars).toEqual([]);
    expect(snap.configVars).toEqual([]);
    expect(snap.createdBy).toBe('user-1');
  });

  it('requires tenantId', () => {
    const data = validSnapshot();
    delete (data as any).tenantId;
    const err = new DeploymentVariableSnapshot(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validSnapshot();
    delete (data as any).projectId;
    const err = new DeploymentVariableSnapshot(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires deploymentId', () => {
    const data = validSnapshot();
    delete (data as any).deploymentId;
    const err = new DeploymentVariableSnapshot(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.deploymentId).toBeDefined();
  });

  it('requires environment', () => {
    const data = validSnapshot();
    delete (data as any).environment;
    const err = new DeploymentVariableSnapshot(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.environment).toBeDefined();
  });

  it('requires snapshotHash', () => {
    const data = validSnapshot();
    delete (data as any).snapshotHash;
    const err = new DeploymentVariableSnapshot(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.snapshotHash).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validSnapshot();
    delete (data as any).createdBy;
    const err = new DeploymentVariableSnapshot(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  it('defaults snapshotVersion to 1', () => {
    const snap = new DeploymentVariableSnapshot(validSnapshot());
    expect(snap.snapshotVersion).toBe(1);
  });

  it('defaults envVars to empty array', () => {
    const snap = new DeploymentVariableSnapshot(validSnapshot());
    expect(snap.envVars).toEqual([]);
  });

  it('defaults configVars to empty array', () => {
    const snap = new DeploymentVariableSnapshot(validSnapshot());
    expect(snap.configVars).toEqual([]);
  });

  it('accepts envVars array with valid structure', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      envVars: [
        {
          key: 'API_KEY',
          encryptedValue: 'encrypted-value-123',
          isSecret: true,
          description: 'API key',
          sourceId: 'env-var-1',
          namespaces: ['namespace-1'],
        },
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeUndefined();
    expect(snap.envVars).toHaveLength(1);
    expect(snap.envVars[0].key).toBe('API_KEY');
    expect(snap.envVars[0].encryptedValue).toBe('encrypted-value-123');
    expect(snap.envVars[0].isSecret).toBe(true);
  });

  it('accepts configVars array with valid structure', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      configVars: [
        {
          key: 'MAX_RETRIES',
          value: '3',
          description: 'Max retry count',
          sourceId: 'config-var-1',
          namespaces: ['namespace-1'],
        },
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeUndefined();
    expect(snap.configVars).toHaveLength(1);
    expect(snap.configVars[0].key).toBe('MAX_RETRIES');
    expect(snap.configVars[0].value).toBe('3');
  });

  it('requires key in envVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      envVars: [
        {
          encryptedValue: 'enc',
          isSecret: true,
          sourceId: 'src',
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['envVars.0.key']).toBeDefined();
  });

  it('requires encryptedValue in envVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      envVars: [
        {
          key: 'KEY',
          isSecret: true,
          sourceId: 'src',
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['envVars.0.encryptedValue']).toBeDefined();
  });

  it('requires isSecret in envVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      envVars: [
        {
          key: 'KEY',
          encryptedValue: 'enc',
          sourceId: 'src',
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['envVars.0.isSecret']).toBeDefined();
  });

  it('requires sourceId in envVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      envVars: [
        {
          key: 'KEY',
          encryptedValue: 'enc',
          isSecret: true,
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['envVars.0.sourceId']).toBeDefined();
  });

  it('defaults namespaces to empty array in envVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      envVars: [
        {
          key: 'KEY',
          encryptedValue: 'enc',
          isSecret: true,
          sourceId: 'src',
          description: null,
        },
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeUndefined();
    expect(snap.envVars[0].namespaces).toEqual([]);
  });

  it('requires key in configVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      configVars: [
        {
          value: 'val',
          sourceId: 'src',
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['configVars.0.key']).toBeDefined();
  });

  it('requires value in configVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      configVars: [
        {
          key: 'KEY',
          sourceId: 'src',
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['configVars.0.value']).toBeDefined();
  });

  it('requires sourceId in configVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      configVars: [
        {
          key: 'KEY',
          value: 'val',
        } as any,
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['configVars.0.sourceId']).toBeDefined();
  });

  it('defaults namespaces to empty array in configVars', () => {
    const snap = new DeploymentVariableSnapshot({
      ...validSnapshot(),
      configVars: [
        {
          key: 'KEY',
          value: 'val',
          sourceId: 'src',
          description: null,
        },
      ],
    });
    const err = snap.validateSync();
    expect(err).toBeUndefined();
    expect(snap.configVars[0].namespaces).toEqual([]);
  });

  it('enforces unique deploymentId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeploymentVariableSnapshot.create(validSnapshot());
    await expect(DeploymentVariableSnapshot.create(validSnapshot())).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows different snapshots for different deployments', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await DeploymentVariableSnapshot.create(validSnapshot());
    const otherDeployment = {
      ...validSnapshot(),
      deploymentId: 'deployment-2',
    };
    await expect(DeploymentVariableSnapshot.create(otherDeployment)).resolves.toBeDefined();
  });
});
