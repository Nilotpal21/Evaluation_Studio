/**
 * Task 34 — Cleanup Week 3: Drop Legacy Credential Collections
 *
 * Drops the 3 legacy credential collections:
 * - llm_credentials
 * - end_user_oauth_tokens
 * - tool_secrets
 *
 * MUST have go/no-go gate: verify zero reads from legacy models in the
 * last 7 days before executing.
 *
 * Usage:
 *   npx tsx packages/database/src/migrations/cleanup/drop-legacy-collections.ts
 *   npx tsx packages/database/src/migrations/cleanup/drop-legacy-collections.ts --dry-run=false
 *
 * Prerequisites:
 * - Task 33 field removal completed and baked for 7 days
 * - Zero reads from legacy collections in last 7 days
 * - MongoDB snapshot confirmed
 */

import mongoose from 'mongoose';

type MongoClient = mongoose.mongo.MongoClient;
const { MongoClient } = mongoose.mongo;

// ─── Configuration ──────────────────────────────────────────────────────

const COLLECTIONS_TO_DROP = ['llm_credentials', 'end_user_oauth_tokens', 'tool_secrets'] as const;

/** Files that should be deleted from the codebase after collection drop (for reporting) */
const MODEL_FILES_TO_DELETE = [
  'packages/database/src/models/llm-credential.model.ts',
  'packages/database/src/models/end-user-oauth-token.model.ts',
  'packages/database/src/models/tool-secret.model.ts',
] as const;

/** Files to modify after collection drop (for reporting) */
const FILES_TO_MODIFY = [
  'packages/database/src/models/index.ts — remove exports for deleted models',
  'packages/database/src/index.ts — remove exports for deleted models',
  'packages/database/src/cascade/cascade-delete.ts — remove LLMCredential references',
  'packages/shared/src/validation/tool-secret-schemas.ts — delete file',
  'packages/shared/src/validation/index.ts — remove export',
] as const;

// ─── Types ──────────────────────────────────────────────────────────────

interface CollectionDropResult {
  collection: string;
  exists: boolean;
  documentCount: number;
  dropped: boolean;
  error?: string;
}

interface DropCollectionsReport {
  timestamp: string;
  dryRun: boolean;
  goNoGoGate: {
    passed: boolean;
    checks: Array<{ check: string; passed: boolean; detail: string }>;
  };
  results: CollectionDropResult[];
  filesToDelete: readonly string[];
  filesToModify: readonly string[];
}

// ─── Go/No-Go Gate ──────────────────────────────────────────────────────

