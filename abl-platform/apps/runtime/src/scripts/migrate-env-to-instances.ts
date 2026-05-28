/**
 * Migration Script: Environment Variables → Tenant Model/Service Instances
 *
 * One-time script that reads existing env-var-based API keys and creates
 * corresponding TenantModel, TenantModelConnection, and TenantServiceInstance
 * records on the platform tenant.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-env-to-instances.ts [--dry-run] [--tenant-id <id>]
 */

import mongoose from 'mongoose';
import { isTenantEncryptionReady, encryptForTenantAuto } from '@agent-platform/shared/encryption';
/** Default tenant ID for migration (formerly PLATFORM_TENANT_ID). */
const DEFAULT_MIGRATION_TENANT_ID = 'platform';

interface MigrationResult {
  tenantModels: string[];
  connections: string[];
  serviceInstances: string[];
  errors: string[];
}

async function migrate(options: {
  dryRun: boolean;
  tenantId: string;
  userId: string;
}): Promise<MigrationResult> {
  const { dryRun, tenantId, userId } = options;
  const result: MigrationResult = {
    tenantModels: [],
    connections: [],
    serviceInstances: [],
    errors: [],
  };

  if (!isTenantEncryptionReady()) {
    result.errors.push('Tenant DEK encryption is not initialized.');
    return result;
  }

  // Dynamic import models
  const { Tenant, TenantModel, TenantServiceInstance } =
    await import('@agent-platform/database/models');

  // Ensure tenant exists
  const tenant = await Tenant.findOne({ _id: tenantId }).lean();
  if (!tenant) {
    result.errors.push(`Tenant '${tenantId}' not found. Create it first.`);
    return result;
  }

  // ==========================================================================
  // LLM API Keys → TenantModel + TenantModelConnection
  // ==========================================================================

  const llmConfigs = [
    {
      envKey: 'ANTHROPIC_API_KEY',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      displayName: 'Claude Sonnet (Migrated)',
      tier: 'balanced',
    },
    {
      envKey: 'OPENAI_API_KEY',
      provider: 'openai',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o (Migrated)',
      tier: 'balanced',
    },
    {
      envKey: 'GEMINI_API_KEY',
      provider: 'gemini',
      modelId: 'gemini-1.5-pro',
      displayName: 'Gemini 1.5 Pro (Migrated)',
      tier: 'balanced',
    },
  ];

  for (const cfg of llmConfigs) {
    const apiKey = process.env[cfg.envKey];
    if (!apiKey) continue;

    console.log(`  Found ${cfg.envKey} → creating TenantModel: ${cfg.displayName}`);

    if (dryRun) {
      result.tenantModels.push(`[DRY RUN] ${cfg.displayName}`);
      result.connections.push(`[DRY RUN] ${cfg.displayName} - Primary Key`);
      continue;
    }

    try {
      // Check if already exists
      const existing = await TenantModel.findOne({ tenantId, displayName: cfg.displayName }).lean();
      if (existing) {
        console.log(`    Already exists, skipping: ${cfg.displayName}`);
        continue;
      }

      // Create TenantModel
      const model = await TenantModel.create({
        tenantId,
        displayName: cfg.displayName,
        integrationType: 'easy',
        modelId: cfg.modelId,
        provider: cfg.provider,
        tier: cfg.tier,
        isDefault: true,
        createdBy: userId,
      });
      result.tenantModels.push(cfg.displayName);

      // Add connection as embedded subdocument on TenantModel
      const encryptedKey = await encryptForTenantAuto(apiKey, tenantId);
      await TenantModel.findOneAndUpdate(
        { _id: model._id },
        {
          $push: {
            connections: {
              id: `conn-${model._id}-primary`,
              connectionName: 'Migrated Key',
              encryptedApiKey: encryptedKey,
              authType: 'api_key',
              authConfig: {},
              isActive: true,
              isPrimary: true,
              createdBy: userId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        },
      );
      result.connections.push(`${cfg.displayName} - Migrated Key`);
    } catch (err) {
      result.errors.push(
        `Failed to migrate ${cfg.envKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ==========================================================================
  // Voice API Keys → TenantServiceInstance
  // ==========================================================================

  const voiceConfigs = [
    {
      envKey: 'DEEPGRAM_API_KEY',
      serviceType: 'deepgram',
      displayName: 'Deepgram (Migrated)',
      configKeys: ['DEEPGRAM_MODEL'],
      buildConfig: () => ({
        model: process.env.DEEPGRAM_MODEL || 'nova-2',
      }),
    },
    {
      envKey: 'ELEVENLABS_API_KEY',
      serviceType: 'elevenlabs',
      displayName: 'ElevenLabs (Migrated)',
      configKeys: ['ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL'],
      buildConfig: () => ({
        voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
        model: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      }),
    },
    {
      envKey: 'TWILIO_ACCOUNT_SID',
      serviceType: 'twilio',
      displayName: 'Twilio (Migrated)',
      configKeys: [],
      buildConfig: () => ({
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        apiKeySid: process.env.TWILIO_API_KEY_SID || process.env.TWILIO_API_KEY,
        apiKeySecret: process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_API_SECRET,
        twimlAppSid: process.env.TWILIO_TWIML_APP_SID,
      }),
    },
  ];

  for (const cfg of voiceConfigs) {
    const apiKey = process.env[cfg.envKey];
    if (!apiKey) continue;

    console.log(`  Found ${cfg.envKey} → creating TenantServiceInstance: ${cfg.displayName}`);

    if (dryRun) {
      result.serviceInstances.push(`[DRY RUN] ${cfg.displayName}`);
      continue;
    }

    try {
      const existing = await TenantServiceInstance.findOne({
        tenantId,
        serviceType: cfg.serviceType,
        displayName: cfg.displayName,
      }).lean();

      if (existing) {
        console.log(`    Already exists, skipping: ${cfg.displayName}`);
        continue;
      }

      // For Twilio, the "API key" is the account SID; actual auth is in config
      const keyToEncrypt =
        cfg.serviceType === 'twilio' ? process.env.TWILIO_AUTH_TOKEN || apiKey : apiKey;

      const config = cfg.buildConfig();

      // Pass plaintext values — the encryption plugin's pre-save hook on
      // TenantServiceInstance will encrypt encryptedApiKey and encryptedConfig
      // automatically. Manually calling encryptForTenant() here would cause
      // double encryption.
      await TenantServiceInstance.create({
        tenantId,
        displayName: cfg.displayName,
        serviceType: cfg.serviceType,
        encryptedApiKey: keyToEncrypt,
        encryptedConfig: JSON.stringify(config),
        isDefault: true,
        createdBy: userId,
      });
      result.serviceInstances.push(cfg.displayName);
    } catch (err) {
      result.errors.push(
        `Failed to migrate ${cfg.envKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// =============================================================================
// CLI ENTRY
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tenantIdIdx = args.indexOf('--tenant-id');
  const tenantId = tenantIdIdx >= 0 ? args[tenantIdIdx + 1] : DEFAULT_MIGRATION_TENANT_ID;
  const userIdIdx = args.indexOf('--user-id');
  const userId = userIdIdx >= 0 ? args[userIdIdx + 1] : 'migration-script';

  // Connect to MongoDB
  const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017/abl_platform';
  await mongoose.connect(mongoUrl);

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for tenant encryption migration.');
  }

  const { initDEKFacade } = await import('@agent-platform/database/kms');
  const dek = await initDEKFacade({ masterKeyHex: masterKey });
  if (!dek) {
    throw new Error('Failed to initialize tenant DEK facade for migration.');
  }

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Migrate Environment Variables → Tenant Instances     ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`  Tenant ID: ${tenantId}`);
  console.log(`  Dry Run:   ${dryRun}`);
  console.log('');

  try {
    const result = await migrate({ dryRun, tenantId, userId });

    console.log('\n── Summary ──────────────────────────────────');
    console.log(`  Tenant Models:      ${result.tenantModels.length}`);
    result.tenantModels.forEach((m) => console.log(`    ✓ ${m}`));
    console.log(`  Connections:        ${result.connections.length}`);
    result.connections.forEach((c) => console.log(`    ✓ ${c}`));
    console.log(`  Service Instances:  ${result.serviceInstances.length}`);
    result.serviceInstances.forEach((s) => console.log(`    ✓ ${s}`));

    if (result.errors.length > 0) {
      console.log(`  Errors:             ${result.errors.length}`);
      result.errors.forEach((e) => console.log(`    ✗ ${e}`));
    }

    console.log('─────────────────────────────────────────────');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
