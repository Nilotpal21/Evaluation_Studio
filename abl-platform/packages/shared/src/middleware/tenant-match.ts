import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that validates the URL :tenantId param matches the authenticated
 * user's tenantContext.tenantId from the JWT.  Returns 404 (not 403) on
 * mismatch to avoid leaking tenant existence — consistent with platform
 * resource-isolation conventions.
 *
 * Super-admins (isSuperAdmin === true) bypass the check.
 */
export function requireTenantMatch(req: Request, res: Response, next: NextFunction): void {
  const paramTenantId = req.params.tenantId;
  const tenantContext = (req as any).tenantContext;
  const contextTenantId = tenantContext?.tenantId;

  if (!paramTenantId || !contextTenantId) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    return;
  }

  if (tenantContext.isSuperAdmin) {
    next();
    return;
  }

  if (paramTenantId !== contextTenantId) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    return;
  }

  next();
}
