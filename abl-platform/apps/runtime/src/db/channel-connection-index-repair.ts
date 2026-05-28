import { isDeepStrictEqual } from 'node:util';
import mongoose from 'mongoose';

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

const CHANNEL_CONNECTIONS_COLLECTION = 'channel_connections';
const VERIFY_TOKEN_INDEX_NAME = 'channelType_1_verifyTokenHash_1';
const REPAIR_LOCK_COLLECTION = '_migration_lock';
const REPAIR_LOCK_ID = 'channel_connection_verify_token_index_repair';
const REPAIR_LOCK_TTL_MS = 5 * 60 * 1000;
const EXPECTED_PARTIAL_FILTER = {
  status: 'active',
  verifyTokenHash: { $type: 'string' },
} as const;

type MongoDb = mongoose.mongo.Db;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;

function hasExpectedVerifyTokenIndexOptions(index: IndexDescription): boolean {
  return (
    index.unique === true &&
    index.sparse !== true &&
    isDeepStrictEqual(index.partialFilterExpression ?? null, EXPECTED_PARTIAL_FILTER)
  );
}

async function acquireRepairLock(db: MongoDb): Promise<boolean> {
  const collection = db.collection(REPAIR_LOCK_COLLECTION);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REPAIR_LOCK_TTL_MS);
  const lockedBy = `${process.pid}`;

  try {
    const result = await collection.updateOne(
      {
        _id: REPAIR_LOCK_ID as any,
        $or: [{ lockedAt: { $exists: false } }, { expiresAt: { $lt: now } }],
      },
      {
        $set: {
          _id: REPAIR_LOCK_ID,
          lockedAt: now,
          lockedBy,
          expiresAt,
        },
      },
      { upsert: true },
    );

    return result.upsertedCount > 0 || result.modifiedCount > 0;
  } catch (err: unknown) {
    const error = err as { code?: number };
    if (error.code === 11000) {
      return false;
    }
    throw err;
  }
}

async function releaseRepairLock(db: MongoDb): Promise<void> {
  await db.collection(REPAIR_LOCK_COLLECTION).deleteOne({ _id: REPAIR_LOCK_ID as any });
}

export async function repairLegacyChannelConnectionIndexes(logger: Logger): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    logger.warn('Skipping channel connection index repair because MongoDB is not connected');
    return;
  }

  const lockAcquired = await acquireRepairLock(db);
  if (!lockAcquired) {
    logger.info('Skipping channel connection index repair because another instance is handling it');
    return;
  }

  try {
    const collection = db.collection(CHANNEL_CONNECTIONS_COLLECTION);
    const indexes = await collection.indexes();
    const verifyTokenIndex = indexes.find((index) => index.name === VERIFY_TOKEN_INDEX_NAME);

    if (verifyTokenIndex && hasExpectedVerifyTokenIndexOptions(verifyTokenIndex)) {
      return;
    }

    if (verifyTokenIndex) {
      logger.warn('Repairing stale channel connection verifyTokenHash index', {
        sparse: verifyTokenIndex.sparse ?? false,
        partialFilterExpression: verifyTokenIndex.partialFilterExpression ?? null,
      });
      await collection.dropIndex(VERIFY_TOKEN_INDEX_NAME);
    } else {
      logger.warn('Creating missing channel connection verifyTokenHash index');
    }

    await collection.createIndex(
      { channelType: 1, verifyTokenHash: 1 },
      {
        name: VERIFY_TOKEN_INDEX_NAME,
        unique: true,
        partialFilterExpression: EXPECTED_PARTIAL_FILTER,
      },
    );

    logger.info('Channel connection verifyTokenHash index is ready');
  } finally {
    await releaseRepairLock(db).catch((err: unknown) => {
      logger.warn('Failed to release channel connection index repair lock', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
