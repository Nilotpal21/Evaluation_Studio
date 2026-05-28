/**
 * Seed the node_type_definitions collection with all platform-provided node types.
 *
 * Idempotent: uses bulkWrite with upsert so it can be run repeatedly.
 * Only updates SYSTEM-tenanted docs — tenant-specific overrides are untouched.
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { NodeTypeDefinitionModel } from '../schemas/node-type-definition.schema.js';
import type { NodeTypeDefinitionDoc } from './types.js';

/**
 * Resolve and load the seed data JSON.
 *
 * Looks for the JSON relative to the current file (works from both
 * src/pipeline/ during dev and dist/pipeline/ in production, provided
 * the build copies seed-data/ into dist/).
 */
async function loadSeedData(): Promise<NodeTypeDefinitionDoc[]> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const jsonPath = resolve(currentDir, 'seed-data', 'node-type-definitions.json');
  const raw = await readFile(jsonPath, 'utf-8');
  return JSON.parse(raw) as NodeTypeDefinitionDoc[];
}

export interface SeedResult {
  count: number;
}

export async function seedNodeTypes(): Promise<SeedResult> {
  const seedData = await loadSeedData();
  const seedIds = seedData.map((e) => e._id);

  const operations = seedData.map((entry) => ({
    updateOne: {
      filter: { _id: entry._id, tenantId: 'SYSTEM' },
      update: { $set: { ...entry, updatedAt: new Date() } },
      upsert: true,
    },
  }));

  await NodeTypeDefinitionModel.bulkWrite(operations);

  // Remove SYSTEM entries no longer present in seed data
  await NodeTypeDefinitionModel.deleteMany({
    tenantId: 'SYSTEM',
    _id: { $nin: seedIds },
  });

  return { count: operations.length };
}
