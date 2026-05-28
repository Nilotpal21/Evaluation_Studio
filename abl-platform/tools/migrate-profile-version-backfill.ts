#!/usr/bin/env npx tsx
/**
 * tools/migrate-profile-version-backfill.ts
 *
 * One-time idempotent backfill that ensures every existing `auth_profiles`
 * document has a `profileVersion` field set to 1. The field is introduced
 * by Phase 0.4 of the auth-profiles r2 implementation plan; once the
 * pre-save hook is shipping, every new write maintains the value, but old
 * documents need the field provisioned.
 *
 * The migration is non-reversible by design: once consumers start reading
 * `profileVersion` for cache-key composition (CK-1 contract), reverting the
 * value would invalidate every credential cache simultaneously. Use
 * `--dry-run` to preview affected document counts before executing.
 *
 * Usage:
 *   pnpm exec tsx tools/migrate-profile-version-backfill.ts --dry-run
 *   pnpm exec tsx tools/migrate-profile-version-backfill.ts
 *   pnpm exec tsx tools/migrate-profile-version-backfill.ts --limit 5000
 *
 * Environment:
 *   MONGODB_URI       — connection string (default: mongodb://localhost:27017/abl)
 *
 * Idempotency: the migration filter is `{ profileVersion: { $exists: false } }`,
 * so re-running on already-migrated data reports zero updates.
 */

import mongoose from 'mongoose';

interface CliOptions {
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--limit') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--limit requires an integer value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--limit value must be a positive integer (got ${next})`);
      }
      opts.limit = parsed;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log('Usage: tsx tools/migrate-profile-version-backfill.ts [--dry-run] [--limit N]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function emitLog(record: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

export async function runBackfill(options: CliOptions): Promise<{
  candidates: number;
  updated: number;
  durationMs: number;
}> {
  const start = Date.now();
  const filter = { profileVersion: { $exists: false } } as const;
  const collection = mongoose.connection.collection('auth_profiles');

  const candidates = await collection.countDocuments(filter);
  emitLog({
    migration: 'profile-version-backfill',
    action: 'count',
    candidates,
    dryRun: options.dryRun,
    limit: options.limit,
  });

  if (options.dryRun || candidates === 0) {
    return {
      candidates,
      updated: 0,
      durationMs: Date.now() - start,
    };
  }

  if (options.limit !== null) {
    const ids = await collection
      .find(filter, { projection: { _id: 1 } })
      .limit(options.limit)
      .toArray();
    if (ids.length === 0) {
      return { candidates, updated: 0, durationMs: Date.now() - start };
    }
    const result = await collection.updateMany(
      { _id: { $in: ids.map((d) => d._id) }, profileVersion: { $exists: false } },
      { $set: { profileVersion: 1 } },
    );
    emitLog({
      migration: 'profile-version-backfill',
      action: 'update',
      count: result.modifiedCount,
      durationMs: Date.now() - start,
      batched: true,
    });
    return {
      candidates,
      updated: result.modifiedCount,
      durationMs: Date.now() - start,
    };
  }

  const result = await collection.updateMany(filter, { $set: { profileVersion: 1 } });
  emitLog({
    migration: 'profile-version-backfill',
    action: 'update',
    count: result.modifiedCount,
    durationMs: Date.now() - start,
    batched: false,
  });
  return {
    candidates,
    updated: result.modifiedCount,
    durationMs: Date.now() - start,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/abl';

  await mongoose.connect(uri);
  try {
    const summary = await runBackfill(options);
    emitLog({
      migration: 'profile-version-backfill',
      action: 'summary',
      ...summary,
    });
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly = (() => {
  if (typeof require !== 'undefined' && require.main === module) {
    return true;
  }
  if (typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv[1]) {
    return process.argv[1].endsWith('migrate-profile-version-backfill.ts');
  }
  return false;
})();

if (invokedDirectly) {
  main().catch((err) => {
    emitLog({
      migration: 'profile-version-backfill',
      action: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
