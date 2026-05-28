#!/usr/bin/env npx tsx
/**
 * Runner for the default variable namespaces migration.
 *
 * Usage:
 *   cd packages/database
 *   npx tsx src/migrations/run-default-variable-namespaces.ts
 *
 * Requires MONGODB_URI env var (or uses default dev URI).
 */

// Suppress auto-connect BEFORE any model imports happen.
process.env.MONGODB_MANAGED = 'true';

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/abl-platform';

async function main() {
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);
  console.log('Connected. Running migration...');

  const { migrateDefaultVariableNamespaces } = await import('./add-default-variable-namespaces.js');
  await migrateDefaultVariableNamespaces();

  console.log('Done. Disconnecting...');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
