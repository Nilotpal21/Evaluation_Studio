/**
 * Migration: replace legacy tenant-wide GuardrailPolicy name uniqueness.
 *
 * Guardrail policies are portable project resources. The legacy unique index on
 * `{ tenantId, name, scope.type }` blocks importing the same project-scoped
 * policy name into two projects under one tenant. Keep uniqueness scoped to the
 * effective guardrail scope instead.
 */

import type mongoose from 'mongoose';
import {
  GUARDRAIL_POLICY_COLLECTION,
  SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY,
  SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME,
  findLegacyGuardrailPolicyUniqueIndexes,
  reconcileGuardrailPolicyUniqueIndexes,
} from '../../mongo/guardrail-policy-index-repair.js';
import type { Migration } from '../types.js';
import { collectionExists, hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

async function findLegacyUniqueIndexes(db: Db): Promise<string[]> {
  if (!(await collectionExists(db, GUARDRAIL_POLICY_COLLECTION))) {
    return [];
  }

  return findLegacyGuardrailPolicyUniqueIndexes(db);
}

export const migration: Migration = {
  version: '20260510_031',
  description: 'Fix GuardrailPolicy uniqueness to include project and agent scope',
  transactionMode: 'none',

  async up(db: Db) {
    const result = await reconcileGuardrailPolicyUniqueIndexes(db);
    console.log(`[migration] Ensured ${result.scopedIndexName}`);

    for (const indexName of result.droppedLegacyIndexes) {
      console.log(`[migration] Dropped legacy GuardrailPolicy unique index ${indexName}`);
    }
  },

  async down(db: Db) {
    void db;
    console.log(
      '[migration] Rollback intentionally does not recreate legacy GuardrailPolicy tenant-wide uniqueness',
    );
  },

  async validate(db: Db) {
    const [scopedIndexPresent, legacyUniqueIndexes] = await Promise.all([
      hasIndex(db, GUARDRAIL_POLICY_COLLECTION, SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY, {
        unique: true,
        name: SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME,
      }),
      findLegacyUniqueIndexes(db),
    ]);

    if (!scopedIndexPresent || legacyUniqueIndexes.length > 0) {
      return validationFailed(
        'guardrail_policies uniqueness is still tenant-wide or missing the scoped replacement',
        {
          scopedIndexPresent,
          legacyUniqueIndexes,
        },
      );
    }

    return validationPassed('guardrail_policies uniqueness includes project and agent scope', {
      scopedIndexPresent,
      legacyUniqueIndexes,
    });
  },
};

export default migration;
