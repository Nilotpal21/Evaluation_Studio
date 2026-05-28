#!/usr/bin/env npx tsx
/**
 * tools/migrate-mcp-auth-profile-split.ts
 *
 * One-time migration for MCP server config auth split:
 * - forward mode: copies `authProfileId` -> `envProfileId` and clears `authProfileId`
 * - restore mode: copies `envProfileId` -> `authProfileId` and clears `envProfileId`
 *
 * Usage:
 *   pnpm exec tsx tools/migrate-mcp-auth-profile-split.ts --dry-run
 *   pnpm exec tsx tools/migrate-mcp-auth-profile-split.ts
 *   pnpm exec tsx tools/migrate-mcp-auth-profile-split.ts --limit 1000
 *   pnpm exec tsx tools/migrate-mcp-auth-profile-split.ts --restore
 *
 * Environment:
 *   MONGODB_URI — connection string (default: mongodb://localhost:27017/abl)
 */

import mongoose from 'mongoose';
import {
  runMcpAuthProfileSplitMigration,
  type McpAuthProfileSplitOptions,
} from '../packages/database/src/migrations/mcp-auth-profile-split.js';

interface CliOptions extends McpAuthProfileSplitOptions {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    restore: false,
    limit: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--restore') {
      options.restore = true;
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
      options.limit = parsed;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: tsx tools/migrate-mcp-auth-profile-split.ts [--dry-run] [--restore] [--limit N]',
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function emitLog(record: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/abl';

  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection is missing db handle');
    }
    const summary = await runMcpAuthProfileSplitMigration(db, options);

    emitLog({
      migration: 'mcp-auth-profile-split',
      action: 'summary',
      mode: summary.mode,
      dryRun: options.dryRun,
      limit: options.limit,
      candidates: summary.candidates,
      updated: summary.updated,
      durationMs: summary.durationMs,
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
    return process.argv[1].endsWith('migrate-mcp-auth-profile-split.ts');
  }
  return false;
})();

if (invokedDirectly) {
  main().catch((err) => {
    emitLog({
      migration: 'mcp-auth-profile-split',
      action: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
