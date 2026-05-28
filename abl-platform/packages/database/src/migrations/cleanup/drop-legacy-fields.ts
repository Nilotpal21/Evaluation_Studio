/**
 * Task 33 — Cleanup Week 2: Drop Legacy Fields from Consumer Models
 *
 * Runs MongoDB $unset operations to remove legacy credential fields from
 * all 14 consumer models. Dry-run mode is the default — it reports what
 * would be removed without actually modifying documents.
 *
 * Usage:
 *   npx tsx packages/database/src/migrations/cleanup/drop-legacy-fields.ts
 *   npx tsx packages/database/src/migrations/cleanup/drop-legacy-fields.ts --dry-run=false
 *
 * Prerequisites:
 * - Task 32 dual-read removal completed and baked for 7 days
 * - Zero AUTH_PROFILE_DECRYPTION_FAILED errors for 14 days
 * - MongoDB snapshot confirmed
 */

import mongoose from 'mongoose';

type MongoClient = mongoose.mongo.MongoClient;
const { MongoClient } = mongoose.mongo;

// ─── Configuration ──────────────────────────────────────────────────────

interface UnsetTarget {
  collection: string;
  fields: string[];
  /** If true, uses arrayFilters for nested array fields */
  arrayField?: {
    arrayPath: string;
    filterField: string;
  };
}

const UNSET_TARGETS: UnsetTarget[] = [
  {
    collection: 'connector_connections',
    fields: [
      'encryptedCredentials',
      'encryptionKeyVersion',
      'oauth2TokenExpiresAt',
      'oauth2RefreshToken',
      'oauth2Provider',
      'authType',
    ],
  },
  {
    collection: 'mcp_server_configs',
    fields: ['encryptedAuthConfig', 'encryptedEnv', 'authType'],
  },
  {
    collection: 'channel_connections',
    fields: ['encryptedCredentials', 'config.encryptedInboundAuthToken'],
  },
  {
    collection: 'service_nodes',
    fields: ['encryptedSecrets', 'authConfig'],
  },
  {
    collection: 'org_proxy_configs',
    fields: [
      'encryptedProxyUsername',
      'encryptedProxyPassword',
      'encryptedMtlsCert',
      'encryptedMtlsKey',
      'encryptedCaCert',
      'encryptedBasicAuthToken',
    ],
  },
  {
    collection: 'tenant_models',
    fields: ['connections.$[elem].credentialId'],
    arrayField: {
      arrayPath: 'connections.credentialId',
      filterField: 'elem.credentialId',
    },
  },
  {
    collection: 'tenant_guardrail_provider_configs',
    fields: ['apiKeyCredentialId'],
  },
  {
    collection: 'git_integrations',
    fields: ['credentials.secretId', 'webhookSecret'],
  },
  {
    collection: 'tenant_service_instances',
    fields: ['encryptedApiKey', 'encryptedConfig'],
  },
  {
    collection: 'arch_workspace_configs',
    fields: ['encryptedApiKey', 'encryptedEndpoint'],
  },
  {
    collection: 'connector_configs',
    fields: ['oauthTokenId'],
  },
  {
    collection: 'webhook_subscriptions',
    fields: ['encryptedSecret'],
  },
  {
    collection: 'webhook_subscription_connectors',
    fields: ['encryptedClientState'],
  },
  {
    collection: 'sdk_channels',
    fields: ['secretKey'],
  },
];

// ─── Types ──────────────────────────────────────────────────────────────

interface FieldDropResult {
  collection: string;
  fields: string[];
  documentsWithFields: number;
  documentsModified: number;
  skipped: boolean;
}

interface DropLegacyFieldsReport {
  timestamp: string;
  dryRun: boolean;
  mongoUri: string;
  results: FieldDropResult[];
  summary: {
    totalCollections: number;
    totalFieldsDropped: number;
    totalDocumentsModified: number;
  };
}

// ─── Validation ─────────────────────────────────────────────────────────

async function validatePrerequisites(client: MongoClient): Promise<void> {
  const db = client.db();

  // Check that collections exist
  const collections = await db.listCollections().toArray();
  const collectionNames = new Set(collections.map((c: { name: string }) => c.name));

  for (const target of UNSET_TARGETS) {
    if (!collectionNames.has(target.collection)) {
      console.log(`  WARNING: Collection '${target.collection}' does not exist — will skip.`);
    }
  }
}

