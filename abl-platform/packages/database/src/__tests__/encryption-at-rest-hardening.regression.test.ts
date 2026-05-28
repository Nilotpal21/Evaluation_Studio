import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  requireMongo,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import {
  DEKManager,
  KMSProviderPool,
  KMSResolver,
  _resetKMSRegistryForTesting,
  setKMSProviderPool,
} from '../kms/index.js';
import {
  _resetEncryptionStateForTesting,
  setEncryptionFacade,
} from '../mongo/plugins/encryption.plugin.js';
import { isAlreadyEncrypted, TenantEncryptionFacade } from '@agent-platform/shared-encryption';
import { migration as hardeningBackfillMigration } from '../migrations/scripts/20260426_023_backfill_encrypted_custom_headers_auth_config.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

let dekManager: DEKManager | undefined;

async function initRealDEKStack() {
  const pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
  await pool.initialize();
  setKMSProviderPool(pool);

  const resolver = new KMSResolver();
  dekManager = new DEKManager(resolver);
  setEncryptionFacade(new TenantEncryptionFacade(dekManager, 'platform-default'));
}

function resetRegisteredModels() {
  for (const name of ['LLMCredential', 'ArchWorkspaceConfig', 'TenantModel']) {
    delete mongoose.models[name];
    delete mongoose.connection.models[name];
  }
}

async function importModels() {
  resetRegisteredModels();

  const [{ LLMCredential }, { ArchWorkspaceConfig }, { TenantModel }] = await Promise.all([
    import('../models/llm-credential.model.js'),
    import('../models/arch-workspace-config.model.js'),
    import('../models/tenant-model.model.js'),
  ]);

  return { LLMCredential, ArchWorkspaceConfig, TenantModel };
}

