/**
 * MongoDB Fact Store (Owner-Scoped, Tenant+Project-Scoped)
 *
 * Implements the FactStore abstract class with three-level isolation:
 * - tenantId: DB-level partition (no cross-tenant access)
 * - userId: Durable owner identifier (contact or trusted actor lane)
 * - projectId: Scope — facts from Project A aren't visible to Project B
 *
 * Every query includes all three dimensions. No cross-owner, cross-project,
 * or cross-tenant data access is possible at the query level.
 *
 * Boundary guards:
 * - MAX_FACT_VALUE_SIZE: 64KB per fact value — aligns with the workflow
 *   memory route's `MAX_VALUE_SIZE_BYTES` so values accepted by
 *   `/api/internal/memory/set` reach this layer without a confusing
 *   500 INTERNAL. Legacy `tool-memory-bridge` writes also benefit from
 *   the same headroom; this is still well under the 16 MB Mongo doc cap.
 * - DEFAULT_FACT_TTL_MS: 90 days (GDPR compliance — no immortal PII)
 * - Path whitelist: enforced by callers via allowedPaths option
 */

import { FactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type {
  FactStoreConfig,
  Fact,
  FactSource,
  SetFactParams,
  GetFactParams,
  QueryFactsParams,
  BatchSetParams,
} from '@abl/compiler/platform/stores/fact-store.js';
import { Fact as FactModel } from '@agent-platform/database/models';
import type { IFact } from '@agent-platform/database/models';
import { WORKFLOW_KEY_PREFIX } from './workflow-memory-constants.js';

/**
 * Options accepted by the protected `_setInternal` method. Only the
 * `FactStoreWorkflowAdapter` (in-package, friend-class) sets `__originAdapter='workflow'`
 * to bypass the reserved-prefix guard for `wf:`-namespaced keys.
 */
export interface SetInternalOptions {
  __originAdapter?: 'workflow';
}

/**
 * Error thrown when a caller attempts to write a `wf:` key directly via the
 * public `set()` path. The route layer also enforces the broader reserved
 * prefix list (`_meta:`, `_system:`, `_audit:`) so this guard is the deep
 * net for the workflow-scope namespace.
 */
export class ReservedPrefixError extends Error {
  readonly code = 'RESERVED_PREFIX' as const;
  constructor(key: string) {
    super(`Key '${key}' uses reserved prefix '${WORKFLOW_KEY_PREFIX}' — write rejected`);
    this.name = 'ReservedPrefixError';
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum size of a single fact value in bytes (64 KiB).
 *
 * Aligned with `MAX_VALUE_SIZE_BYTES` in `workflow-memory-constants.ts` so
 * that the workflow memory route and this layer enforce the SAME cap. A
 * mismatch (route accepts 64 KiB, store rejects at a smaller cap) leaks
 * a generic 500 INTERNAL for any value above the lower cap, which is
 * indistinguishable from a real platform fault to authors.
 */
const MAX_FACT_VALUE_SIZE = 64 * 1024;

/** Default TTL for facts without explicit TTL: 90 days (GDPR compliance) */
const DEFAULT_FACT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// =============================================================================
// HELPERS
// =============================================================================

/** Convert a Mongoose IFact document (lean) to the FactStore Fact interface. */
function mapDocToFact(doc: IFact): Fact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.value);
  } catch {
    // Corrupt JSON in DB — return null so callers can skip gracefully
    return null;
  }
  return {
    id: doc._id,
    key: doc.key,
    value: parsed,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    expiresAt: doc.expiresAt ?? null,
    source: {
      type: (doc.sourceType as FactSource['type']) ?? 'system',
      agentName: doc.sourceAgentName ?? undefined,
      sessionId: doc.sourceSessionId ?? undefined,
      traceId: doc.sourceTraceId ?? undefined,
    },
    metadata: doc.metadata ?? undefined,
  };
}

/** Escape special regex characters so a literal string can be used in a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a simple glob pattern (supports `*` and `?`) to a regex string. */
function globToRegex(pattern: string): string {
  return pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
}

// =============================================================================
// MONGODB FACT STORE (OWNER-SCOPED, TENANT+PROJECT-SCOPED)
// =============================================================================

/** Sentinel userId for project-scoped facts (no real user owns them) */
export const PROJECT_SCOPE_USER_ID = '__project__';

export class MongoDBFactStore extends FactStore {
  private tenantId: string;
  private userId: string;
  private projectId: string;
  private scope: 'user' | 'project';

