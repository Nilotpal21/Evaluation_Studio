/**
 * Tenant Isolation Plugin
 *
 * Automatically injects tenantId filter on all read/write operations
 * for tenant-scoped models. Uses AsyncLocalStorage for request context.
 *
 * Supports two ALS sources (checked in order):
 * 1. External provider (shared-auth) — registered via registerTenantContextProvider()
 * 2. Local ALS — set via withTenantContext() (backward compat for search-ai workers)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Schema, Query } from 'mongoose';

// ─── Tenant Context ──────────────────────────────────────────────────────

export interface TenantContext {
  tenantId: string;
  isSuperAdmin?: boolean;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * External tenant context provider.
 * When registered, getCurrentTenantContext() checks this first before the local ALS.
 * This allows shared-auth's ALS to be the single source of truth without
 * creating a circular dependency (database → shared-auth).
 */
type TenantContextProvider = () => TenantContext | undefined;
let externalProvider: TenantContextProvider | undefined;

/**
 * Register an external tenant context provider (e.g., from shared-auth).
 * The provider is checked first by getCurrentTenantContext(), before the local ALS.
 * Call this once at application startup.
 */
export function registerTenantContextProvider(provider: TenantContextProvider): void {
  externalProvider = provider;
}

/**
 * Run a function within a tenant context.
 * All database operations inside will be scoped to this tenant.
 */
export function withTenantContext<T>(context: TenantContext, fn: () => T): T {
  return tenantStorage.run(context, fn);
}

/**
 * Get the current tenant context from AsyncLocalStorage.
 * Checks the external provider (shared-auth) first, then the local ALS.
 */
export function getCurrentTenantContext(): TenantContext | undefined {
  // 1. Check external provider (shared-auth ALS) first
  if (externalProvider) {
    const external = externalProvider();
    if (external) return external;
  }
  // 2. Fall back to local ALS (search-ai workers, direct withTenantContext calls)
  return tenantStorage.getStore();
}

/**
 * Run a function in super-admin context (bypasses tenant isolation).
 */
export function withSuperAdminContext<T>(fn: () => T): T {
  return tenantStorage.run({ tenantId: '', isSuperAdmin: true }, fn);
}

// ─── Plugin ──────────────────────────────────────────────────────────────

/**
 * Mongoose plugin that enforces tenant isolation.
 *
 * Applied to schemas with a `tenantId` field. Auto-injects tenantId
 * into query filters and new documents.
 *
 * Usage:
 *   schema.plugin(tenantIsolationPlugin);
 */
export function tenantIsolationPlugin(schema: Schema): void {
  // ── Read Operations ────────────────────────────────────────────────
  const readOps = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'estimatedDocumentCount',
    'distinct',
    'deleteOne',
    'deleteMany',
    'updateOne',
    'updateMany',
    'replaceOne',
  ] as const;

  for (const op of readOps) {
    schema.pre(op, function (this: Query<any, any>) {
      injectTenantFilter(this);
    });
  }

  // ── Aggregation ────────────────────────────────────────────────────
  schema.pre('aggregate', function () {
    const ctx = getCurrentTenantContext();
    if (!ctx || ctx.isSuperAdmin) return;

    // Prepend $match { tenantId } as first pipeline stage
    const pipeline = this.pipeline();
    const hasMatch = pipeline.length > 0 && '$match' in pipeline[0] && pipeline[0].$match?.tenantId;

    if (!hasMatch) {
      pipeline.unshift({ $match: { tenantId: ctx.tenantId } });
    }
  });

  // ── Save (insert) — set tenantId before validation so required:true passes
  schema.pre('validate', function () {
    const ctx = getCurrentTenantContext();
    if (!ctx || ctx.isSuperAdmin) return;

    if (this.isNew) {
      const existingTenantId = this.get('tenantId');
      if (!existingTenantId) {
        // Auto-set from context
        this.set('tenantId', ctx.tenantId);
      } else if (existingTenantId !== ctx.tenantId) {
        // SECURITY: Reject cross-tenant write attempt
        throw new Error(
          `Tenant isolation violation: document tenantId (${existingTenantId}) ` +
            `does not match context tenantId (${ctx.tenantId})`,
        );
      }
    }
  });

  // ── insertMany ────────────────────────────────────────────────────
  schema.pre('insertMany', function (next, docs: any[]) {
    const ctx = getCurrentTenantContext();
    if (!ctx || ctx.isSuperAdmin) {
      next();
      return;
    }

    for (const doc of docs) {
      if (!doc.tenantId) {
        doc.tenantId = ctx.tenantId;
      } else if (doc.tenantId !== ctx.tenantId) {
        // SECURITY: Reject cross-tenant write attempt
        next(
          new Error(
            `Tenant isolation violation: document tenantId (${doc.tenantId}) ` +
              `does not match context tenantId (${ctx.tenantId})`,
          ),
        );
        return;
      }
    }
    next();
  });
}

// ─── Internal ────────────────────────────────────────────────────────────

function injectTenantFilter(query: Query<any, any>): void {
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.isSuperAdmin) return;

  const filter = query.getFilter();
  if (filter.tenantId && filter.tenantId !== ctx.tenantId) {
    // SECURITY: Query specifies a different tenant than context
    throw new Error(
      `Tenant isolation violation: query tenantId (${filter.tenantId}) ` +
        `does not match context tenantId (${ctx.tenantId})`,
    );
  }
  if (!filter.tenantId) {
    query.where('tenantId').equals(ctx.tenantId);
  }
}
