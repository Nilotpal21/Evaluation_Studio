import type { Db, Document, Filter } from 'mongodb';

const COLLECTION_NAME = 'mcp_server_configs';

export interface McpAuthProfileSplitOptions {
  dryRun: boolean;
  restore: boolean;
  limit: number | null;
}

export interface McpAuthProfileSplitResult {
  mode: 'forward' | 'restore';
  candidates: number;
  updated: number;
  durationMs: number;
}

interface McpServerConfigDocument extends Document {
  _id: string;
  authProfileId?: unknown;
  envProfileId?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function buildForwardFilter(): Filter<McpServerConfigDocument> {
  return {
    authProfileId: { $type: 'string', $nin: [''] },
  };
}

function buildRestoreFilter(): Filter<McpServerConfigDocument> {
  return {
    envProfileId: { $type: 'string', $nin: [''] },
    $or: [{ authProfileId: null }, { authProfileId: { $exists: false } }],
  };
}

const MAX_SAFE_BATCH_SIZE = 10_000;

async function loadCandidates(
  db: Db,
  filter: Filter<McpServerConfigDocument>,
  limit: number | null,
): Promise<McpServerConfigDocument[]> {
  const effectiveLimit =
    limit !== null ? Math.min(limit, MAX_SAFE_BATCH_SIZE) : MAX_SAFE_BATCH_SIZE;
  return db
    .collection<McpServerConfigDocument>(COLLECTION_NAME)
    .find(filter)
    .limit(effectiveLimit)
    .toArray();
}

export async function runMcpAuthProfileSplitMigration(
  db: Db,
  options: McpAuthProfileSplitOptions,
): Promise<McpAuthProfileSplitResult> {
  const start = Date.now();
  const mode = options.restore ? 'restore' : 'forward';
  const filter = options.restore ? buildRestoreFilter() : buildForwardFilter();
  const collection = db.collection<McpServerConfigDocument>(COLLECTION_NAME);

  const candidates = await collection.countDocuments(filter);

  if (options.dryRun || candidates === 0) {
    return {
      mode,
      candidates,
      updated: 0,
      durationMs: Date.now() - start,
    };
  }

  const docs = await loadCandidates(db, filter, options.limit);
  if (docs.length === 0) {
    return {
      mode,
      candidates,
      updated: 0,
      durationMs: Date.now() - start,
    };
  }

  const operations = docs
    .map((doc) => {
      if (options.restore) {
        const envProfileId = asNonEmptyString(doc.envProfileId);
        if (!envProfileId) {
          return null;
        }

        return {
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                authProfileId: envProfileId,
                envProfileId: null,
              },
            },
          },
        };
      }

      const authProfileId = asNonEmptyString(doc.authProfileId);
      if (!authProfileId) {
        return null;
      }
      const envProfileId = asNonEmptyString(doc.envProfileId) ?? authProfileId;
      return {
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              authProfileId: null,
              envProfileId,
            },
          },
        },
      };
    })
    .filter((op): op is Exclude<typeof op, null> => op !== null);

  if (operations.length === 0) {
    return {
      mode,
      candidates,
      updated: 0,
      durationMs: Date.now() - start,
    };
  }

  const result = await collection.bulkWrite(operations, { ordered: false });
  return {
    mode,
    candidates,
    updated: result.modifiedCount,
    durationMs: Date.now() - start,
  };
}