describe('encryption-at-rest hardening regression', () => {
  beforeAll(async () => {
    await setupTestMongo();
  });

  afterAll(async () => {
    await teardownTestMongo();
    _resetKMSRegistryForTesting();
    _resetEncryptionStateForTesting();
  });

  beforeEach(async ({ skip }) => {
    requireMongo(skip);
    await clearCollections();
    _resetKMSRegistryForTesting();
    _resetEncryptionStateForTesting();
    dekManager?.clearCache();
    resetRegisteredModels();
    await initRealDEKStack();
  });

  it('stores llm credential customHeaders and authConfig encrypted at rest', async ({ skip }) => {
    requireMongo(skip);
    const { LLMCredential } = await importModels();

    const customHeaders = { Authorization: 'Bearer secret-header' };
    const authConfig = {
      clientId: 'client-1',
      clientSecret: 'oauth-secret',
      tokenUrl: 'https://idp.example.com/token',
    };

    const doc = await LLMCredential.create({
      credentialScope: 'tenant',
      ownerId: 'user-hardening-1',
      tenantId: 'tenant-hardening-1',
      provider: 'openai',
      name: 'hardening-cred',
      encryptedApiKey: 'sk-hardening',
      encryptedEndpoint: 'https://api.openai.com/v1',
      customHeaders,
      authType: 'oauth2',
      authConfig,
    });

    const raw = await mongoose.connection.db
      .collection('llm_credentials')
      .findOne({ _id: doc._id });

    expect(raw?.customHeaders).not.toEqual(customHeaders);
    expect(raw?.authConfig).not.toEqual(authConfig);
  });

  it('stores arch workspace customHeaders encrypted at rest', async ({ skip }) => {
    requireMongo(skip);
    const { ArchWorkspaceConfig } = await importModels();

    const customHeaders = { 'x-api-key': 'workspace-secret-header' };

    const doc = await ArchWorkspaceConfig.create({
      tenantId: 'tenant-hardening-2',
      encryptedApiKey: 'sk-workspace',
      customHeaders,
    });

    const raw = await mongoose.connection.db
      .collection('arch_workspace_configs')
      .findOne({ _id: doc._id });

    expect(raw?.customHeaders).not.toEqual(customHeaders);
  });

  it('stores tenant model customHeaders encrypted at rest', async ({ skip }) => {
    requireMongo(skip);
    const { TenantModel } = await importModels();

    const customHeaders = { Authorization: 'Bearer tenant-model-secret' };

    const doc = await TenantModel.create({
      tenantId: 'tenant-hardening-3',
      displayName: 'Hardening Model',
      integrationType: 'easy',
      temperature: 0.1,
      maxTokens: 1024,
      supportsTools: true,
      supportsStreaming: true,
      supportsVision: false,
      supportsStructured: true,
      tier: 'premium',
      createdBy: 'user-hardening-3',
      customHeaders,
    });

    const raw = await mongoose.connection.db.collection('tenant_models').findOne({ _id: doc._id });

    expect(raw?.customHeaders).not.toEqual(customHeaders);
  });

  it('backfills plaintext customHeaders and authConfig through the migration', async ({ skip }) => {
    requireMongo(skip);

    const db = mongoose.connection.db!;
    const llmCustomHeaders = { Authorization: 'Bearer legacy-llm-header' };
    const llmAuthConfig = {
      clientId: 'legacy-client',
      clientSecret: 'legacy-secret',
    };
    const workspaceCustomHeaders = { 'x-legacy-workspace': 'workspace-secret' };
    const tenantModelCustomHeaders = { Authorization: 'Bearer legacy-tenant-model-header' };

    await db.collection('llm_credentials').insertOne({
      _id: 'llm-legacy-1',
      credentialScope: 'tenant',
      ownerId: 'user-legacy-1',
      tenantId: 'tenant-legacy-1',
      provider: 'openai',
      name: 'legacy-credential',
      encryptedApiKey: 'sk-legacy-credential',
      encryptedEndpoint: 'https://api.openai.com/v1',
      customHeaders: llmCustomHeaders,
      authType: 'oauth2',
      authConfig: llmAuthConfig,
      isActive: true,
      isDefault: false,
      lastUsedAt: null,
      lastValidatedAt: null,
      _v: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('arch_workspace_configs').insertOne({
      _id: 'workspace-legacy-1',
      tenantId: 'tenant-legacy-2',
      modelId: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      tenantModelId: null,
      usePlatformCredits: true,
      maxTokensChat: 2048,
      maxTokensGenerate: 8192,
      temperature: 0.7,
      rateLimitRpm: 0,
      rateLimitRph: 0,
      systemPromptOverride: null,
      encryptedApiKey: 'sk-legacy-workspace',
      encryptedEndpoint: null,
      authProfileId: null,
      authType: 'api_key',
      customHeaders: workspaceCustomHeaders,
      hyperParameters: {},
      lastValidatedAt: null,
      _v: 1,
      isActive: true,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('tenant_models').insertOne({
      _id: 'tenant-model-legacy-1',
      tenantId: 'tenant-legacy-3',
      displayName: 'Legacy Tenant Model',
      integrationType: 'easy',
      modelId: 'gpt-4.1',
      provider: 'openai',
      endpointUrl: null,
      customEndpoint: null,
      providerStructure: null,
      requestTemplate: {},
      responseMapping: {},
      gatewayConfig: {},
      customHeaders: tenantModelCustomHeaders,
      temperature: 0.1,
      maxTokens: 1024,
      hyperParameters: {},
      supportsTools: true,
      supportsStreaming: true,
      supportsVision: false,
      supportsStructured: true,
      useResponsesApi: null,
      useStreaming: null,
      capabilities: ['text'],
      realtimeConfig: null,
      tier: 'premium',
      isDefault: false,
      isActive: true,
      inferenceEnabled: true,
      createdBy: 'user-legacy-3',
      connections: [],
      provisionedBy: null,
      provisionedAt: null,
      provisioningNote: null,
      _v: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await hardeningBackfillMigration.up(db);

    const [rawLLM, rawWorkspace, rawTenantModel] = await Promise.all([
      db.collection('llm_credentials').findOne({ _id: 'llm-legacy-1' }),
      db.collection('arch_workspace_configs').findOne({ _id: 'workspace-legacy-1' }),
      db.collection('tenant_models').findOne({ _id: 'tenant-model-legacy-1' }),
    ]);

    expect(typeof rawLLM?.customHeaders).toBe('string');
    expect(typeof rawLLM?.authConfig).toBe('string');
    expect(typeof rawWorkspace?.customHeaders).toBe('string');
    expect(typeof rawTenantModel?.customHeaders).toBe('string');
    expect(isAlreadyEncrypted(rawLLM?.customHeaders as string)).toBe(true);
    expect(isAlreadyEncrypted(rawLLM?.authConfig as string)).toBe(true);
    expect(isAlreadyEncrypted(rawWorkspace?.customHeaders as string)).toBe(true);
    expect(isAlreadyEncrypted(rawTenantModel?.customHeaders as string)).toBe(true);

    const { LLMCredential, ArchWorkspaceConfig, TenantModel } = await importModels();
    const [hydratedLLM, hydratedWorkspace, hydratedTenantModel] = await Promise.all([
      LLMCredential.findOne({ _id: 'llm-legacy-1', tenantId: 'tenant-legacy-1' }),
      ArchWorkspaceConfig.findOne({ _id: 'workspace-legacy-1', tenantId: 'tenant-legacy-2' }),
      TenantModel.findOne({ _id: 'tenant-model-legacy-1', tenantId: 'tenant-legacy-3' }),
    ]);

    expect(hydratedLLM?.customHeaders).toEqual(llmCustomHeaders);
    expect(hydratedLLM?.authConfig).toEqual(llmAuthConfig);
    expect(hydratedWorkspace?.customHeaders).toEqual(workspaceCustomHeaders);
    expect(hydratedTenantModel?.customHeaders).toEqual(tenantModelCustomHeaders);

    const validation = await hardeningBackfillMigration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toEqual({
      llmCredentialsRemaining: 0,
      archWorkspaceConfigsRemaining: 0,
      tenantModelsRemaining: 0,
    });
  });
});
