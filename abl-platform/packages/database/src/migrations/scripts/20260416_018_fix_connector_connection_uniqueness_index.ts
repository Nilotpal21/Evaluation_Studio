/**
 * Migration: fix ConnectorConnection uniqueness index after auth-profile refactor
 *
 * ConnectorConnection originally enforced uniqueness with legacy indexes keyed by
 * scope/userId. The auth-profile refactor changed the desired uniqueness contract
 * to `{ tenantId, projectId, connectorName, authProfileId }`, but environments
 * that never dropped the old indexes still reject valid second connections,
 * including Agent Transfer SmartAssist connections in other projects.
 *
 * Fix: drop both legacy unique indexes and ensure the authProfileId-based index exists.
 *
 * Date: 2026-04-16
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';
import { reconcileConnectorConnectionIndexes } from '../../mongo/connector-connection-index-repair.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'connector_connections';
const CURRENT_INDEX_NAME = 'tenantId_1_projectId_1_connectorName_1_authProfileId_1';
const CURRENT_INDEX_KEY = {
  tenantId: 1,
  projectId: 1,
  connectorName: 1,
  authProfileId: 1,
} as const;
const LEGACY_TENANT_INDEX_KEY = {
  tenantId: 1,
  connectorName: 1,
  scope: 1,
  userId: 1,
} as const;
const LEGACY_PROJECT_INDEX_KEY = {
  tenantId: 1,
  projectId: 1,
  connectorName: 1,
  scope: 1,
  userId: 1,
} as const;
const LEGACY_PROJECT_INDEX_NAME = 'tenantId_1_projectId_1_connectorName_1_scope_1_userId_1';

const migrationLogger = {
  info(message: string, data?: Record<string, unknown>) {
    console.log(`[migration] ${message}`, data ?? '');
  },
  warn(message: string, data?: Record<string, unknown>) {
    console.warn(`[migration] ${message}`, data ?? '');
  },
  error(message: string, data?: Record<string, unknown>) {
    console.error(`[migration] ${message}`, data ?? '');
  },
};

export const migration: Migration = {
  version: '20260416_018',
  description:
    'Fix ConnectorConnection uniqueness index to scope by tenant + project + connector + auth profile',
  transactionMode: 'none',

  async up(db: Db) {
    await reconcileConnectorConnectionIndexes(db, migrationLogger);
  },

  async down(db: Db) {
    const col = db.collection(COLLECTION);

    try {
      await col.dropIndex(CURRENT_INDEX_NAME);
      console.log(`[migration] Dropped current index: ${CURRENT_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[migration] Index ${CURRENT_INDEX_NAME} not found (${message}), continuing`);
    }

    await col.createIndex(LEGACY_PROJECT_INDEX_KEY, {
      name: LEGACY_PROJECT_INDEX_NAME,
      unique: true,
    });
    console.log(`[migration] Restored legacy project-scoped index: ${LEGACY_PROJECT_INDEX_NAME}`);
  },

  async validate(db: Db) {
    const currentIndexPresent = await hasIndex(db, COLLECTION, CURRENT_INDEX_KEY, {
      unique: true,
      name: CURRENT_INDEX_NAME,
    });
    const legacyTenantIndexPresent = await hasIndex(db, COLLECTION, LEGACY_TENANT_INDEX_KEY, {
      unique: true,
    });
    const legacyProjectIndexPresent = await hasIndex(db, COLLECTION, LEGACY_PROJECT_INDEX_KEY, {
      unique: true,
    });

    if (!currentIndexPresent || legacyTenantIndexPresent || legacyProjectIndexPresent) {
      return validationFailed(
        'connector_connections uniqueness indexes do not match the expected state',
        {
          currentIndexPresent,
          legacyTenantIndexPresent,
          legacyProjectIndexPresent,
        },
      );
    }

    return validationPassed('connector_connections uniqueness is scoped by auth profile', {
      currentIndexPresent,
      legacyTenantIndexPresent,
      legacyProjectIndexPresent,
    });
  },
};

export default migration;