  constructor(
    config: FactStoreConfig,
    tenantId: string,
    userId: string,
    projectId: string,
    scope: 'user' | 'project' = 'user',
  ) {
    super(config);
    this.tenantId = tenantId;
    this.userId = userId;
    this.projectId = projectId;
    this.scope = scope;
  }

  /** Base filter that enforces ownership on every query */
  private ownerFilter() {
    return {
      tenantId: this.tenantId,
      userId: this.userId,
      projectId: this.projectId,
      scope: this.scope,
    };
  }

  // ---------------------------------------------------------------------------
  // set
  // ---------------------------------------------------------------------------

  async set(params: SetFactParams): Promise<Fact> {
    return this._setInternal(params);
  }

  /**
   * Protected variant of `set()` that accepts an `__originAdapter` marker.
   * The reserved-prefix guard (`wf:`) applies whenever the marker is absent.
   * Only `FactStoreWorkflowAdapter` (in-package friend) is permitted to set
   * `__originAdapter='workflow'`. Cross-surface callers (tool-memory-bridge,
   * direct fact-store consumers) hit the public `set()` and are rejected
   * if they use the reserved prefix — closes the deep-guard gap.
   */
  protected async _setInternal(params: SetFactParams, options?: SetInternalOptions): Promise<Fact> {
    // Reserved-prefix guard — deepest net. Route layer rejects the broader
    // prefix list (`_meta:`, `_system:`, `_audit:`); fact-store enforces
    // workflow-scope namespace exclusivity.
    if (params.key.startsWith(WORKFLOW_KEY_PREFIX) && options?.__originAdapter !== 'workflow') {
      throw new ReservedPrefixError(params.key);
    }

    // Boundary guard: value size
    const serialized = JSON.stringify(params.value);
    if (serialized.length > MAX_FACT_VALUE_SIZE) {
      throw new Error(
        `Fact value exceeds ${MAX_FACT_VALUE_SIZE} bytes (got ${serialized.length}). ` +
          'FactStore is for small values, not blob storage.',
      );
    }

    // Apply default TTL if none specified (GDPR compliance)
    const ttlMs = this.parseTtl(params.ttlMs) ?? DEFAULT_FACT_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs);

    const doc = await FactModel.findOneAndUpdate(
      { ...this.ownerFilter(), key: params.key },
      {
        $set: {
          ...this.ownerFilter(),
          key: params.key,
          value: serialized,
          expiresAt,
          sourceType: params.source?.type ?? 'system',
          sourceAgentName: params.source?.agentName ?? null,
          sourceSessionId: params.source?.sessionId ?? null,
          sourceTraceId: params.source?.traceId ?? null,
          metadata: params.metadata ?? null,
        },
        // Clear tombstone fields on rewrite (key was previously soft-deleted,
        // now being recreated by an upsert). Defensive — most rewrites won't
        // have tombstone fields set, but if they do this resurrects the key.
        $unset: { isDeleted: '', deletedAt: '' },
      },
      { upsert: true, new: true, lean: true },
    );

