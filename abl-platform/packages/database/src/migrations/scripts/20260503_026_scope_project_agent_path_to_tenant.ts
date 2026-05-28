/**
 * Migration: tenant-scope ProjectAgent agentPath uniqueness.
 *
 * Canonicalizes historical path shapes to `projectId/name` and replaces the
 * tenant-blind unique index with `{ tenantId, projectId, agentPath }`.
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'project_agents';
const OLD_PROJECT_PATH_INDEX = 'projectId_1_agentPath_1';
const NEW_TENANT_PROJECT_PATH_INDEX = 'tenantId_1_projectId_1_agentPath_1';

export const migration: Migration = {
  version: '20260503_026',
  description: 'Tenant-scope project_agents agentPath uniqueness and canonicalize paths',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);

    try {
      await collection.dropIndex(OLD_PROJECT_PATH_INDEX);
      console.log(`[migration] Dropped ${OLD_PROJECT_PATH_INDEX}`);
    } catch (err: any) {
      if (err.codeName !== 'IndexNotFound' && err.code !== 27) {
        throw err;
      }
      console.log(`[migration] ${OLD_PROJECT_PATH_INDEX} not found; skipping drop`);
    }

    const agents = await collection
      .find({}, { projection: { _id: 1, projectId: 1, name: 1, agentPath: 1 } })
      .toArray();

    const pathOps = agents.flatMap((agent) => {
      if (!agent.projectId || !agent.name) return [];
      const canonicalPath = `${String(agent.projectId).trim()}/${String(agent.name).trim()}`;
      if (agent.agentPath === canonicalPath) return [];
      return [
        {
          updateOne: {
            filter: { _id: agent._id },
            update: { $set: { agentPath: canonicalPath } },
          },
        },
      ];
    });

    if (pathOps.length > 0) {
      await collection.bulkWrite(pathOps);
    }
    console.log(`[migration] Canonicalized ${pathOps.length} project agent paths`);

    await collection.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { unique: true, name: NEW_TENANT_PROJECT_PATH_INDEX },
    );
    console.log(`[migration] Created ${NEW_TENANT_PROJECT_PATH_INDEX}`);
  },

  async down() {
    console.log(
      '[migration] Rollback is a no-op because recreating tenant-blind ProjectAgent agentPath indexes would reintroduce cross-tenant collision risk',
    );
  },

  async validate(db: Db) {
    const collection = db.collection(COLLECTION);
    const [uniqueIndexPresent, lookupIndexPresent, oldIndexPresent, nonCanonicalPaths] =
      await Promise.all([
        hasIndex(
          db,
          COLLECTION,
          { tenantId: 1, projectId: 1, agentPath: 1 },
          { unique: true, name: NEW_TENANT_PROJECT_PATH_INDEX },
        ),
        hasIndex(
          db,
          COLLECTION,
          { tenantId: 1, projectId: 1, agentPath: 1 },
          {
            name: NEW_TENANT_PROJECT_PATH_INDEX,
          },
        ),
        hasIndex(db, COLLECTION, { projectId: 1, agentPath: 1 }, { unique: true }),
        collection.countDocuments({
          $expr: {
            $ne: ['$agentPath', { $concat: ['$projectId', '/', '$name'] }],
          },
        }),
      ]);

    if (!lookupIndexPresent || oldIndexPresent || nonCanonicalPaths > 0) {
      return validationFailed(
        'project_agents agentPath canonicalization or tenant-scoped lookup index is incomplete',
        {
          uniqueIndexPresent,
          lookupIndexPresent,
          oldIndexPresent,
          nonCanonicalPaths,
        },
      );
    }

    return validationPassed('project_agents agentPath is canonical and tenant-scoped', {
      uniqueIndexPresent,
      lookupIndexPresent,
      oldIndexPresent,
      nonCanonicalPaths,
    });
  },
};

export default migration;
