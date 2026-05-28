/**
 * Migration: Scope agentPath Uniqueness to Project
 *
 * Changes the agentPath index from globally unique to project-scoped unique.
 * Before: { agentPath: 1 } unique — prevents different projects from sharing agent paths.
 * After: { projectId: 1, agentPath: 1 } unique — agent paths unique only within a project.
 *
 * Date: 2026-02-27
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

export const migration: Migration = {
  version: '20260227_005',
  description: 'Scope agentPath uniqueness to project instead of global',

  async up(db: Db) {
    const collection = db.collection('project_agents');

    // Step 1: Drop the old globally unique agentPath index
    try {
      await collection.dropIndex('agentPath_1');
      console.log('[migration] Dropped global agentPath_1 index');
    } catch (err: any) {
      // IndexNotFound is expected if migration was partially applied or index doesn't exist
      if (err.codeName === 'IndexNotFound' || err.code === 27) {
        console.log('[migration] agentPath_1 index not found — skipping drop');
      } else {
        throw err;
      }
    }

    // Step 2: Create the new project-scoped unique index
    await collection.createIndex(
      { projectId: 1, agentPath: 1 },
      { unique: true, name: 'projectId_1_agentPath_1' },
    );
    console.log('[migration] Created project-scoped projectId_1_agentPath_1 unique index');
  },

  async down(db: Db) {
    const collection = db.collection('project_agents');

    // Reverse: drop project-scoped index, restore global unique index
    try {
      await collection.dropIndex('projectId_1_agentPath_1');
      console.log('[migration] Dropped projectId_1_agentPath_1 index');
    } catch (err: any) {
      if (err.codeName === 'IndexNotFound' || err.code === 27) {
        console.log('[migration] projectId_1_agentPath_1 index not found — skipping drop');
      } else {
        throw err;
      }
    }

    await collection.createIndex({ agentPath: 1 }, { unique: true, name: 'agentPath_1' });
    console.log('[migration] Restored global agentPath_1 unique index');
  },

  async validate(db: Db) {
    const [
      newIndexPresent,
      supersedingTenantScopedUniqueIndexPresent,
      supersedingTenantScopedLookupIndexPresent,
      oldIndexPresent,
    ] = await Promise.all([
      hasIndex(
        db,
        'project_agents',
        { projectId: 1, agentPath: 1 },
        { unique: true, name: 'projectId_1_agentPath_1' },
      ),
      hasIndex(
        db,
        'project_agents',
        { tenantId: 1, projectId: 1, agentPath: 1 },
        { unique: true, name: 'tenantId_1_projectId_1_agentPath_1' },
      ),
      hasIndex(
        db,
        'project_agents',
        { tenantId: 1, projectId: 1, agentPath: 1 },
        {
          name: 'tenantId_1_projectId_1_agentPath_1',
        },
      ),
      hasIndex(db, 'project_agents', { agentPath: 1 }, { unique: true }),
    ]);

    if (
      (!newIndexPresent &&
        !supersedingTenantScopedUniqueIndexPresent &&
        !supersedingTenantScopedLookupIndexPresent) ||
      oldIndexPresent
    ) {
      return validationFailed(
        'agentPath index scoping does not match the expected post-migration state',
        {
          newIndexPresent,
          supersedingTenantScopedUniqueIndexPresent,
          supersedingTenantScopedLookupIndexPresent,
          oldIndexPresent,
        },
      );
    }

    return validationPassed(
      supersedingTenantScopedLookupIndexPresent && !supersedingTenantScopedUniqueIndexPresent
        ? 'agentPath is scoped to tenant/project as a non-unique lookup index'
        : supersedingTenantScopedUniqueIndexPresent
          ? 'agentPath uniqueness is scoped to superseding { tenantId, projectId, agentPath }'
          : 'agentPath uniqueness is scoped to { projectId, agentPath }',
      {
        newIndexPresent,
        supersedingTenantScopedUniqueIndexPresent,
        supersedingTenantScopedLookupIndexPresent,
        oldIndexPresent,
      },
    );
  },
};
