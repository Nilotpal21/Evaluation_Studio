import mongoose from 'mongoose';
import { CHANGE_LOCK_COLLECTION, assertLeaseFence } from './lease.js';
import type { ChangeEnvironment, ChangeHistoryEntry, ChangeValidationStatus } from './types.js';

type Db = mongoose.mongo.Db;

export const CHANGE_HISTORY_COLLECTION = '_change_history';

export interface NormalizedChangeHistoryRecord extends ChangeHistoryEntry {
  _id: string;
  environment: ChangeEnvironment;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  appliedBy?: string | null;
  buildInfo?: Record<string, unknown>;
  fence?: number | null;
  shadowSource?: string | null;
  shadowKey?: string | null;
  updatedAt: Date;
  createdAt?: Date;
}

export interface ChangeHistoryWriteOptions {
  collectionName?: string;
  lockCollectionName?: string;
  lockId?: string;
  holderId?: string;
  fence?: number;
  runCountDelta?: number;
  shadowSource?: string | null;
  shadowKey?: string | null;
}

interface ChangeHistoryInput extends ChangeHistoryEntry {
  environment: ChangeEnvironment;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  appliedBy?: string | null;
  buildInfo?: Record<string, unknown>;
  fence?: number | null;
}

function getCollection(db: Db, collectionName = CHANGE_HISTORY_COLLECTION) {
  return db.collection<NormalizedChangeHistoryRecord>(collectionName);
}

function buildHistoryId(record: ChangeHistoryInput): string {
  return `${record.environment}:${record.changeId}:${record.targetKey ?? 'global'}`;
}

function normalizeValidationStatus(
  status: ChangeValidationStatus | undefined,
): ChangeValidationStatus | undefined {
  return status;
}

export async function writeChangeHistory(
  db: Db,
  record: ChangeHistoryInput,
  options: ChangeHistoryWriteOptions = {},
): Promise<NormalizedChangeHistoryRecord> {
  if (options.fence !== undefined) {
    if (!options.lockId || !options.holderId) {
      throw new Error('lockId and holderId are required when writing with a fence.');
    }

    await assertLeaseFence(db, {
      lockId: options.lockId,
      holderId: options.holderId,
      fence: options.fence,
      collectionName: options.lockCollectionName ?? CHANGE_LOCK_COLLECTION,
    });
  }

  const now = new Date();
  const _id = buildHistoryId(record);
  const collection = getCollection(db, options.collectionName);
  const update: {
    $set: Partial<NormalizedChangeHistoryRecord>;
    $setOnInsert: Pick<NormalizedChangeHistoryRecord, 'createdAt'>;
    $inc?: { runCount: number };
  } = {
    $set: {
      ...record,
      _id,
      validationStatus: normalizeValidationStatus(record.validationStatus),
      fence: options.fence ?? record.fence ?? null,
      shadowSource: options.shadowSource ?? null,
      shadowKey: options.shadowKey ?? null,
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
    },
  };

  if ((options.runCountDelta ?? 0) !== 0) {
    update.$inc = { runCount: options.runCountDelta ?? 0 };
  }

  await collection.updateOne({ _id }, update, { upsert: true });
  const persisted = await collection.findOne({ _id });

  if (!persisted) {
    throw new Error(`Failed to load persisted change history for ${_id}`);
  }

  return persisted;
}

export async function shadowWriteChangeHistory(
  db: Db,
  record: ChangeHistoryInput,
  options: ChangeHistoryWriteOptions = {},
): Promise<NormalizedChangeHistoryRecord> {
  return writeChangeHistory(db, record, {
    ...options,
    shadowSource: options.shadowSource ?? 'legacy',
  });
}

export async function readChangeHistory(
  db: Db,
  filter: Record<string, unknown> = {},
  collectionName = CHANGE_HISTORY_COLLECTION,
): Promise<NormalizedChangeHistoryRecord[]> {
  return getCollection(db, collectionName).find(filter).sort({ _id: 1 }).toArray();
}
