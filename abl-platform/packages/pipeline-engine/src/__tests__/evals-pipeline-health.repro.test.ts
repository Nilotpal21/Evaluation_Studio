/**
 * ABLP-1066 Reproduction Test — LLM Credential Resolution Fails in Evals Pipeline Health
 *
 * FAILS: reproduces ABLP-1066
 *
 * The preflight `llm_credentials` check calls `resolvePipelineLLM()` which
 * collapses 7+ distinct failure modes into a single generic error:
 *   "No LLM model available for tenant <id>. Configure a model..."
 *
 * This test seeds a tenant with a valid-looking TenantModel and LLMCredential
 * in MongoMemoryServer, then calls `runEvalPreflight(tenantId, projectId)`.
 *
 * Scenario A: A correctly configured tenant should yield `llm_credentials: pass`.
 *   Today this fails because the resolver cannot find or decrypt the credential
 *   in the test environment (reproducing the exact "No LLM model available" collapse).
 *
 * Scenario B: When the model exists but `inferenceEnabled: false`, the error
 *   message should indicate INFERENCE_DISABLED (not the generic message).
 *   Today it shows the generic "No LLM model available" for all failure modes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { runEvalPreflight } from '../pipeline/services/eval/eval-preflight.js';

let mongod: MongoMemoryServer | undefined;
let mongoReady = false;

const TEST_TENANT_ID = 'tenant-repro-1066';
const TEST_PROJECT_ID = 'project-repro-1066';
const TEST_CRED_ID = 'cred-repro-1066';
const TEST_USER_ID = 'user-repro-1066';
const TEST_TENANT_MODEL_ID = 'tm-repro-1066';
const TEST_MASTER_KEY = '761c4d78624f1b2be00917d14d721d1a581298f5fb2cf857675acc25a0e226e1';

// Save original env
const originalEnv = { ...process.env };

async function setupMongo() {
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: process.env.MONGOMS_VERSION ?? '7.0.20' },
    });
    await mongoose.connect(mongod.getUri(), {
      directConnection: true,
      serverSelectionTimeoutMS: 120_000,
    });
    await mongoose.connection.asPromise();

    const [{ setMasterKey }, { initDEKFacade }] = await Promise.all([
      import('@agent-platform/database/models'),
      import('@agent-platform/database/kms'),
    ]);
    setMasterKey(TEST_MASTER_KEY);
    await initDEKFacade({ masterKeyHex: TEST_MASTER_KEY });

    mongoReady = true;
  } catch {
    mongoReady = false;
  }
}

async function teardownMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
  const [
    { _resetEncryptionStateForTesting },
    { shutdownKMSRegistry, _resetKMSRegistryForTesting },
  ] = await Promise.all([
    import('@agent-platform/database/models'),
    import('@agent-platform/database/kms'),
  ]);
  await shutdownKMSRegistry().catch(() => undefined);
  _resetKMSRegistryForTesting();
  _resetEncryptionStateForTesting();
  mongod = undefined;
  mongoReady = false;
}

async function clearCollections() {
  if (!mongoReady) return;
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
}

beforeAll(async () => {
  // Set valid encryption key for crypto round-trip
  process.env['ENCRYPTION_MASTER_KEY'] = TEST_MASTER_KEY;
  process.env['JWT_SECRET'] = 'test-jwt-secret';
  process.env['EVAL_SERVICE_USER_ID'] = TEST_USER_ID;
  process.env['RUNTIME_URL'] = 'http://localhost:99999'; // non-routable (intentional)

  await setupMongo();
});

afterAll(async () => {
  await teardownMongo();
  process.env = { ...originalEnv };
});

/**
 * Seed a TenantModel with an active connection and LLMCredential.
 * This mirrors what a correctly configured tenant looks like in production.
 */
