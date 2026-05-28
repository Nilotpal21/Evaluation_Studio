/**
 * Agentic Compat Binding Repository
 *
 * CRUD + LRU+TTL read cache for AgentAssistBinding documents.
 * All queries include explicit tenantId filters (belt-and-braces
 * with the tenantIsolationPlugin).
 *
 * The cache is never authoritative — only a performance optimization
 * for the hot `get(tenantId, appId, environment)` path.
 */

import { createLogger } from '@abl/compiler/platform';
import { AgentAssistBinding, type IAgentAssistBinding } from '@agent-platform/database/models';
import { LRUTTLCache } from '@agent-platform/shared-kernel';

// ─── Constants ──────────────────────────────────────────────────────────

export const AGENT_ASSIST_BINDING_CACHE_MAX = 500;
export const AGENT_ASSIST_BINDING_CACHE_TTL_MS = 60_000;

// ─── Types ──────────────────────────────────────────────────────────────

export interface CreateBindingInput {
  projectId: string;
  appId: string;
  environment: string;
  deploymentId?: string | null;
  apiKeyId?: string | null;
  displayName?: string | null;
  runtimeBaseUrl?: string | null;
}

export type UpdateBindingInput = Partial<
  Pick<
    IAgentAssistBinding,
    'projectId' | 'deploymentId' | 'apiKeyId' | 'apiKeyPrefix' | 'displayName' | 'runtimeBaseUrl'
  >
>;

export interface AgentAssistBindingResolver {
  get(
    ctx: { tenantId: string },
    key: { appId: string; environment: string },
  ): Promise<IAgentAssistBinding | null>;
  invalidate(tenantId: string, appId: string, environment: string): void;
  list(
    ctx: { tenantId: string },
    page: { offset: number; limit: number; projectId?: string },
  ): Promise<{ items: IAgentAssistBinding[]; total: number }>;
  /**
   * Tenant-scoped lookup by binding `_id`. Internally uses `findOne({_id, tenantId}).lean()`
   * — NEVER Mongoose `findById`, which would bypass tenant isolation. Named to keep
   * callsites readable without invoking the CLAUDE.md findById lint guard.
   */
  findByIdForTenant(ctx: { tenantId: string }, id: string): Promise<IAgentAssistBinding | null>;
  create(
    ctx: { tenantId: string; actor: string },
    input: CreateBindingInput,
  ): Promise<IAgentAssistBinding>;
  update(
    ctx: { tenantId: string; actor: string },
    id: string,
    patch: UpdateBindingInput,
  ): Promise<IAgentAssistBinding>;
  setStatus(
    ctx: { tenantId: string; actor: string },
    id: string,
    status: 'active' | 'disabled',
  ): Promise<IAgentAssistBinding>;
  remove(ctx: { tenantId: string; actor: string }, id: string): Promise<void>;
  cascadeOnProjectDelete(tenantId: string, projectId: string): Promise<number>;
}

// ─── Errors ─────────────────────────────────────────────────────────────

export class AgentAssistBindingDuplicateError extends Error {
  readonly code = 'BINDING_DUPLICATE' as const;

  constructor(tenantId: string, appId: string, environment: string) {
    super(
      `Binding already exists for tenant=${tenantId}, appId=${appId}, environment=${environment}`,
    );
    this.name = 'AgentAssistBindingDuplicateError';
  }
}

export class AgentAssistBindingNotFoundError extends Error {
  readonly code = 'BINDING_NOT_FOUND' as const;

  constructor(id: string) {
    super(`Binding not found: ${id}`);
    this.name = 'AgentAssistBindingNotFoundError';
  }
}

// ─── Logger ─────────────────────────────────────────────────────────────

const log = createLogger('agent-assist-binding-repo');

// ─── Cache key helper ───────────────────────────────────────────────────

export function bindingCacheKey(tenantId: string, appId: string, environment: string): string {
  return `${tenantId}:${appId}:${environment.toLowerCase()}`;
}

// ─── Model DI interface ─────────────────────────────────────────────────

/**
 * Minimal Mongoose-model-like interface for DI in tests.
 * Production code passes the real `AgentAssistBinding` model;
 * integration tests pass their own MongoMemoryServer-registered model.
 */
export interface BindingModelLike {
  findOne(filter: Record<string, unknown>): { lean(): Promise<unknown> };
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, unknown>): {
      skip(n: number): {
        limit(n: number): { lean(): Promise<unknown[]> };
      };
    };
  };
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): { lean(): Promise<unknown> };
  findOneAndDelete(filter: Record<string, unknown>): { lean(): Promise<unknown> };
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  create(data: Record<string, unknown>): Promise<{ toObject(): unknown }>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
}

// ─── Repo Dependencies ──────────────────────────────────────────────────

export interface AgentAssistBindingRepoDeps {
  cache?: LRUTTLCache<IAgentAssistBinding>;
  model?: BindingModelLike;
}

// ─── Repo Implementation ────────────────────────────────────────────────

