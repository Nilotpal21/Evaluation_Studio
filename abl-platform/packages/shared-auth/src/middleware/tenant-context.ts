/**
 * Tenant Context (AsyncLocalStorage)
 *
 * Propagates tenant context through entire async call chain
 * without parameter drilling. Used by:
 * - MongoDB tenant-isolation plugin (auto-inject tenantId filters)
 * - Audit service (auto-attach tenantId)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContextData } from '../types/index.js';

// Re-export the type for convenience
export type { TenantContextData } from '../types/index.js';

const tenantStorage = new AsyncLocalStorage<TenantContextData>();

/**
 * Run a function within a tenant context.
 * All async operations within the callback will have access to the tenant.
 */
export function runWithTenantContext<T>(context: TenantContextData, fn: () => T): T {
  return tenantStorage.run(context, fn);
}

/**
 * Get the current tenant ID from AsyncLocalStorage.
 * Returns undefined if not within a tenant context.
 */
export function getCurrentTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

/**
 * Get the current user ID from AsyncLocalStorage.
 */
export function getCurrentUserId(): string | undefined {
  return tenantStorage.getStore()?.userId;
}

/**
 * Check if the current context is a super-admin context.
 * Super-admin bypasses RLS for cross-tenant operations.
 */
export function isSuperAdminContext(): boolean {
  return tenantStorage.getStore()?.isSuperAdmin ?? false;
}

/**
 * Get the full tenant context data.
 */
export function getTenantContextData(): TenantContextData | undefined {
  return tenantStorage.getStore();
}
