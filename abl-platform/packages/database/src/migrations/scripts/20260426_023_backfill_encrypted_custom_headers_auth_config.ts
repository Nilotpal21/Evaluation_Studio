/**
 * Migration: Backfill plaintext customHeaders/authConfig fields into DEK envelope encryption.
 *
 * Historical documents written before the hardening patch can still have these
 * fields stored as plaintext objects/strings in MongoDB. Re-saving the
 * documents through their Mongoose models runs the encryption plugin and
 * rewrites the fields into ciphertext.
 *
 * Date: 2026-04-26
 */

import mongoose from 'mongoose';
import { isAlreadyEncrypted } from '@agent-platform/shared-encryption';
import { initDEKFacade } from '../../kms/index.js';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

type SavableDocument = {
  save(): Promise<unknown>;
};

type RawCandidateDocument = {
  _id: string;
  tenantId?: string | null;
  customHeaders?: unknown;
  authConfig?: unknown;
};

interface BackfillTarget {
  name: string;
  collectionName: string;
  fields: readonly string[];
  validationKey: string;
  loadDocument(raw: RawCandidateDocument): Promise<SavableDocument | null>;
}

const BATCH_SIZE = 100;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlaintextFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  return typeof value !== 'string' || !isAlreadyEncrypted(value);
}

function docNeedsBackfill(doc: RawCandidateDocument, fields: readonly string[]): boolean {
  return fields.some((field) => isPlaintextFieldValue(doc[field as keyof RawCandidateDocument]));
}

function buildCandidateFilter(fields: readonly string[], lastId?: string): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $or: fields.map((field) => ({
      [field]: { $exists: true, $ne: null },
    })),
  };

  if (lastId) {
    filter._id = { $gt: lastId };
  }

  return filter;
}

async function ensureMigrationEncryptionReady(): Promise<void> {
  const { isFacadeEncryptionAvailable, setMasterKey } =
    await import('@agent-platform/database/models');

  if (isFacadeEncryptionAvailable()) {
    return;
  }

  const masterKeyHex = process.env['ENCRYPTION_MASTER_KEY'];
  if (!masterKeyHex) {
    throw new Error(
      'ENCRYPTION_MASTER_KEY is required to backfill encrypted customHeaders/authConfig fields',
    );
  }

  setMasterKey(masterKeyHex);
  await initDEKFacade({ masterKeyHex });
}

async function loadTargets(): Promise<BackfillTarget[]> {
  const { LLMCredential, ArchWorkspaceConfig, TenantModel } =
    await import('@agent-platform/database/models');

  return [
    {
      name: 'LLM credentials',
      collectionName: 'llm_credentials',
      fields: ['customHeaders', 'authConfig'],
      validationKey: 'llmCredentialsRemaining',
      async loadDocument(raw) {
        if (!isNonEmptyString(raw.tenantId)) {
          return null;
        }
        return LLMCredential.findOne({ _id: raw._id, tenantId: raw.tenantId });
      },
    },
    {
      name: 'Arch workspace configs',
      collectionName: 'arch_workspace_configs',
      fields: ['customHeaders'],
      validationKey: 'archWorkspaceConfigsRemaining',
      async loadDocument(raw) {
        if (!isNonEmptyString(raw.tenantId)) {
          return null;
        }
        return ArchWorkspaceConfig.findOne({ _id: raw._id, tenantId: raw.tenantId });
      },
    },
    {
      name: 'Tenant models',
      collectionName: 'tenant_models',
      fields: ['customHeaders'],
      validationKey: 'tenantModelsRemaining',
      async loadDocument(raw) {
        if (!isNonEmptyString(raw.tenantId)) {
          return null;
        }
        return TenantModel.findOne({ _id: raw._id, tenantId: raw.tenantId });
      },
    },
  ];
}

async function backfillTarget(
  db: Db,
  target: BackfillTarget,
): Promise<{ scanned: number; updated: number; unresolved: number }> {
  const collection = db.collection<RawCandidateDocument>(target.collectionName);

  let scanned = 0;
  let updated = 0;
  let unresolved = 0;
  let lastId: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await collection
      .find(buildCandidateFilter(target.fields, lastId), {
        projection: {
          _id: 1,
          tenantId: 1,
          customHeaders: 1,
          authConfig: 1,
        },
        sort: { _id: 1 },
        limit: BATCH_SIZE,
      })
      .toArray();

    if (batch.length === 0) {
      break;
    }

    for (const raw of batch) {
      scanned += 1;

      if (!docNeedsBackfill(raw, target.fields)) {
        continue;
      }

      const doc = await target.loadDocument(raw);
      if (!doc) {
        unresolved += 1;
        continue;
      }

      await doc.save();
      updated += 1;
    }

    lastId = String(batch[batch.length - 1]?._id);
  }

  log.info(`${target.name}: scanned ${scanned}, updated ${updated}, unresolved ${unresolved}`);

  return { scanned, updated, unresolved };
}

async function countRemainingPlaintext(db: Db, target: BackfillTarget): Promise<number> {
  const collection = db.collection<RawCandidateDocument>(target.collectionName);

  let remaining = 0;
  let lastId: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await collection
      .find(buildCandidateFilter(target.fields, lastId), {
        projection: {
          _id: 1,
          tenantId: 1,
          customHeaders: 1,
          authConfig: 1,
        },
        sort: { _id: 1 },
        limit: BATCH_SIZE,
      })
      .toArray();

    if (batch.length === 0) {
      break;
    }

    for (const raw of batch) {
      if (docNeedsBackfill(raw, target.fields)) {
        remaining += 1;
      }
    }

    lastId = String(batch[batch.length - 1]?._id);
  }

  return remaining;
}

export const migration: Migration = {
  version: '20260426_023',
  description: 'Backfill plaintext customHeaders and authConfig into DEK envelope encryption',
  transactionMode: 'none',

  async up(db: Db) {
    await ensureMigrationEncryptionReady();
    const targets = await loadTargets();

    for (const target of targets) {
      await backfillTarget(db, target);
    }
  },

  async down(_db: Db) {
    log.info(
      'Rollback is a no-op — encrypted values cannot be safely restored to plaintext without reintroducing the security gap',
    );
  },

  async validate(db: Db) {
    const targets = await loadTargets();
    const remainingEntries = await Promise.all(
      targets.map(async (target) => [
        target.validationKey,
        await countRemainingPlaintext(db, target),
      ]),
    );
    const remaining = Object.fromEntries(remainingEntries) as Record<string, number>;

    const totalRemaining = Object.values(remaining).reduce((sum, count) => sum + count, 0);
    if (totalRemaining > 0) {
      return validationFailed(
        'Some customHeaders/authConfig fields are still stored as plaintext',
        remaining,
      );
    }

    return validationPassed(
      'All targeted customHeaders/authConfig fields are stored as ciphertext',
      remaining,
    );
  },
};

export default migration;
