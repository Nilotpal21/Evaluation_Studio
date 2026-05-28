/**
 * Workflow-Engine Route Helpers
 *
 * Shared Express building blocks used across every route file so they emit
 * consistent error shapes and don't leak unhandled async rejections.
 *
 *   `requireTenantProjectParams` — 400 with the canonical structured error
 *     shape `{ success: false, error: { code, message } }` when either
 *     `tenantContext.tenantId` or `req.params.projectId` is missing. Before
 *     this existed, workflow-executions returned the structured shape while
 *     connections / workflow-approvals / notification-rules / triggers /
 *     human-task-resolution returned a bare string `error: 'Missing ...'`.
 *
 *   `asyncHandler` — wraps an async handler so rejected promises flow into
 *     `next(err)` instead of becoming unhandled rejections. Express 4 does
 *     not do this; Express 5 does. Until we upgrade, every async handler
 *     should be wrapped.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * `tenantContext` is attached upstream by `createUnifiedAuthMiddleware` but is
 * not part of the Express type surface. Callers extract it through this helper
 * rather than `(req as any).tenantContext` so the cast lives in one place.
 */
export function getTenantId(req: Request): string | undefined {
  const ctx = (req as Request & { tenantContext?: { tenantId?: unknown } }).tenantContext;
  const tenantId = ctx?.tenantId;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined;
}

export interface RequireTenantProjectResult {
  tenantId: string;
  projectId: string;
}

export interface RequireTenantProjectOptions {
  /**
   * Additional `req.params` keys that must be non-empty strings. When any are
   * missing, the same 400 shape is returned. Use this for routes mounted
   * under `/:workflowId` etc.
   */
  requireParams?: readonly string[];
}

/**
 * Extract `{ tenantId, projectId }` (plus any additional required params)
 * from the request, or send a 400 with the canonical error shape and return
 * `null`. Callers use the `null` return to short-circuit:
 *
 *   const ctx = requireTenantProject(req, res);
 *   if (!ctx) return;
 *   const { tenantId, projectId } = ctx;
 */
export function requireTenantProject(
  req: Request,
  res: Response,
  opts: RequireTenantProjectOptions = {},
): (RequireTenantProjectResult & Record<string, string>) | null {
  const tenantId = getTenantId(req);
  const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : undefined;

  const missing: string[] = [];
  if (!tenantId) missing.push('tenantId');
  if (!projectId) missing.push('projectId');

  const extra: Record<string, string> = {};
  for (const key of opts.requireParams ?? []) {
    const value = req.params[key];
    if (typeof value === 'string' && value.length > 0) {
      extra[key] = value;
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0 || !tenantId || !projectId) {
    res.status(400).json({
      success: false,
      error: {
        code: 'MISSING_PARAMETERS',
        message: `Missing required parameters: ${missing.join(', ')}`,
      },
    });
    return null;
  }

  return { tenantId, projectId, ...extra };
}

/**
 * Wrap an async Express handler so a rejected promise forwards to `next()`
 * instead of becoming an unhandled rejection. Express 5 does this natively;
 * Express 4 does not.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
