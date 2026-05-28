/**
 * Permission Guard Middleware
 *
 * Express middleware factory that checks the current TenantContextData
 * for required permissions before allowing the request through.
 *
 * Usage:
 *   router.post('/projects', requirePermission('project:create'), handler);
 *   router.delete('/agents/:id', requireAllPermissions(['agent:delete', 'agent:read']), handler);
 */

import type { Request, Response, NextFunction } from 'express';
import { hasPermission, hasAllPermissions, hasAnyPermission } from '../rbac/permission-resolver.js';
import type { TenantContextData } from '../types/index.js';
import { getRequestAccessDeniedReporter } from './access-denial.js';

/**
 * Create middleware that requires a single permission.
 * Super-admin does NOT bypass — super-admins manage platform config only,
 * not tenant data. Use `requirePlatformAdmin()` for platform-level routes.
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'permission_guard',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
        requiredPermission: permission,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    if (!hasPermission(ctx.permissions, permission)) {
      getRequestAccessDeniedReporter(req)({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        reason: `Missing required permission '${permission}'`,
        concealAsNotFound: false,
        statusCode: 403,
        requiredPermission: permission,
      });
      res.status(403).json({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: permission,
        authType: ctx.authType,
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that requires ALL listed permissions.
 */
export function requireAllPermissions(permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'permission_guard',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
        requiredPermission: permissions,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    if (!hasAllPermissions(ctx.permissions, permissions)) {
      getRequestAccessDeniedReporter(req)({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        reason: 'Missing one or more required permissions',
        concealAsNotFound: false,
        statusCode: 403,
        requiredPermission: permissions,
      });
      res.status(403).json({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: permissions,
        authType: ctx.authType,
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that requires ANY of the listed permissions.
 */
export function requireAnyPermission(permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'permission_guard',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
        requiredPermission: permissions,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    if (!hasAnyPermission(ctx.permissions, permissions)) {
      getRequestAccessDeniedReporter(req)({
        layer: 'permission_guard',
        scope: 'rbac',
        reasonCode: 'PERMISSION_REQUIRED',
        reason: 'Missing any acceptable permission',
        concealAsNotFound: false,
        statusCode: 403,
        requiredPermission: permissions,
      });
      res.status(403).json({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: permissions,
        authType: ctx.authType,
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that enforces API key project/environment scoping.
 * If the request's tenantContext has projectScope, the project ID from
 * the route params (or query) must be in the allowed list.
 *
 * Usage:
 *   router.use('/projects/:projectId', requireProjectScope('projectId'), handler);
 */
export function requireProjectScope(
  paramName = 'projectId',
  options: { concealOutOfScope?: boolean } = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'project_scope',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    // Non-scoped contexts pass through (no API key project restriction)
    if (!ctx.projectScope || ctx.projectScope.length === 0) {
      next();
      return;
    }

    const projectId = req.params[paramName] || (req.query[paramName] as string);
    if (!projectId) {
      // No project in request — allow (the route may not be project-specific)
      next();
      return;
    }

    if (!ctx.projectScope.includes(projectId)) {
      const conceal = options.concealOutOfScope === true;
      getRequestAccessDeniedReporter(req)({
        layer: 'project_scope',
        scope: 'project',
        reasonCode: 'PROJECT_SCOPE_MISMATCH',
        reason: 'API key does not have access to this project',
        concealAsNotFound: conceal,
        statusCode: conceal ? 404 : 403,
        resourceType: 'project',
        resourceId: projectId,
      });
      if (conceal) {
        res.status(404).json({
          success: false,
          error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
        });
        return;
      }
      res.status(403).json({
        success: false,
        error: { code: 'PROJECT_SCOPE_MISMATCH', message: 'Forbidden' },
        message: 'API key does not have access to this project',
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that enforces API key environment scoping.
 * If the request's tenantContext has environmentScope, the environment from
 * the route params, query, or body must be in the allowed list.
 */
export function requireEnvironmentScope(paramName = 'environment') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'environment_scope',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    if (!ctx.environmentScope || ctx.environmentScope.length === 0) {
      next();
      return;
    }

    const env =
      req.params[paramName] ||
      (req.query[paramName] as string) ||
      ((req.body as Record<string, unknown>)?.[paramName] as string);
    if (!env) {
      next();
      return;
    }

    if (!ctx.environmentScope.includes(env)) {
      getRequestAccessDeniedReporter(req)({
        layer: 'environment_scope',
        scope: 'project',
        reasonCode: 'ENVIRONMENT_SCOPE_MISMATCH',
        reason: 'API key does not have access to this environment',
        concealAsNotFound: false,
        statusCode: 403,
        resourceType: 'environment',
        resourceId: env,
      });
      res.status(403).json({
        success: false,
        error: { code: 'ENVIRONMENT_SCOPE_MISMATCH', message: 'Forbidden' },
        message: 'API key does not have access to this environment',
      });
      return;
    }

    next();
  };
}

/**
 * Create middleware that restricts access to specific auth types.
 * Example: `requireAuthType('user')` — only allow Studio/JWT users.
 */
export function requireAuthType(...authTypes: TenantContextData['authType'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'auth_type',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    if (!authTypes.includes(ctx.authType)) {
      getRequestAccessDeniedReporter(req)({
        layer: 'auth_type',
        scope: 'rbac',
        reasonCode: 'AUTH_TYPE_REQUIRED',
        reason: `This endpoint requires ${authTypes.join(' or ')} authentication`,
        concealAsNotFound: false,
        statusCode: 403,
        metadata: { allowedAuthTypes: authTypes },
      });
      res.status(403).json({
        success: false,
        error: { code: 'AUTH_TYPE_REQUIRED', message: 'Forbidden' },
        message: `This endpoint requires ${authTypes.join(' or ')} authentication`,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware that restricts access to platform super-admins only.
 * Use this for platform-level configuration routes (model catalog management,
 * platform settings, system health) — NOT for tenant data access.
 *
 * Super-admins are identified by `SUPER_ADMIN_USER_IDS` config, not by
 * any tenant role. They manage platform config, not customer data.
 */
export function requirePlatformAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.tenantContext;
    if (!ctx) {
      getRequestAccessDeniedReporter(req)({
        layer: 'platform_admin',
        scope: 'auth',
        reasonCode: 'AUTHENTICATION_REQUIRED',
        reason: 'Authentication required',
        concealAsNotFound: false,
        statusCode: 401,
      });
      res.status(401).json({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
      });
      return;
    }

    if (!ctx.isSuperAdmin) {
      getRequestAccessDeniedReporter(req)({
        layer: 'platform_admin',
        scope: 'rbac',
        reasonCode: 'PLATFORM_ADMIN_REQUIRED',
        reason: 'This endpoint requires platform administrator access',
        concealAsNotFound: false,
        statusCode: 403,
      });
      res.status(403).json({
        success: false,
        error: { code: 'PLATFORM_ADMIN_REQUIRED', message: 'Forbidden' },
        message: 'This endpoint requires platform administrator access',
      });
      return;
    }

    next();
  };
}

// =============================================================================
// IP ALLOWLISTING
// =============================================================================

/**
 * Parse a CIDR notation string into base IP (as 32-bit number) and mask.
 * Returns null if the input is not valid CIDR.
 */
function parseCIDR(cidr: string): { base: number; mask: number } | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  const ip = ipToNumber(parts[0]);
  if (ip === null) return null;
  const prefix = parseInt(parts[1], 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

/**
 * Convert an IPv4 address string to a 32-bit unsigned number.
 * Returns null if invalid.
 */
function ipToNumber(ip: string): number | null {
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  let num = 0;
  for (const o of octets) {
    const v = parseInt(o, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    num = ((num << 8) | v) >>> 0;
  }
  return num;
}

/**
 * Check if an IP address matches a single allowlist entry.
 * Entries can be plain IPs ("10.0.0.1") or CIDR ranges ("10.0.0.0/24").
 */
function ipMatchesEntry(clientIp: string, entry: string): boolean {
  // Strip IPv6-mapped IPv4 prefix (::ffff:x.x.x.x)
  const normalised = clientIp.replace(/^::ffff:/, '');

  if (entry.includes('/')) {
    const cidr = parseCIDR(entry);
    if (!cidr) return false;
    const ip = ipToNumber(normalised);
    if (ip === null) return false;
    return (ip & cidr.mask) >>> 0 === cidr.base;
  }

  return normalised === entry;
}

/**
 * Check if an IP is in the allowlist. Supports plain IPs and CIDR ranges.
 */
export function isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return true; // No list = no restriction
  return allowedIps.some((entry) => ipMatchesEntry(clientIp, entry));
}

/**
 * Middleware that restricts access by IP allowlist.
 * Designed for platform admin routes as an additional defense layer.
 *
 * If the allowlist is empty, the middleware passes through (no restriction).
 * Configure via `PLATFORM_ADMIN_ALLOWED_IPS` env var (comma-separated).
 *
 * @param getAllowedIps - Function that returns the current allowlist. Called per-request
 *   so hot-reloadable config changes take effect immediately.
 */
export function requirePlatformAdminIp(getAllowedIps: () => string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const allowedIps = getAllowedIps();
    if (allowedIps.length === 0) {
      next();
      return;
    }

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';

    if (!isIpAllowed(clientIp, allowedIps)) {
      getRequestAccessDeniedReporter(req)({
        layer: 'platform_admin_ip',
        scope: 'rbac',
        reasonCode: 'PLATFORM_ADMIN_IP_NOT_ALLOWED',
        reason: 'Access denied: IP address not in platform admin allowlist',
        concealAsNotFound: false,
        statusCode: 403,
        metadata: { clientIp },
      });
      res.status(403).json({
        success: false,
        error: { code: 'PLATFORM_ADMIN_IP_NOT_ALLOWED', message: 'Forbidden' },
        message: 'Access denied: IP address not in platform admin allowlist',
      });
      return;
    }

    next();
  };
}
