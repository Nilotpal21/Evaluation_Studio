/**
 * Legacy MongoDB Fact Store (DEPRECATED).
 *
 * Tenant-, user-, and project-unaware. Predates the tenant-isolation contract
 * and the `Fact` model's required `tenantId` / `userId` / `projectId` / `scope`
 * fields. Writes from this class would fail Mongoose validation today (the
 * required fields are not populated by `set()`).
 *
 * Kept exported only because tests in `apps/runtime/src/__tests__/sessions/`
 * still reference the class; the default `getStores()` factory wires it as
 * `fact:` but no production caller reads `getStores().fact`.
 *
 * Use `MongoDBFactStore` (in `mongodb-fact-store.ts`) for any new caller — it
 * enforces `{tenantId, userId, projectId, scope}` on every query, supports
 * the `wf:` reserved-prefix guard, and is the store wired into the workflow
 * first-class memory route group (`/api/internal/memory/*`).
 *
 * @deprecated Use `MongoDBFactStore` from `./mongodb-fact-store.js` instead.
 */

import {
  FactStore,
  FactStoreConfig,
  Fact,
  SetFactParams,
  GetFactParams,
  QueryFactsParams,
  BatchSetParams,
} from '@abl/compiler/platform/stores/fact-store.js';
import { Fact as FactModel } from '@agent-platform/database/models';

function mapDocToFact(doc: any): Fact {
  return {
    id: doc._id,
    key: doc.key,
    value: JSON.parse(doc.value),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    expiresAt: doc.expiresAt ?? null,
    source: {
      type: doc.sourceType ?? 'system',
      agentName: doc.sourceAgentName ?? undefined,
      sessionId: doc.sourceSessionId ?? undefined,
      traceId: doc.sourceTraceId ?? undefined,
    },
    metadata: doc.metadata ?? undefined,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(pattern: string): string {
  return pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
}

/**
 * @deprecated Use `MongoDBFactStore` from `./mongodb-fact-store.js`. This
 * class predates the tenant/user/project isolation contract and is retained
 * only for backward-compat with legacy test scaffolding.
 */
export class MongoFactStore extends FactStore {
  constructor(config: FactStoreConfig) {
    super(config);
  }

  async set(params: SetFactParams): Promise<Fact> {
    const expiresAt = params.ttlMs ? new Date(Date.now() + params.ttlMs) : null;

    const doc = await FactModel.findOneAndUpdate(
      { key: params.key },
      {
        $set: {
          key: params.key,
          value: JSON.stringify(params.value),
          expiresAt,
          sourceType: params.source?.type ?? null,
          sourceAgentName: params.source?.agentName ?? null,
          sourceSessionId: params.source?.sessionId ?? null,
          sourceTraceId: params.source?.traceId ?? null,
          metadata: params.metadata ?? null,
        },
      },
      { upsert: true, new: true, lean: true },
    );

    return mapDocToFact(doc);
  }

  async get(params: GetFactParams): Promise<Fact | null> {
    const doc = await FactModel.findOne({ key: params.key }).lean();

    if (!doc) return null;

    // Check expiration
    if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) {
      await FactModel.deleteOne({ key: params.key });
      return null;
    }

    return mapDocToFact(doc);
  }

  async delete(key: string): Promise<boolean> {
    const result = await FactModel.deleteOne({ key });
    return result.deletedCount > 0;
  }

  async exists(key: string): Promise<boolean> {
    const doc = await FactModel.findOne({ key }).lean();

    if (!doc) return false;

    // Check expiration
    if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) {
      await FactModel.deleteOne({ key });
      return false;
    }

    return true;
  }

  async query(params: QueryFactsParams): Promise<Fact[]> {
    const filter: Record<string, any> = {};

    if (params.prefix) {
      filter.key = { $regex: `^${escapeRegex(params.prefix)}` };
    }

    if (params.pattern) {
      const regex = `^${globToRegex(params.pattern)}$`;
      filter.key = { ...(filter.key ?? {}), $regex: regex };
    }

    if (params.sourceType) {
      filter.sourceType = params.sourceType;
    }

    // Exclude expired entries unless explicitly included
    if (!params.includeExpired) {
      filter.$or = [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }];
    }

    const limit = params.limit ?? 100;

    const docs = await FactModel.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();

    return docs.map(mapDocToFact);
  }

  async batchSet(params: BatchSetParams): Promise<Fact[]> {
    const operations = params.facts.map((fact) => {
      const source = fact.source ?? params.defaultSource;
      const expiresAt = fact.ttlMs ? new Date(Date.now() + fact.ttlMs) : null;

      return {
        updateOne: {
          filter: { key: fact.key },
          update: {
            $set: {
              key: fact.key,
              value: JSON.stringify(fact.value),
              expiresAt,
              sourceType: source?.type ?? null,
              sourceAgentName: source?.agentName ?? null,
              sourceSessionId: source?.sessionId ?? null,
              sourceTraceId: source?.traceId ?? null,
              metadata: fact.metadata ?? null,
            },
          },
          upsert: true,
        },
      };
    });

    await FactModel.bulkWrite(operations as any[]);

    // Fetch the upserted/updated documents
    const keys = params.facts.map((f) => f.key);
    const docs = await FactModel.find({ key: { $in: keys } }).lean();

    return docs.map(mapDocToFact);
  }

  async batchDelete(keys: string[]): Promise<number> {
    const result = await FactModel.deleteMany({ key: { $in: keys } });
    return result.deletedCount;
  }

  async clear(): Promise<number> {
    const result = await FactModel.deleteMany({});
    return result.deletedCount;
  }

  async cleanup(): Promise<number> {
    const result = await FactModel.deleteMany({
      expiresAt: { $lt: new Date() },
    });
    return result.deletedCount;
  }
}

/**
 * @deprecated Use `createMongoDBFactStore` (per-user) or `createProjectFactStore`
 * (project-shared) from `./mongodb-fact-store.js`. Both enforce tenant/user/project
 * isolation and the workflow reserved-prefix guard.
 */
export function createMongoFactStore(config?: Partial<FactStoreConfig>): MongoFactStore {
  return new MongoFactStore({
    type: 'mongodb',
    ...config,
  });
}