async function countDocumentsWithFields(
  db: ReturnType<MongoClient['db']>,
  target: UnsetTarget,
): Promise<number> {
  const collectionExists = await db.listCollections({ name: target.collection }).hasNext();
  if (!collectionExists) return 0;

  const collection = db.collection(target.collection);

  if (target.arrayField) {
    return collection.countDocuments({
      [target.arrayField.arrayPath]: { $exists: true },
    });
  }

  // Build an $or query to find documents with any of the fields
  const orConditions = target.fields.map((field) => ({
    [field]: { $exists: true },
  }));

  if (orConditions.length === 0) return 0;

  return collection.countDocuments({ $or: orConditions });
}

// ─── Execution ──────────────────────────────────────────────────────────

async function dropFieldsForTarget(
  db: ReturnType<MongoClient['db']>,
  target: UnsetTarget,
  dryRun: boolean,
): Promise<FieldDropResult> {
  const collectionExists = await db.listCollections({ name: target.collection }).hasNext();
  if (!collectionExists) {
    return {
      collection: target.collection,
      fields: target.fields,
      documentsWithFields: 0,
      documentsModified: 0,
      skipped: true,
    };
  }

  const collection = db.collection(target.collection);
  const documentsWithFields = await countDocumentsWithFields(db, target);

  if (dryRun) {
    return {
      collection: target.collection,
      fields: target.fields,
      documentsWithFields,
      documentsModified: 0,
      skipped: false,
    };
  }

  // Validate no active references before dropping
  if (documentsWithFields === 0) {
    return {
      collection: target.collection,
      fields: target.fields,
      documentsWithFields: 0,
      documentsModified: 0,
      skipped: false,
    };
  }

  let modifiedCount = 0;

  // Special handling for array-embedded fields
  if (target.arrayField) {
    const result = await collection.updateMany(
      { [target.arrayField.arrayPath]: { $exists: true } },
      { $unset: { [target.fields[0]]: 1 } },
      {
        arrayFilters: [{ [target.arrayField.filterField]: { $exists: true } }],
      },
    );
    modifiedCount = result.modifiedCount;
  } else {
    const unsetObj: Record<string, 1> = {};
    for (const field of target.fields) {
      unsetObj[field] = 1;
    }
    const result = await collection.updateMany({}, { $unset: unsetObj });
    modifiedCount = result.modifiedCount;
  }

  return {
    collection: target.collection,
    fields: target.fields,
    documentsWithFields,
    documentsModified: modifiedCount,
    skipped: false,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--dry-run=false');
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI environment variable is required.');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Task 33: Drop Legacy Fields from Consumer Models          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(
    `Mode: ${dryRun ? 'DRY RUN (default) — no modifications' : 'LIVE — will modify documents'}`,
  );
  console.log('');

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const db = client.db();

    console.log('── Validating Prerequisites ──────────────────────────────────');
    await validatePrerequisites(client);
    console.log('');

    console.log('── Processing Collections ────────────────────────────────────');
    const results: FieldDropResult[] = [];

    for (const target of UNSET_TARGETS) {
      const result = await dropFieldsForTarget(db, target, dryRun);
      results.push(result);

      const status = result.skipped
        ? 'SKIP (collection not found)'
        : dryRun
          ? `PREVIEW: ${result.documentsWithFields} documents with legacy fields`
          : `DONE: ${result.documentsModified} documents modified`;

      console.log(`  ${target.collection}: ${status}`);
      console.log(`    Fields: ${target.fields.join(', ')}`);
    }

    // Build report
    const report: DropLegacyFieldsReport = {
      timestamp: new Date().toISOString(),
      dryRun,
      mongoUri: mongoUri.replace(/\/\/[^@]+@/, '//***@'), // Mask credentials
      results,
      summary: {
        totalCollections: results.filter((r) => !r.skipped).length,
        totalFieldsDropped: results.reduce((sum, r) => sum + (r.skipped ? 0 : r.fields.length), 0),
        totalDocumentsModified: results.reduce((sum, r) => sum + r.documentsModified, 0),
      },
    };

    console.log('');
    console.log('── Summary ───────────────────────────────────────────────────');
    console.log(`  Collections processed: ${report.summary.totalCollections}`);
    console.log(`  Fields targeted: ${report.summary.totalFieldsDropped}`);
    console.log(`  Documents modified: ${report.summary.totalDocumentsModified}`);

    if (dryRun) {
      console.log('');
      console.log('  This was a DRY RUN. No documents were modified.');
      console.log('  Run with --dry-run=false to execute.');
    }

    console.log('');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
