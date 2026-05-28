/**
 * Shared helpers for guardrail route handlers.
 *
 * Extracted from guardrail-policies.ts so that both the policy CRUD route
 * and the pii-entities route can share scope-resolution and permission logic.
 */

import { requirePermissionInline, requireProjectPermission } from '../middleware/rbac.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteScopeContext = { level: 'tenant' } | { level: 'project'; projectId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getRouteScopeContext(req: any): RouteScopeContext {
  const projectId = getProjectId(req);
  return projectId ? { level: 'project', projectId } : { level: 'tenant' };
}

export function buildScopedPolicyFilter(
  tenantId: string,
  context: RouteScopeContext,
  policyId?: string,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { tenantId };
  if (policyId) {
    filter._id = policyId;
  }

  if (context.level === 'tenant') {
    filter['scope.type'] = 'tenant';
  } else {
    filter['scope.projectId'] = context.projectId;
  }

  return filter;
}

/**
 * Enforces guardrail/pii-pattern permission scoped by request context.
 * Note: tenant-scope branch calls synchronous requirePermissionInline;
 * await is a no-op for that path.
 */
export async function requireRouteScopePermission(
  req: any,
  res: any,
  context: RouteScopeContext,
  permission: string,
): Promise<boolean> {
  if (context.level === 'tenant') {
    return requirePermissionInline(req, res, permission);
  }
  return requireProjectPermission(req, res, permission, context.projectId);
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — used only by getRouteScopeContext)
// ---------------------------------------------------------------------------

function getProjectId(req: any): string | null {
  const projectId = req.params.projectId;
  if (!projectId || typeof projectId !== 'string') return null;
  return projectId;
}