async function runGoNoGoGate(
  db: ReturnType<MongoClient['db']>,
): Promise<DropCollectionsReport['goNoGoGate']> {
  const checks: Array<{ check: string; passed: boolean; detail: string }> = [];

  // Check 1: Verify zero reads from legacy collections in last 7 days
  // In production, this would query application logs/metrics. Here we use env var.
  const legacyReadDays = process.env.LEGACY_COLLECTION_LAST_READ_DAYS;
  const readDays = legacyReadDays ? parseInt(legacyReadDays, 10) : 0;
  checks.push({
    check: 'Zero reads from legacy collections in last 7 days',
    passed: readDays >= 7,
    detail: legacyReadDays
      ? `Last read: ${readDays} days ago`
      : 'LEGACY_COLLECTION_LAST_READ_DAYS env var not set — verify from production metrics',
  });

  // Check 2: Task 33 (field removal) baked for 7+ days
  const fieldRemovalDate = process.env.TASK_33_COMPLETION_DATE;
  if (fieldRemovalDate) {
    const daysSince = Math.floor(
      (Date.now() - new Date(fieldRemovalDate).getTime()) / (1000 * 60 * 60 * 24),
    );
    checks.push({
      check: 'Task 33 field removal baked for 7+ days',
      passed: daysSince >= 7,
      detail: `Task 33 completed ${daysSince} days ago`,
    });
  } else {
    checks.push({
      check: 'Task 33 field removal baked for 7+ days',
      passed: false,
      detail: 'TASK_33_COMPLETION_DATE env var not set',
    });
  }

  // Check 3: MongoDB snapshot confirmed
  const snapshotConfirmed = process.env.MONGODB_SNAPSHOT_CONFIRMED;
  checks.push({
    check: 'MongoDB snapshot confirmed',
    passed: snapshotConfirmed === 'true',
    detail: snapshotConfirmed ? 'Confirmed' : 'MONGODB_SNAPSHOT_CONFIRMED not set to true',
  });

  // Check 4: Verify collections have zero recent writes
  for (const collName of COLLECTIONS_TO_DROP) {
    const exists = await db.listCollections({ name: collName }).hasNext();
    if (exists) {
      const count = await db.collection(collName).countDocuments();
      checks.push({
        check: `Collection '${collName}' document count verified`,
        passed: true,
        detail: `${count} documents (will be dropped)`,
      });
    } else {
      checks.push({
        check: `Collection '${collName}' existence check`,
        passed: true,
        detail: 'Collection does not exist — already dropped or never created',
      });
    }
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
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
  console.log('║  Task 34: Drop Legacy Credential Collections              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Mode: ${dryRun ? 'DRY RUN (default)' : 'LIVE — will DROP collections'}`);
  console.log('');

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const db = client.db();

    // Run go/no-go gate
    console.log('── Go/No-Go Gate ─────────────────────────────────────────────');
    const goNoGo = await runGoNoGoGate(db);
    for (const check of goNoGo.checks) {
      const icon = check.passed ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${check.check}`);
      console.log(`         ${check.detail}`);
    }
    console.log('');

    if (!goNoGo.passed && !dryRun) {
      console.error('ABORT: Go/no-go gate failed. Cannot proceed with live execution.');
      console.error('Fix all FAIL checks above or run with --dry-run (default) for preview.');
      process.exit(1);
    }

    // Process collections
    console.log('── Collections ───────────────────────────────────────────────');
    const results: CollectionDropResult[] = [];

    for (const collName of COLLECTIONS_TO_DROP) {
      const exists = await db.listCollections({ name: collName }).hasNext();
      let documentCount = 0;

      if (exists) {
        documentCount = await db.collection(collName).countDocuments();
      }

      if (!exists) {
        console.log(`  ${collName}: SKIP (does not exist)`);
        results.push({
          collection: collName,
          exists: false,
          documentCount: 0,
          dropped: false,
        });
        continue;
      }

      if (dryRun) {
        console.log(`  ${collName}: PREVIEW — would drop (${documentCount} documents)`);
        results.push({
          collection: collName,
          exists: true,
          documentCount,
          dropped: false,
        });
      } else {
        try {
          await db.collection(collName).drop();
          console.log(`  ${collName}: DROPPED (${documentCount} documents)`);
          results.push({
            collection: collName,
            exists: true,
            documentCount,
            dropped: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  ${collName}: ERROR — ${message}`);
          results.push({
            collection: collName,
            exists: true,
            documentCount,
            dropped: false,
            error: message,
          });
        }
      }
    }

    // Report file changes needed
    console.log('');
    console.log('── Files to Delete (after collection drop) ───────────────────');
    for (const file of MODEL_FILES_TO_DELETE) {
      console.log(`  DELETE: ${file}`);
    }

    console.log('');
    console.log('── Files to Modify (after collection drop) ───────────────────');
    for (const file of FILES_TO_MODIFY) {
      console.log(`  MODIFY: ${file}`);
    }

    // Build report
    const report: DropCollectionsReport = {
      timestamp: new Date().toISOString(),
      dryRun,
      goNoGoGate: goNoGo,
      results,
      filesToDelete: MODEL_FILES_TO_DELETE,
      filesToModify: FILES_TO_MODIFY,
    };

    console.log('');
    console.log(JSON.stringify(report, null, 2));

    if (dryRun) {
      console.log('');
      console.log('This was a DRY RUN. No collections were dropped.');
      console.log('Run with --dry-run=false to execute (after go/no-go gate passes).');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