async function seedValidTenantConfig() {
  const { TenantModel, LLMCredential } = await import('@agent-platform/database/models');

  // Create LLM credential with a plain-text API key
  // (resolveTenantPlaintextValue returns plain text as-is when it doesn't look encrypted)
  await LLMCredential.create({
    _id: TEST_CRED_ID,
    credentialScope: 'tenant',
    ownerId: TEST_USER_ID,
    tenantId: TEST_TENANT_ID,
    provider: 'openai',
    name: 'Test OpenAI Key',
    encryptedApiKey: 'sk-test-1066-valid-key-for-repro',
    authType: 'api_key',
    isActive: true,
    isDefault: true,
  });

  // Create TenantModel with active connection referencing the credential
  await TenantModel.create({
    _id: TEST_TENANT_MODEL_ID,
    tenantId: TEST_TENANT_ID,
    displayName: 'GPT-4o Mini',
    integrationType: 'easy',
    modelId: 'gpt-4o-mini',
    provider: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsStructured: true,
    capabilities: ['chat'],
    tier: 'standard',
    isDefault: true,
    isActive: true,
    inferenceEnabled: true,
    createdBy: TEST_USER_ID,
    connections: [
      {
        id: 'conn-repro-1066',
        credentialId: TEST_CRED_ID,
        authProfileId: null,
        connectionType: 'http',
        isActive: true,
        isPrimary: true,
        lastHealthCheck: null,
        healthStatus: 'unchecked',
        healthMessage: null,
        createdBy: TEST_USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
}

/**
 * Seed a TenantModel that has `inferenceEnabled: false` — a common
 * misconfiguration that produces the generic "No LLM model available" error.
 */
async function seedInferenceDisabledConfig() {
  const { TenantModel, LLMCredential } = await import('@agent-platform/database/models');

  await LLMCredential.create({
    _id: 'cred-disabled-1066',
    credentialScope: 'tenant',
    ownerId: TEST_USER_ID,
    tenantId: 'tenant-disabled-1066',
    provider: 'anthropic',
    name: 'Test Anthropic Key',
    encryptedApiKey: 'sk-ant-disabled-1066-key',
    authType: 'api_key',
    isActive: true,
    isDefault: true,
  });

  await TenantModel.create({
    _id: 'tm-disabled-1066',
    tenantId: 'tenant-disabled-1066',
    displayName: 'Claude Sonnet',
    integrationType: 'easy',
    modelId: 'claude-sonnet-4-6-20260217',
    provider: 'anthropic',
    temperature: 0.7,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsStructured: true,
    capabilities: ['chat'],
    tier: 'standard',
    isDefault: true,
    isActive: true,
    // BUG TRIGGER: inferenceEnabled is false but the generic error doesn't tell the user
    inferenceEnabled: false,
    createdBy: TEST_USER_ID,
    connections: [
      {
        id: 'conn-disabled-1066',
        credentialId: 'cred-disabled-1066',
        authProfileId: null,
        connectionType: 'http',
        isActive: true,
        isPrimary: true,
        lastHealthCheck: null,
        healthStatus: 'unchecked',
        healthMessage: null,
        createdBy: TEST_USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });
}

describe('ABLP-1066: LLM credential resolution in eval preflight', () => {
  beforeEach(async () => {
    await clearCollections();
  });

  it('llm_credentials check passes when tenant has valid model + credential', async () => {
    if (!mongoReady) {
      throw new Error('MongoDB test harness unavailable for ABLP-1066 repro');
    }

    await seedValidTenantConfig();

    const result = await runEvalPreflight(TEST_TENANT_ID, TEST_PROJECT_ID);
    const credCheck = result.checks.find((c) => c.name === 'llm_credentials');

    expect(credCheck).toBeDefined();
    // FAILS: reproduces ABLP-1066 — even with valid config seeded, the resolution
    // chain may fail due to encryption plugin interactions or the resolver's
    // silent null-return pattern, producing:
    //   "LLM credential resolution failed: No LLM model available for tenant tenant-repro-1066."
    expect(credCheck!.status).toBe('pass');
    expect(credCheck!.message).toContain('resolved successfully');
  });

  it('provides a specific diagnostic when model has inferenceEnabled: false', async () => {
    if (!mongoReady) {
      throw new Error('MongoDB test harness unavailable for ABLP-1066 repro');
    }

    await seedInferenceDisabledConfig();

    const result = await runEvalPreflight('tenant-disabled-1066', TEST_PROJECT_ID);
    const credCheck = result.checks.find((c) => c.name === 'llm_credentials');

    expect(credCheck).toBeDefined();
    expect(credCheck!.status).toBe('fail');

    // FAILS: reproduces ABLP-1066 — the error message is the generic
    //   "No LLM model available for tenant tenant-disabled-1066"
    // instead of a specific diagnostic like "INFERENCE_DISABLED" or
    //   "Model 'claude-sonnet-4-6-20260217' exists but inference is disabled"
    //
    // The resolver silently returns null because TenantModel.findOne filters
    // `inferenceEnabled: true`, so the model with inferenceEnabled: false is
    // invisible. The user sees a generic "configure a model" message when the
    // real fix is to enable inference on the existing model.
    expect(credCheck!.code).toBe('INFERENCE_DISABLED');
    expect(credCheck!.message).not.toContain('No LLM model available');
    expect(credCheck!.message).not.toContain('tenant-disabled-1066');
    expect(credCheck!.message).toMatch(/inference|disabled|inactive/i);
  });

  it('overall preflight includes llm_credentials check for non-system tenant', async () => {
    if (!mongoReady) {
      throw new Error('MongoDB test harness unavailable for ABLP-1066 repro');
    }

    const result = await runEvalPreflight(TEST_TENANT_ID, TEST_PROJECT_ID);
    const checkNames = result.checks.map((c) => c.name);

    // Tenant-scoped preflight should include credential checks
    expect(checkNames).toContain('llm_credentials');
    expect(checkNames).toContain('provider_key_match');
  });
});
