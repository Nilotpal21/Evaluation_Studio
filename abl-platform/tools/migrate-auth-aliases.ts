#!/usr/bin/env npx tsx
/**
 * tools/migrate-auth-aliases.ts
 *
 * One-time inline-auth alias migration for `project_tools.dslContent`.
 *
 * Forward mode (default):
 *   oauth2_client -> oauth2_client_credentials
 *   oauth2_user   -> oauth2_token
 *   custom        -> custom_header
 *
 * Restore mode (`--restore`) re-applies legacy aliases.
 *
 * Usage:
 *   pnpm exec tsx tools/migrate-auth-aliases.ts --dry-run
 *   pnpm exec tsx tools/migrate-auth-aliases.ts
 *   pnpm exec tsx tools/migrate-auth-aliases.ts --restore
 *   pnpm exec tsx tools/migrate-auth-aliases.ts --limit 500
 *
 * Environment:
 *   MONGODB_URI — connection string (default: mongodb://localhost:27017/abl)
 */

import mongoose from 'mongoose';

interface CliOptions {
  dryRun: boolean;
  restore: boolean;
  limit: number | null;
}

interface MigrationSummary {
  mode: 'forward' | 'restore';
  candidates: number;
  updated: number;
  durationMs: number;
}

const FORWARD_REPLACEMENTS: Array<{ from: string; to: string }> = [
  { from: 'oauth2_client', to: 'oauth2_client_credentials' },
  { from: 'oauth2_user', to: 'oauth2_token' },
  { from: 'custom', to: 'custom_header' },
];

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, restore: false, limit: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--restore') {
      opts.restore = true;
      continue;
    }
    if (arg === '--limit') {
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
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log('Usage: tsx tools/migrate-auth-aliases.ts [--dry-run] [--restore] [--limit N]');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function emitLog(record: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

function applyAliasReplacements(
  dslContent: string,
  replacements: Array<{ from: string; to: string }>,
): string {
  let next = dslContent;
  for (const { from, to } of replacements) {
    const pattern = new RegExp(`(\\bauth\\s*:\\s*)${from}(\\b)`, 'g');
    next = next.replace(pattern, `$1${to}$2`);
  }
  return next;
}

function rewriteDslAuthAliases(dslContent: string, restore: boolean): string {
  const replacements = restore
    ? FORWARD_REPLACEMENTS.map(({ from, to }) => ({ from: to, to: from }))
    : FORWARD_REPLACEMENTS;
  return applyAliasReplacements(dslContent, replacements);
}

export async function runAuthAliasMigration(options: CliOptions): Promise<MigrationSummary> {
  const start = Date.now();
  const collection = mongoose.connection.collection('project_tools');

  const query: Record<string, unknown> = {};
  const projection = { projection: { _id: 1, dslContent: 1 } };
  const cursor =
    options.limit === null
      ? collection.find(query, projection)
      : collection.find(query, projection).limit(options.limit);

  const docs = await cursor.toArray();
  let candidates = 0;
  let updated = 0;

  for (const doc of docs) {
    const dslContent = typeof doc.dslContent === 'string' ? doc.dslContent : '';
    if (dslContent.length === 0) {
      continue;
    }

    const rewritten = rewriteDslAuthAliases(dslContent, options.restore);
    if (rewritten === dslContent) {
      continue;
    }

    candidates += 1;
    if (options.dryRun) {
      continue;
    }

    const result = await collection.updateOne(
      { _id: doc._id, dslContent },
      { $set: { dslContent: rewritten } },
    );
    if (result.modifiedCount > 0) {
      updated += 1;
    }
  }

  return {
    mode: options.restore ? 'restore' : 'forward',
    candidates,
    updated,
    durationMs: Date.now() - start,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/abl';

  await mongoose.connect(uri);
  try {
    const summary = await runAuthAliasMigration(options);
    emitLog({
      migration: 'auth-type-aliases',
      action: 'summary',
      dryRun: options.dryRun,
      limit: options.limit,
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
    return process.argv[1].endsWith('migrate-auth-aliases.ts');
  }
  return false;
})();

if (invokedDirectly) {
  main().catch((err) => {
    emitLog({
      migration: 'auth-type-aliases',
      action: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
