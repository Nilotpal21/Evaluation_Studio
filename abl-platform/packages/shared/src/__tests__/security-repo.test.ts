/**
 * Security Repository Tests
 *
 * Coverage:
 * - Tool Secrets: CRUD with tenant isolation, filtering, pagination
 * - Org Proxy Configs: CRUD with tenant isolation, filtering, priority sorting
 * - End User OAuth Tokens: find/count with revokedAt filter, token field exclusion
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as securityRepo from '../repos/security-repo.js';

// ─── Mock Setup ──────────────────────────────────────────────────────────

interface MockModel {
  findOne: Mock;
  find: Mock;
  findOneAndUpdate: Mock;
  deleteOne: Mock;
  create: Mock;
  countDocuments: Mock;
}

const mockToolSecret: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
};

const mockOrgProxyConfig: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
};

const mockEndUserOAuthToken: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
};

const mockEnvironmentVariable: MockModel = {
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
};

vi.mock('@agent-platform/database/models', () => ({
  ToolSecret: mockToolSecret,
  OrgProxyConfig: mockOrgProxyConfig,
  EndUserOAuthToken: mockEndUserOAuthToken,
  EnvironmentVariable: mockEnvironmentVariable,
}));

// ─── Test Data ───────────────────────────────────────────────────────────

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROJECT_1 = 'project-1';
const now = new Date();

function makeSecretDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'secret-1',
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    toolName: 'weather-api',
    secretKey: 'API_KEY',
    encryptedValue: 'enc-abc123',
    environment: 'production',
    version: 1,
    expiresAt: null,
    rotatedAt: null,
    createdBy: 'user-1',
    _v: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProxyDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'proxy-1',
    tenantId: TENANT_A,
    name: 'corp-proxy',
    proxyUrl: 'http://proxy.corp.internal:8080',
    proxyAuthType: 'basic',
    encryptedProxyUsername: 'enc-user',
    encryptedProxyPassword: 'enc-pass',
    encryptedProxyToken: null,
    encryptedCaCertificate: null,
    encryptedClientCert: null,
    encryptedClientKey: null,
    urlPatterns: '*.example.com',
    bypassPatterns: null,
    environment: 'production',
    priority: 10,
    enabled: true,
    createdBy: 'user-1',
    _v: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeOAuthDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'oauth-1',
    tenantId: TENANT_A,
    userId: 'user-1',
    provider: 'google',
    providerUserId: 'google-123',
    encryptedAccessToken: 'enc-access',
    encryptedRefreshToken: 'enc-refresh',
    scope: 'openid email',
    expiresAt: null,
    refreshedAt: null,
    consentedAt: now,
    revokedAt: null,
    lastUsedAt: null,
    _v: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEnvVarDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'envvar-1',
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    environment: 'production',
    key: 'API_URL',
    encryptedValue: 'enc-https://api.example.com',
    isSecret: false,
    description: 'API endpoint URL',
    createdBy: 'user-1',
    updatedBy: null,
    _v: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── Helper to Mock Method Chaining ──────────────────────────────────────

function createChainableMock(returnValue: unknown) {
  const chain = {
    lean: vi.fn().mockResolvedValue(returnValue),
    sort: vi.fn(),
    skip: vi.fn(),
    limit: vi.fn(),
    select: vi.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  return chain;
}

/** Create a mock Mongoose document with set/save/toObject for findOne+save pattern */
function createDocMock(data: Record<string, unknown>) {
  const docData = { ...data };
  return {
    ...docData,
    get: vi.fn((key: string) => (docData as any)[key]),
    set: vi.fn((key: string, value: unknown) => {
      (docData as any)[key] = value;
    }),
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(() => docData),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Security Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================================================================
  // TOOL SECRETS
  // =====================================================================

  describe('Tool Secrets', () => {
    // ─── Tenant Isolation ────────────────────────────────────────────

    describe('Tenant Isolation', () => {
      test('findToolSecretById enforces tenantId filter', async () => {
        mockToolSecret.findOne.mockReturnValue(createChainableMock(makeSecretDoc()));

        await securityRepo.findToolSecretById('secret-1', TENANT_A);

        expect(mockToolSecret.findOne).toHaveBeenCalledWith({
          _id: 'secret-1',
          tenantId: TENANT_A,
        });
      });

      test('findToolSecretById returns null for wrong tenant', async () => {
        mockToolSecret.findOne.mockReturnValue(createChainableMock(null));

        const result = await securityRepo.findToolSecretById('secret-1', TENANT_B);

        expect(result).toBeNull();
        expect(mockToolSecret.findOne).toHaveBeenCalledWith({
          _id: 'secret-1',
          tenantId: TENANT_B,
        });
      });

      test('updateToolSecret enforces tenantId filter', async () => {
        const doc = createDocMock(makeSecretDoc({ encryptedValue: 'enc-new' }));
        mockToolSecret.findOne.mockResolvedValue(doc);

        await securityRepo.updateToolSecret('secret-1', TENANT_A, {
          encryptedValue: 'enc-new',
        });

        expect(mockToolSecret.findOne).toHaveBeenCalledWith({
          _id: 'secret-1',
          tenantId: TENANT_A,
        });
      });

      test('deleteToolSecret enforces tenantId filter', async () => {
        mockToolSecret.deleteOne.mockResolvedValue({ deletedCount: 1 });

        await securityRepo.deleteToolSecret('secret-1', TENANT_A);

        expect(mockToolSecret.deleteOne).toHaveBeenCalledWith({
          _id: 'secret-1',
          tenantId: TENANT_A,
        });
      });
    });

    // ─── Create ──────────────────────────────────────────────────────

    describe('createToolSecret', () => {
      test('creates secret and returns normalized result', async () => {
        const doc = makeSecretDoc();
        mockToolSecret.create.mockResolvedValue({
          toObject: () => doc,
        });

        const result = await securityRepo.createToolSecret({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          toolName: 'weather-api',
          secretKey: 'API_KEY',
          encryptedValue: 'enc-abc123',
          environment: 'production',
          createdBy: 'user-1',
        });

        expect(result.id).toBe('secret-1');
        expect(result.toolName).toBe('weather-api');
        expect(result.secretKey).toBe('API_KEY');
      });

      test('passes all fields to create', async () => {
        const expiresAt = new Date('2026-12-31');
        const doc = makeSecretDoc({ expiresAt });
        mockToolSecret.create.mockResolvedValue({
          toObject: () => doc,
        });

        await securityRepo.createToolSecret({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          toolName: 'weather-api',
          secretKey: 'API_KEY',
          encryptedValue: 'enc-abc123',
          environment: 'production',
          expiresAt,
          createdBy: 'user-1',
        });

        expect(mockToolSecret.create).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: TENANT_A,
            expiresAt,
          }),
        );
      });
    });

    // ─── Find / List ─────────────────────────────────────────────────

    describe('findToolSecrets', () => {
      test('returns secrets filtered by tenantId', async () => {
        const docs = [
          makeSecretDoc({ _id: 'secret-1' }),
          makeSecretDoc({ _id: 'secret-2', secretKey: 'DB_PASSWORD' }),
        ];
        const chain = createChainableMock(docs);
        mockToolSecret.find.mockReturnValue(chain);

        const result = await securityRepo.findToolSecrets({ tenantId: TENANT_A });

        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('secret-1');
        expect(result[1].id).toBe('secret-2');
        expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
      });

      test('applies toolName filter', async () => {
        const chain = createChainableMock([]);
        mockToolSecret.find.mockReturnValue(chain);

        await securityRepo.findToolSecrets({
          tenantId: TENANT_A,
          toolName: 'weather-api',
        });

        expect(mockToolSecret.find).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          toolName: 'weather-api',
        });
      });

      test('applies environment filter', async () => {
        const chain = createChainableMock([]);
        mockToolSecret.find.mockReturnValue(chain);

        await securityRepo.findToolSecrets({
          tenantId: TENANT_A,
          environment: 'staging',
        });

        expect(mockToolSecret.find).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          environment: 'staging',
        });
      });

      test('applies skip and take for pagination', async () => {
        const chain = createChainableMock([]);
        mockToolSecret.find.mockReturnValue(chain);

        await securityRepo.findToolSecrets({ tenantId: TENANT_A }, { skip: 10, take: 5 });

        expect(chain.skip).toHaveBeenCalledWith(10);
        expect(chain.limit).toHaveBeenCalledWith(5);
      });

      test('applies select projection', async () => {
        const chain = createChainableMock([]);
        mockToolSecret.find.mockReturnValue(chain);

        await securityRepo.findToolSecrets(
          { tenantId: TENANT_A },
          { select: { toolName: true, secretKey: true } },
        );

        expect(chain.select).toHaveBeenCalledWith({
          toolName: 1,
          secretKey: 1,
        });
      });
    });

    describe('countToolSecrets', () => {
      test('counts secrets with tenant filter', async () => {
        mockToolSecret.countDocuments.mockResolvedValue(5);

        const result = await securityRepo.countToolSecrets({ tenantId: TENANT_A });

        expect(result).toBe(5);
        expect(mockToolSecret.countDocuments).toHaveBeenCalledWith({
          tenantId: TENANT_A,
        });
      });

      test('counts secrets with toolName filter', async () => {
        mockToolSecret.countDocuments.mockResolvedValue(2);

        const result = await securityRepo.countToolSecrets({
          tenantId: TENANT_A,
          toolName: 'weather-api',
        });

        expect(result).toBe(2);
        expect(mockToolSecret.countDocuments).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          toolName: 'weather-api',
        });
      });
    });

    // ─── Update ──────────────────────────────────────────────────────

    describe('updateToolSecret', () => {
      test('updates secret and returns normalized result', async () => {
        const updated = makeSecretDoc({ encryptedValue: 'enc-new', version: 2 });
        const doc = createDocMock(updated);
        mockToolSecret.findOne.mockResolvedValue(doc);

        const result = await securityRepo.updateToolSecret('secret-1', TENANT_A, {
          encryptedValue: 'enc-new',
          version: 2,
          rotatedAt: new Date(),
        });

        expect(result).not.toBeNull();
        expect(mockToolSecret.findOne).toHaveBeenCalledWith({
          _id: 'secret-1',
          tenantId: TENANT_A,
        });
        expect(doc.set).toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalled();
      });

      test('returns null when secret not found', async () => {
        mockToolSecret.findOne.mockResolvedValue(null);

        const result = await securityRepo.updateToolSecret('nonexistent', TENANT_A, {
          encryptedValue: 'enc-new',
        });

        expect(result).toBeNull();
      });
    });

    // ─── Delete ──────────────────────────────────────────────────────

    describe('deleteToolSecret', () => {
      test('deletes secret by id and tenantId', async () => {
        mockToolSecret.deleteOne.mockResolvedValue({ deletedCount: 1 });

        await securityRepo.deleteToolSecret('secret-1', TENANT_A);

        expect(mockToolSecret.deleteOne).toHaveBeenCalledWith({
          _id: 'secret-1',
          tenantId: TENANT_A,
        });
      });
    });
  });

  // =====================================================================
  // ORG PROXY CONFIGS
  // =====================================================================

  describe('Org Proxy Configs', () => {
    // ─── Tenant Isolation ────────────────────────────────────────────

    describe('Tenant Isolation', () => {
      test('findOrgProxyConfigById enforces tenantId filter', async () => {
        mockOrgProxyConfig.findOne.mockReturnValue(createChainableMock(makeProxyDoc()));

        await securityRepo.findOrgProxyConfigById('proxy-1', TENANT_A);

        expect(mockOrgProxyConfig.findOne).toHaveBeenCalledWith({
          _id: 'proxy-1',
          tenantId: TENANT_A,
        });
      });

      test('findOrgProxyConfigById returns null for wrong tenant', async () => {
        mockOrgProxyConfig.findOne.mockReturnValue(createChainableMock(null));

        const result = await securityRepo.findOrgProxyConfigById('proxy-1', TENANT_B);

        expect(result).toBeNull();
      });

      test('updateOrgProxyConfig enforces tenantId', async () => {
        const doc = createDocMock(makeProxyDoc({ name: 'updated' }));
        mockOrgProxyConfig.findOne.mockResolvedValue(doc);

        await securityRepo.updateOrgProxyConfig('proxy-1', TENANT_A, { name: 'updated' });

        expect(mockOrgProxyConfig.findOne).toHaveBeenCalledWith({
          _id: 'proxy-1',
          tenantId: TENANT_A,
        });
      });

      test('deleteOrgProxyConfig enforces tenantId', async () => {
        mockOrgProxyConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

        await securityRepo.deleteOrgProxyConfig('proxy-1', TENANT_A);

        expect(mockOrgProxyConfig.deleteOne).toHaveBeenCalledWith({
          _id: 'proxy-1',
          tenantId: TENANT_A,
        });
      });
    });

    // ─── Create ──────────────────────────────────────────────────────

    describe('createOrgProxyConfig', () => {
      test('creates proxy config and returns normalized result', async () => {
        const doc = makeProxyDoc();
        mockOrgProxyConfig.create.mockResolvedValue({
          toObject: () => doc,
        });

        const result = await securityRepo.createOrgProxyConfig({
          tenantId: TENANT_A,
          name: 'corp-proxy',
          proxyUrl: 'http://proxy.corp.internal:8080',
          proxyAuthType: 'basic',
          urlPatterns: '*.example.com',
          createdBy: 'user-1',
        });

        expect(result.id).toBe('proxy-1');
        expect(result.name).toBe('corp-proxy');
        expect(result.proxyAuthType).toBe('basic');
      });
    });

    // ─── Find / List ─────────────────────────────────────────────────

    describe('findOrgProxyConfigs', () => {
      test('returns configs sorted by priority desc, createdAt desc', async () => {
        const docs = [
          makeProxyDoc({ _id: 'proxy-1', priority: 10 }),
          makeProxyDoc({ _id: 'proxy-2', priority: 5 }),
        ];
        const chain = createChainableMock(docs);
        mockOrgProxyConfig.find.mockReturnValue(chain);

        const result = await securityRepo.findOrgProxyConfigs({ tenantId: TENANT_A });

        expect(result).toHaveLength(2);
        expect(chain.sort).toHaveBeenCalledWith({ priority: -1, createdAt: -1 });
      });

      test('filters by environment', async () => {
        const chain = createChainableMock([]);
        mockOrgProxyConfig.find.mockReturnValue(chain);

        await securityRepo.findOrgProxyConfigs({
          tenantId: TENANT_A,
          environment: 'staging',
        });

        expect(mockOrgProxyConfig.find).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          environment: 'staging',
        });
      });

      test('filters by enabled', async () => {
        const chain = createChainableMock([]);
        mockOrgProxyConfig.find.mockReturnValue(chain);

        await securityRepo.findOrgProxyConfigs({
          tenantId: TENANT_A,
          enabled: true,
        });

        expect(mockOrgProxyConfig.find).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          enabled: true,
        });
      });

      test('applies skip and take', async () => {
        const chain = createChainableMock([]);
        mockOrgProxyConfig.find.mockReturnValue(chain);

        await securityRepo.findOrgProxyConfigs({ tenantId: TENANT_A }, { skip: 5, take: 10 });

        expect(chain.skip).toHaveBeenCalledWith(5);
        expect(chain.limit).toHaveBeenCalledWith(10);
      });

      test('applies select projection', async () => {
        const chain = createChainableMock([]);
        mockOrgProxyConfig.find.mockReturnValue(chain);

        await securityRepo.findOrgProxyConfigs(
          { tenantId: TENANT_A },
          { select: { name: true, proxyUrl: true } },
        );

        expect(chain.select).toHaveBeenCalledWith({ name: 1, proxyUrl: 1 });
      });
    });

    describe('countOrgProxyConfigs', () => {
      test('counts configs with tenant filter', async () => {
        mockOrgProxyConfig.countDocuments.mockResolvedValue(3);

        const result = await securityRepo.countOrgProxyConfigs({ tenantId: TENANT_A });

        expect(result).toBe(3);
        expect(mockOrgProxyConfig.countDocuments).toHaveBeenCalledWith({
          tenantId: TENANT_A,
        });
      });
    });

    // ─── Update ──────────────────────────────────────────────────────

    describe('updateOrgProxyConfig', () => {
      test('updates proxy config and returns normalized result', async () => {
        const updated = makeProxyDoc({ name: 'updated-proxy', priority: 20 });
        const doc = createDocMock(updated);
        mockOrgProxyConfig.findOne.mockResolvedValue(doc);

        const result = await securityRepo.updateOrgProxyConfig('proxy-1', TENANT_A, {
          name: 'updated-proxy',
          priority: 20,
        });

        expect(result).not.toBeNull();
        expect(result!.name).toBe('updated-proxy');
        expect(doc.set).toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalled();
      });

      test('returns null when proxy config not found', async () => {
        mockOrgProxyConfig.findOne.mockResolvedValue(null);

        const result = await securityRepo.updateOrgProxyConfig('nonexistent', TENANT_A, {
          name: 'updated',
        });

        expect(result).toBeNull();
      });
    });

    // ─── Delete ──────────────────────────────────────────────────────

    describe('deleteOrgProxyConfig', () => {
      test('deletes proxy config by id and tenantId', async () => {
        mockOrgProxyConfig.deleteOne.mockResolvedValue({ deletedCount: 1 });

        await securityRepo.deleteOrgProxyConfig('proxy-1', TENANT_A);

        expect(mockOrgProxyConfig.deleteOne).toHaveBeenCalledWith({
          _id: 'proxy-1',
          tenantId: TENANT_A,
        });
      });
    });
  });

  // =====================================================================
  // END USER OAUTH TOKENS
  // =====================================================================

  describe('End User OAuth Tokens', () => {
    describe('findEndUserOAuthTokens', () => {
      test('finds non-revoked tokens for user', async () => {
        const docs = [makeOAuthDoc()];
        const chain = createChainableMock(docs);
        mockEndUserOAuthToken.find.mockReturnValue(chain);

        const result = await securityRepo.findEndUserOAuthTokens({
          tenantId: TENANT_A,
          userId: 'user-1',
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('oauth-1');
        expect(result[0].provider).toBe('google');
      });

      test('filters out revoked tokens', async () => {
        const chain = createChainableMock([]);
        mockEndUserOAuthToken.find.mockReturnValue(chain);

        await securityRepo.findEndUserOAuthTokens({
          tenantId: TENANT_A,
          userId: 'user-1',
        });

        expect(mockEndUserOAuthToken.find).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          userId: 'user-1',
          revokedAt: null,
        });
      });

      test('excludes encrypted token fields from results', async () => {
        const chain = createChainableMock([]);
        mockEndUserOAuthToken.find.mockReturnValue(chain);

        await securityRepo.findEndUserOAuthTokens({
          tenantId: TENANT_A,
          userId: 'user-1',
        });

        expect(chain.select).toHaveBeenCalledWith({
          encryptedAccessToken: 0,
          encryptedRefreshToken: 0,
        });
      });

      test('sorts by consentedAt desc', async () => {
        const chain = createChainableMock([]);
        mockEndUserOAuthToken.find.mockReturnValue(chain);

        await securityRepo.findEndUserOAuthTokens({
          tenantId: TENANT_A,
          userId: 'user-1',
        });

        expect(chain.sort).toHaveBeenCalledWith({ consentedAt: -1 });
      });

      test('applies skip and take for pagination', async () => {
        const chain = createChainableMock([]);
        mockEndUserOAuthToken.find.mockReturnValue(chain);

        await securityRepo.findEndUserOAuthTokens(
          { tenantId: TENANT_A, userId: 'user-1' },
          { skip: 5, take: 10 },
        );

        expect(chain.skip).toHaveBeenCalledWith(5);
        expect(chain.limit).toHaveBeenCalledWith(10);
      });
    });

    describe('countEndUserOAuthTokens', () => {
      test('counts non-revoked tokens for user', async () => {
        mockEndUserOAuthToken.countDocuments.mockResolvedValue(3);

        const result = await securityRepo.countEndUserOAuthTokens({
          tenantId: TENANT_A,
          userId: 'user-1',
        });

        expect(result).toBe(3);
        expect(mockEndUserOAuthToken.countDocuments).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          userId: 'user-1',
          revokedAt: null,
        });
      });

      test('returns 0 when no tokens exist', async () => {
        mockEndUserOAuthToken.countDocuments.mockResolvedValue(0);

        const result = await securityRepo.countEndUserOAuthTokens({
          tenantId: TENANT_A,
          userId: 'new-user',
        });

        expect(result).toBe(0);
      });
    });
  });

  // =====================================================================
  // ENVIRONMENT VARIABLES
  // =====================================================================

  describe('Environment Variables', () => {
    // ─── Tenant Isolation ────────────────────────────────────────────

    describe('Tenant Isolation', () => {
      test('findEnvironmentVariableById enforces tenantId and projectId filter', async () => {
        mockEnvironmentVariable.findOne.mockReturnValue(createChainableMock(makeEnvVarDoc()));

        await securityRepo.findEnvironmentVariableById('envvar-1', TENANT_A, PROJECT_1);

        expect(mockEnvironmentVariable.findOne).toHaveBeenCalledWith({
          _id: 'envvar-1',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });
      });

      test('findEnvironmentVariableById returns null for wrong tenant', async () => {
        mockEnvironmentVariable.findOne.mockReturnValue(createChainableMock(null));

        const result = await securityRepo.findEnvironmentVariableById(
          'envvar-1',
          TENANT_B,
          PROJECT_1,
        );

        expect(result).toBeNull();
        expect(mockEnvironmentVariable.findOne).toHaveBeenCalledWith({
          _id: 'envvar-1',
          tenantId: TENANT_B,
          projectId: PROJECT_1,
        });
      });

      test('updateEnvironmentVariable enforces tenantId and projectId filter', async () => {
        const doc = createDocMock(makeEnvVarDoc());
        mockEnvironmentVariable.findOne.mockResolvedValue(doc);

        await securityRepo.updateEnvironmentVariable('envvar-1', TENANT_A, PROJECT_1, {
          encryptedValue: 'enc-new-value',
        });

        expect(mockEnvironmentVariable.findOne).toHaveBeenCalledWith({
          _id: 'envvar-1',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });
      });

      test('deleteEnvironmentVariable enforces tenantId and projectId filter', async () => {
        mockEnvironmentVariable.deleteOne.mockResolvedValue({ deletedCount: 1 });

        await securityRepo.deleteEnvironmentVariable('envvar-1', TENANT_A, PROJECT_1);

        expect(mockEnvironmentVariable.deleteOne).toHaveBeenCalledWith({
          _id: 'envvar-1',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });
      });
    });

    // ─── Create ──────────────────────────────────────────────────────

    describe('createEnvironmentVariable', () => {
      test('creates variable and returns normalized result', async () => {
        const doc = makeEnvVarDoc();
        mockEnvironmentVariable.create.mockResolvedValue({
          toObject: () => doc,
        });

        const result = await securityRepo.createEnvironmentVariable({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'production',
          key: 'API_URL',
          encryptedValue: 'enc-https://api.example.com',
          isSecret: false,
          description: 'API endpoint URL',
          createdBy: 'user-1',
        });

        expect(result.id).toBe('envvar-1');
        expect(result.key).toBe('API_URL');
        expect(result.environment).toBe('production');
        expect(result.isSecret).toBe(false);
      });

      test('passes all fields to create', async () => {
        const doc = makeEnvVarDoc({ isSecret: true });
        mockEnvironmentVariable.create.mockResolvedValue({
          toObject: () => doc,
        });

        await securityRepo.createEnvironmentVariable({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'production',
          key: 'SECRET_KEY',
          encryptedValue: 'enc-secret-value',
          isSecret: true,
          description: 'A secret key',
          createdBy: 'user-1',
        });

        expect(mockEnvironmentVariable.create).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: TENANT_A,
            projectId: PROJECT_1,
            isSecret: true,
          }),
        );
      });
    });

    // ─── Find / List ─────────────────────────────────────────────────

    describe('findEnvironmentVariables', () => {
      test('returns variables filtered by tenantId and projectId', async () => {
        const docs = [
          makeEnvVarDoc({ _id: 'envvar-1' }),
          makeEnvVarDoc({ _id: 'envvar-2', key: 'DB_HOST' }),
        ];
        const chain = createChainableMock(docs);
        mockEnvironmentVariable.find.mockReturnValue(chain);

        const result = await securityRepo.findEnvironmentVariables({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });

        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('envvar-1');
        expect(result[1].id).toBe('envvar-2');
        expect(chain.sort).toHaveBeenCalledWith({ key: 1 });
      });

      test('applies environment filter', async () => {
        const chain = createChainableMock([]);
        mockEnvironmentVariable.find.mockReturnValue(chain);

        await securityRepo.findEnvironmentVariables({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'staging',
        });

        expect(mockEnvironmentVariable.find).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'staging',
        });
      });

      test('applies skip and take for pagination', async () => {
        const chain = createChainableMock([]);
        mockEnvironmentVariable.find.mockReturnValue(chain);

        await securityRepo.findEnvironmentVariables(
          { tenantId: TENANT_A, projectId: PROJECT_1 },
          { skip: 10, take: 5 },
        );

        expect(chain.skip).toHaveBeenCalledWith(10);
        expect(chain.limit).toHaveBeenCalledWith(5);
      });

      test('applies select projection', async () => {
        const chain = createChainableMock([]);
        mockEnvironmentVariable.find.mockReturnValue(chain);

        await securityRepo.findEnvironmentVariables(
          { tenantId: TENANT_A, projectId: PROJECT_1 },
          { select: { key: true, environment: true } },
        );

        expect(chain.select).toHaveBeenCalledWith({ key: true, environment: true });
      });
    });

    describe('countEnvironmentVariables', () => {
      test('counts variables with tenant and project filter', async () => {
        mockEnvironmentVariable.countDocuments.mockResolvedValue(8);

        const result = await securityRepo.countEnvironmentVariables({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });

        expect(result).toBe(8);
        expect(mockEnvironmentVariable.countDocuments).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });
      });

      test('counts variables with environment filter', async () => {
        mockEnvironmentVariable.countDocuments.mockResolvedValue(3);

        const result = await securityRepo.countEnvironmentVariables({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'production',
        });

        expect(result).toBe(3);
        expect(mockEnvironmentVariable.countDocuments).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'production',
        });
      });
    });

    // ─── Find By Key ─────────────────────────────────────────────────

    describe('findEnvironmentVariableByKey', () => {
      test('finds variable by composite key', async () => {
        mockEnvironmentVariable.findOne.mockReturnValue(createChainableMock(makeEnvVarDoc()));

        const result = await securityRepo.findEnvironmentVariableByKey(
          TENANT_A,
          PROJECT_1,
          'production',
          'API_URL',
        );

        expect(result).not.toBeNull();
        expect(result!.id).toBe('envvar-1');
        expect(mockEnvironmentVariable.findOne).toHaveBeenCalledWith({
          tenantId: TENANT_A,
          projectId: PROJECT_1,
          environment: 'production',
          key: 'API_URL',
        });
      });

      test('returns null when key not found', async () => {
        mockEnvironmentVariable.findOne.mockReturnValue(createChainableMock(null));

        const result = await securityRepo.findEnvironmentVariableByKey(
          TENANT_A,
          PROJECT_1,
          'production',
          'NONEXISTENT',
        );

        expect(result).toBeNull();
      });
    });

    // ─── Update ──────────────────────────────────────────────────────

    describe('updateEnvironmentVariable', () => {
      test('updates variable and returns normalized result', async () => {
        const updated = makeEnvVarDoc({ encryptedValue: 'enc-new-value' });
        const doc = createDocMock(updated);
        mockEnvironmentVariable.findOne.mockResolvedValue(doc);

        const result = await securityRepo.updateEnvironmentVariable(
          'envvar-1',
          TENANT_A,
          PROJECT_1,
          {
            encryptedValue: 'enc-new-value',
          },
        );

        expect(result).not.toBeNull();
        expect(mockEnvironmentVariable.findOne).toHaveBeenCalledWith({
          _id: 'envvar-1',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });
        expect(doc.set).toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalled();
      });

      test('returns null when variable not found', async () => {
        mockEnvironmentVariable.findOne.mockResolvedValue(null);

        const result = await securityRepo.updateEnvironmentVariable(
          'nonexistent',
          TENANT_A,
          PROJECT_1,
          {
            encryptedValue: 'enc-new',
          },
        );

        expect(result).toBeNull();
      });
    });

    // ─── Delete ──────────────────────────────────────────────────────

    describe('deleteEnvironmentVariable', () => {
      test('deletes variable by id, tenantId, and projectId', async () => {
        mockEnvironmentVariable.deleteOne.mockResolvedValue({ deletedCount: 1 });

        await securityRepo.deleteEnvironmentVariable('envvar-1', TENANT_A, PROJECT_1);

        expect(mockEnvironmentVariable.deleteOne).toHaveBeenCalledWith({
          _id: 'envvar-1',
          tenantId: TENANT_A,
          projectId: PROJECT_1,
        });
      });
    });

    // ─── Bulk Upsert ─────────────────────────────────────────────────

    describe('bulkUpsertEnvironmentVariables', () => {
      test('creates new variables when none exist', async () => {
        mockEnvironmentVariable.findOne.mockResolvedValue(null);
        mockEnvironmentVariable.create.mockResolvedValue({});

        const result = await securityRepo.bulkUpsertEnvironmentVariables(
          TENANT_A,
          PROJECT_1,
          'staging',
          [
            { key: 'KEY_A', encryptedValue: 'enc-a', isSecret: false, description: null },
            { key: 'KEY_B', encryptedValue: 'enc-b', isSecret: true, description: 'desc' },
          ],
          'user-1',
          false,
        );

        expect(result.upserted).toBe(2);
        expect(result.matched).toBe(0);
        expect(mockEnvironmentVariable.create).toHaveBeenCalledTimes(2);
      });

      test('skips existing variables when overwrite is false', async () => {
        const existingDoc = createDocMock(makeEnvVarDoc());
        mockEnvironmentVariable.findOne.mockResolvedValue(existingDoc);

        const result = await securityRepo.bulkUpsertEnvironmentVariables(
          TENANT_A,
          PROJECT_1,
          'staging',
          [{ key: 'KEY_A', encryptedValue: 'enc-a', isSecret: false, description: null }],
          'user-1',
          false,
        );

        expect(result.upserted).toBe(0);
        expect(result.matched).toBe(1);
        expect(existingDoc.save).not.toHaveBeenCalled();
      });

      test('overwrites existing variables when overwrite is true', async () => {
        const existingDoc = createDocMock(makeEnvVarDoc());
        mockEnvironmentVariable.findOne.mockResolvedValue(existingDoc);

        const result = await securityRepo.bulkUpsertEnvironmentVariables(
          TENANT_A,
          PROJECT_1,
          'staging',
          [{ key: 'KEY_A', encryptedValue: 'enc-new', isSecret: true, description: 'updated' }],
          'user-1',
          true,
        );

        expect(result.upserted).toBe(0);
        expect(result.matched).toBe(1);
        expect(existingDoc.set).toHaveBeenCalledWith('encryptedValue', 'enc-new');
        expect(existingDoc.set).toHaveBeenCalledWith('isSecret', true);
        expect(existingDoc.set).toHaveBeenCalledWith('description', 'updated');
        expect(existingDoc.set).toHaveBeenCalledWith('updatedBy', 'user-1');
        expect(existingDoc.save).toHaveBeenCalled();
      });
    });
  });
});