    // Value was just written so JSON.parse should never fail here
    return mapDocToFact(doc as unknown as IFact)!;
  }

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  async get(params: GetFactParams): Promise<Fact | null> {
    const doc = await FactModel.findOne({
      ...this.ownerFilter(),
      key: params.key,
      isDeleted: { $ne: true },
    }).lean();

    if (!doc) return null;

    // Defensive expiration check — MongoDB TTL index is eventually consistent
    if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) {
      await FactModel.deleteOne({ ...this.ownerFilter(), key: params.key });
      return null;
    }

    return mapDocToFact(doc as IFact);
  }

  // ---------------------------------------------------------------------------
  // getMany — batch get with $in for N+1 elimination
  // ---------------------------------------------------------------------------

  async getMany(keys: string[]): Promise<Map<string, Fact>> {
    if (keys.length === 0) return new Map();
    const docs = await FactModel.find({
      ...this.ownerFilter(),
      key: { $in: keys },
      isDeleted: { $ne: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }],
    }).lean();
    const entries: [string, Fact][] = [];
    for (const d of docs) {
      const fact = mapDocToFact(d as IFact);
      if (fact) entries.push([fact.key, fact]);
    }
    return new Map(entries);
  }

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  /**
   * Soft-deletes the fact by setting `isDeleted=true` and `deletedAt`. The
   * document remains in the collection until the existing TTL index on
   * `expiresAt` reaps it; reads exclude tombstones via
   * `{ isDeleted: { $ne: true } }` so the fact is invisible to consumers
   * immediately. The retained value supports audit reconstruction.
   *
   * Returns `true` when a live fact was tombstoned, `false` when no live
   * fact existed (already tombstoned or never present).
   */
  async delete(key: string): Promise<boolean> {
    const result = await FactModel.updateOne(
      { ...this.ownerFilter(), key, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  // ---------------------------------------------------------------------------
  // exists
  // ---------------------------------------------------------------------------

  async exists(key: string): Promise<boolean> {
    const count = await FactModel.countDocuments({
      ...this.ownerFilter(),
      key,
      isDeleted: { $ne: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }],
    });
    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // query
  // ---------------------------------------------------------------------------

  /**
   * Local extension over the platform `QueryFactsParams` interface adding a
   * server-side negative-prefix filter. Used by the workflow memory route
   * to fetch project-scope facts while excluding the `wf:` namespace
   * server-side, instead of post-filtering after a `limit:N` query (which
   * silently drops project facts when many `wf:*` documents rank
   * higher in the `updatedAt` sort).
   */
  async query(params: QueryFactsParams & { keyNotPrefix?: string }): Promise<Fact[]> {
    const filter: Record<string, unknown> = {
      ...this.ownerFilter(),
      isDeleted: { $ne: true },
    };

    // Key prefix filter
    if (params.prefix) {
      filter.key = { $regex: `^${escapeRegex(params.prefix)}` };
    }

    // Glob pattern filter
    if (params.pattern) {
      const regex = `^${globToRegex(params.pattern)}$`;
      filter.key = { ...((filter.key as Record<string, unknown>) ?? {}), $regex: regex };
    }

    // Negative key-prefix filter (server-side exclusion). Combines with any
    // positive `prefix` / `pattern` filter via $not so we don't over-fetch
    // and silently drop matching documents past the limit.
    if (params.keyNotPrefix) {
      const not = { $not: new RegExp(`^${escapeRegex(params.keyNotPrefix)}`) };
      filter.key = { ...((filter.key as Record<string, unknown>) ?? {}), ...not };
    }

    // Source type filter
    if (params.sourceType) {
      filter.sourceType = params.sourceType;
    }

    // Exclude expired unless explicitly included
    if (!params.includeExpired) {
      filter.$or = [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }];
    }

    const limit = params.limit ?? 100;

    const docs = await FactModel.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();

    const results: Fact[] = [];
    for (const doc of docs) {
      const fact = mapDocToFact(doc as IFact);
      if (fact) results.push(fact);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // batchSet
  // ---------------------------------------------------------------------------

  async batchSet(params: BatchSetParams): Promise<Fact[]> {
    const results: Fact[] = [];

    for (const factParams of params.facts) {
      const fact = await this.set({
        ...factParams,
        source: factParams.source || params.defaultSource,
      });
      results.push(fact);
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // batchDelete
  // ---------------------------------------------------------------------------

  /**
   * Soft-deletes a batch of facts by setting `isDeleted=true` and
   * `deletedAt`. Live tombstoned-already entries are not touched.
   * Returns the number of live facts that were tombstoned.
   */
  async batchDelete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const result = await FactModel.updateMany(
      { ...this.ownerFilter(), key: { $in: keys }, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
    return result.modifiedCount;
  }

  // ---------------------------------------------------------------------------
  // clear — only this user's facts in this project
  // ---------------------------------------------------------------------------

  async clear(): Promise<number> {
    const result = await FactModel.deleteMany(this.ownerFilter());
    return result.deletedCount;
  }

  // ---------------------------------------------------------------------------
  // cleanup — remove expired facts for this user in this project
  // ---------------------------------------------------------------------------

  async cleanup(): Promise<number> {
    const result = await FactModel.deleteMany({
      ...this.ownerFilter(),
      expiresAt: { $lte: new Date() },
    });
    return result.deletedCount;
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createOwnedFactStore(
  tenantId: string,
  ownerId: string,
  projectId: string,
  config?: Partial<FactStoreConfig>,
): MongoDBFactStore {
  return new MongoDBFactStore({ type: 'mongodb', ...config }, tenantId, ownerId, projectId, 'user');
}

export function createMongoDBFactStore(
  tenantId: string,
  userId: string,
  projectId: string,
  config?: Partial<FactStoreConfig>,
): MongoDBFactStore {
  return createOwnedFactStore(tenantId, userId, projectId, config);
}

/** Create a project-scoped fact store (shared across all users in the project) */
export function createProjectFactStore(
  tenantId: string,
  projectId: string,
  config?: Partial<FactStoreConfig>,
): MongoDBFactStore {
  return new MongoDBFactStore(
    { type: 'mongodb', ...config },
    tenantId,
    PROJECT_SCOPE_USER_ID,
    projectId,
    'project',
  );
}
