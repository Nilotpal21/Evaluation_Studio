import mongoose from 'mongoose';

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

const CONNECTOR_CONNECTIONS_COLLECTION = 'connector_connections';
const CURRENT_UNIQUE_INDEX_NAME = 'tenantId_1_projectId_1_connectorName_1_authProfileId_1';
const REPAIR_LOCK_COLLECTION = '_migration_lock';
const REPAIR_LOCK_ID = 'connector_connection_uniqueness_index_repair';
const REPAIR_LOCK_TTL_MS = 5 * 60 * 1000;

const CURRENT_UNIQUE_INDEX_KEY = {
  tenantId: 1,
  projectId: 1,
  connectorName: 1,
  authProfileId: 1,
} as const;

const LEGACY_UNIQUE_INDEXES = [
  {
    name: 'tenantId_1_connectorName_1_scope_1_userId_1',
    key: { tenantId: 1, connectorName: 1, scope: 1, userId: 1 },
  },
  {
    name: 'tenantId_1_projectId_1_connectorName_1_scope_1_userId_1',
    key: { tenantId: 1, projectId: 1, connectorName: 1, scope: 1, userId: 1 },
  },
] as const;

type MongoDb = mongoose.mongo.Db;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;
type CreateIndexOptions = mongoose.mongo.CreateIndexesOptions;
type IndexSpecification = Parameters<mongoose.mongo.Collection['createIndex']>[0];

interface DuplicateKeyGroup {
  tenantId: unknown;
  projectId: unknown;
  connectorName: unknown;
  authProfileId: unknown;
  count: number;
}

function indexKeyMatches(
  index: IndexDescription | null | undefined,
  expectedKey: Record<string, unknown>,
): boolean {
  return JSON.stringify(index?.key ?? null) === JSON.stringify(expectedKey);
}

function isNamespaceNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: number; message?: string };
  if (candidate.code === 26) {
    return true;
  }

  return typeof candidate.message === 'string' && candidate.message.includes('ns not found');
}

function hasExpectedCurrentUniqueIndex(index: IndexDescription): boolean {
  return index.unique === true && indexKeyMatches(index, CURRENT_UNIQUE_INDEX_KEY);
}

function isLegacyUniqueIndex(index: IndexDescription): boolean {
  return LEGACY_UNIQUE_INDEXES.some(
    (legacyIndex) => index.name === legacyIndex.name || indexKeyMatches(index, legacyIndex.key),
  );
}

function snapshotIndexOptions(index: IndexDescription): CreateIndexOptions {
  const candidate = index as Record<string, unknown>;
  const options: CreateIndexOptions = {};

  for (const key of [
    'name',
    'unique',
    'sparse',
    'partialFilterExpression',
    'expireAfterSeconds',
    'collation',
    'hidden',
    'weights',
    'wildcardProjection',
  ] as const) {
    const value = candidate[key];
    if (value !== undefined) {
      (options as Record<string, unknown>)[key] = value;
    }
  }

  return options;
}

async function findCurrentContractDuplicates(
  collection: mongoose.mongo.Collection,
): Promise<DuplicateKeyGroup[]> {
  return (await collection
    .aggregate([
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            projectId: '$projectId',
            connectorName: '$connectorName',
            authProfileId: '$authProfileId',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 5 },
      {
        $project: {
          _id: 0,
          tenantId: '$_id.tenantId',
          projectId: '$_id.projectId',
          connectorName: '$_id.connectorName',
          authProfileId: '$_id.authProfileId',
          count: 1,
        },
      },
    ])
    .toArray()) as DuplicateKeyGroup[];
}

function formatDuplicateSummary(duplicates: DuplicateKeyGroup[]): string {
  return duplicates
    .map((group) =>
      JSON.stringify({
        tenantId: group.tenantId,
        projectId: group.projectId,
        connectorName: group.connectorName,
        authProfileId: group.authProfileId,
        count: group.count,
      }),
    )
    .join(', ');
}

