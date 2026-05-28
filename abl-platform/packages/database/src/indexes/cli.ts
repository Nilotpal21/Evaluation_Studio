#!/usr/bin/env node
/**
 * Index Reconciliation CLI
 *
 * Usage:
 *   pnpm db:ensure-indexes
 *
 * Connects to MongoDB, compares declared indexes against existing ones,
 * creates missing indexes with background: true, and reports orphaned indexes.
 */

import mongoose from 'mongoose';
import { ensureIndexes, printIndexSummary } from './ensure-indexes.js';
import { resolveMongoCliConnection } from '../mongo/cli-connection.js';

async function main(): Promise<void> {
  const connection = resolveMongoCliConnection();

  console.log(`[IndexCLI] Connecting to ${connection.redactedTarget}...`);

  await mongoose.connect(connection.url, connection.options);
  console.log('[IndexCLI] Connected.\n');

  console.log('[IndexCLI] Reconciling indexes...');
  const results = await ensureIndexes();

  printIndexSummary(results);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('[IndexCLI] Fatal error:', error.message);
  process.exit(1);
});