export function createAgentAssistBindingRepo(
  deps?: AgentAssistBindingRepoDeps,
): AgentAssistBindingResolver {
  const cache =
    deps?.cache ??
    new LRUTTLCache<IAgentAssistBinding>({
      maxEntries: AGENT_ASSIST_BINDING_CACHE_MAX,
      ttlMs: AGENT_ASSIST_BINDING_CACHE_TTL_MS,
    });
  const model: BindingModelLike = (deps?.model as BindingModelLike) ?? AgentAssistBinding;

  function invalidateEntry(tenantId: string, appId: string, environment: string): void {
    cache.delete(bindingCacheKey(tenantId, appId, environment));
  }

  return {
    async get(ctx, key) {
      const ck = bindingCacheKey(ctx.tenantId, key.appId, key.environment);
      const cached = cache.get(ck);
      if (cached) return cached;

      // Returns both `active` and `disabled` bindings so callers (e.g. the V1 facade)
      // can apply status-aware policy. The facade currently maps both
      // missing-binding and disabled-binding to 404 APP_NOT_FOUND for
      // existence-disclosure parity, but the lookup layer keeps both rows so
      // future callers (admin tooling) can distinguish them.
      const doc = await model
        .findOne({
          tenantId: ctx.tenantId,
          appId: key.appId,
          environment: key.environment.toLowerCase(),
        })
        .lean();

      if (doc) {
        cache.set(ck, doc as IAgentAssistBinding);
      }

      return (doc as IAgentAssistBinding) ?? null;
    },

    invalidate: invalidateEntry,

    async list(ctx, page) {
      const filter: { tenantId: string; projectId?: string } = { tenantId: ctx.tenantId };
      if (page.projectId) {
        filter.projectId = page.projectId;
      }
      const [items, total] = await Promise.all([
        model.find(filter).sort({ createdAt: -1 }).skip(page.offset).limit(page.limit).lean(),
        model.countDocuments(filter),
      ]);

      return { items: items as IAgentAssistBinding[], total };
    },

    async findByIdForTenant(ctx, id) {
      const doc = await model
        .findOne({
          _id: id,
          tenantId: ctx.tenantId,
        })
        .lean();

      return (doc as IAgentAssistBinding) ?? null;
    },

    async create(ctx, input) {
      try {
        const doc = await model.create({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          appId: input.appId,
          environment: input.environment.toLowerCase(),
          deploymentId: input.deploymentId ?? null,
          apiKeyId: input.apiKeyId ?? null,
          displayName: input.displayName ?? null,
          runtimeBaseUrl: input.runtimeBaseUrl ?? null,
          createdBy: ctx.actor,
          status: 'active',
        });

        const plain = doc.toObject() as IAgentAssistBinding;
        cache.set(bindingCacheKey(ctx.tenantId, plain.appId, plain.environment), plain);
        return plain;
      } catch (err: unknown) {
        if (isDuplicateKeyError(err)) {
          throw new AgentAssistBindingDuplicateError(ctx.tenantId, input.appId, input.environment);
        }
        throw err;
      }
    },

    async update(ctx, id, patch) {
      const update: Record<string, unknown> = { updatedBy: ctx.actor };
      if (patch.projectId !== undefined) update.projectId = patch.projectId;
      if (patch.deploymentId !== undefined) update.deploymentId = patch.deploymentId;
      if (patch.apiKeyId !== undefined) update.apiKeyId = patch.apiKeyId;
      if (patch.apiKeyPrefix !== undefined) update.apiKeyPrefix = patch.apiKeyPrefix;
      if (patch.displayName !== undefined) update.displayName = patch.displayName;
      if (patch.runtimeBaseUrl !== undefined) update.runtimeBaseUrl = patch.runtimeBaseUrl;

      const doc = await model
        .findOneAndUpdate({ _id: id, tenantId: ctx.tenantId }, { $set: update }, { new: true })
        .lean();

      if (!doc) {
        throw new AgentAssistBindingNotFoundError(id);
      }

      const plain = doc as IAgentAssistBinding;
      invalidateEntry(ctx.tenantId, plain.appId, plain.environment);
      return plain;
    },

    async setStatus(ctx, id, status) {
      const now = new Date();
      const update: Record<string, unknown> = {
        status,
        updatedBy: ctx.actor,
      };

      if (status === 'disabled') {
        update.disabledAt = now;
        update.disabledBy = ctx.actor;
      } else {
        update.disabledAt = null;
        update.disabledBy = null;
      }

      const doc = await model
        .findOneAndUpdate({ _id: id, tenantId: ctx.tenantId }, { $set: update }, { new: true })
        .lean();

      if (!doc) {
        throw new AgentAssistBindingNotFoundError(id);
      }

      const plain = doc as IAgentAssistBinding;
      invalidateEntry(ctx.tenantId, plain.appId, plain.environment);
      return plain;
    },

    async remove(ctx, id) {
      // Fetch first to get appId/environment for cache invalidation
      const doc = await model
        .findOneAndDelete({
          _id: id,
          tenantId: ctx.tenantId,
        })
        .lean();

      if (!doc) {
        throw new AgentAssistBindingNotFoundError(id);
      }

      const plain = doc as IAgentAssistBinding;
      invalidateEntry(ctx.tenantId, plain.appId, plain.environment);
    },

    async cascadeOnProjectDelete(tenantId, projectId) {
      const result = await model.deleteMany({
        tenantId,
        projectId,
      });

      const count = result.deletedCount ?? 0;
      if (count > 0) {
        log.info('Cascaded binding deletion on project delete', {
          tenantId,
          projectId,
          deletedCount: count,
        });
        // Clear entire cache — we don't know which keys to invalidate
        cache.clear();
      }

      return count;
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

export function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof Error && 'code' in err) {
    return (err as Error & { code: number }).code === 11000;
  }
  return false;
}