async function assertCurrentUniqueIndexCanBeCreated(
  collection: mongoose.mongo.Collection,
): Promise<void> {
  const duplicates = await findCurrentContractDuplicates(collection);
  if (duplicates.length === 0) {
    return;
  }

  throw new Error(
    `Cannot enforce connector connection uniqueness index because duplicate connector/auth-profile bindings exist: ${formatDuplicateSummary(
      duplicates,
    )}`,
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

async function readCollectionIndexes(
  collection: mongoose.mongo.Collection,
): Promise<IndexDescription[]> {
  try {
    return (await collection.indexes()) as IndexDescription[];
  } catch (err: unknown) {
    if (isNamespaceNotFoundError(err)) {
      return [];
    }
    throw err;
  }
}

export async function reconcileConnectorConnectionIndexes(
  db: MongoDb,
  logger: Logger,
): Promise<void> {
  const collection = db.collection(CONNECTOR_CONNECTIONS_COLLECTION);
  const indexes = await readCollectionIndexes(collection);

  const staleIndexes = indexes.filter(isLegacyUniqueIndex);
  const currentIndex =
    indexes.find((index) => index.name === CURRENT_UNIQUE_INDEX_NAME) ??
    indexes.find((index) => indexKeyMatches(index, CURRENT_UNIQUE_INDEX_KEY));
  const currentIndexReady = currentIndex ? hasExpectedCurrentUniqueIndex(currentIndex) : false;
  let createdCurrentIndex = false;
  const droppedIndexNames = new Set<string>();

  if (staleIndexes.length === 0 && currentIndexReady) {
    return;
  }

  if (!currentIndexReady) {
    await assertCurrentUniqueIndexCanBeCreated(collection);

    let droppedCurrentIndex: {
      key: IndexSpecification;
      options: CreateIndexOptions;
    } | null = null;

    const currentIndexName = currentIndex?.name;
    if (currentIndex && currentIndexName) {
      logger.warn('Recreating connector connection uniqueness index with current schema', {
        indexName: currentIndexName,
        key: currentIndex.key ?? null,
        unique: currentIndex.unique ?? false,
      });
      droppedCurrentIndex = {
        key: (currentIndex.key ?? {}) as IndexSpecification,
        options: snapshotIndexOptions(currentIndex),
      };
      await collection.dropIndex(currentIndexName);
      droppedIndexNames.add(currentIndexName);
    }

    try {
      logger.warn('Ensuring connector connection uniqueness index is present', {
        indexName: CURRENT_UNIQUE_INDEX_NAME,
      });
      await collection.createIndex(CURRENT_UNIQUE_INDEX_KEY, {
        name: CURRENT_UNIQUE_INDEX_NAME,
        unique: true,
      });
      createdCurrentIndex = true;
    } catch (err: unknown) {
      if (droppedCurrentIndex) {
        try {
          await collection.createIndex(droppedCurrentIndex.key, droppedCurrentIndex.options);
          droppedIndexNames.delete(droppedCurrentIndex.options.name ?? '');
          logger.warn('Restored previous connector connection index after repair failure', {
            indexName: droppedCurrentIndex.options.name ?? null,
          });
        } catch (restoreErr: unknown) {
          logger.error(
            'Failed to restore previous connector connection index after repair failure',
            {
              indexName: droppedCurrentIndex.options.name ?? null,
              error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            },
          );
        }
      }

      throw err;
    }
  }

  for (const index of staleIndexes) {
    const indexName = index.name;
    if (!indexName || droppedIndexNames.has(indexName)) {
      continue;
    }

    logger.warn('Dropping legacy connector connection uniqueness index', {
      indexName,
      key: index.key ?? null,
      unique: index.unique ?? false,
    });
    await collection.dropIndex(indexName);
    droppedIndexNames.add(indexName);
  }

  logger.info('Connector connection uniqueness index is ready', {
    droppedIndexes: Array.from(droppedIndexNames),
    createdIndex: createdCurrentIndex,
  });
}

export async function repairLegacyConnectorConnectionIndexes(logger: Logger): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    logger.warn('Skipping connector connection index repair because MongoDB is not connected');
    return;
  }

  const lockAcquired = await acquireRepairLock(db);
  if (!lockAcquired) {
    logger.info(
      'Skipping connector connection index repair because another instance is handling it',
    );
    return;
  }

  try {
    await reconcileConnectorConnectionIndexes(db, logger);
  } finally {
    await releaseRepairLock(db).catch((err: unknown) => {
      logger.warn('Failed to release connector connection index repair lock', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
