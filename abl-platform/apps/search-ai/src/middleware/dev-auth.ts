/**
 * Development Authentication Bypass
 *
 * ONLY for local development testing. Injects a test tenant context
 * when NODE_ENV=development and DEV_BYPASS_AUTH=true.
 *
 * This mirrors the pattern used in E2E tests.
 */

import type { RequestHandler } from 'express';
import { getConfig } from '../config/index.js';

/**
 * Development tenant context injector.
 *
 * Usage:
 * 1. Set DEV_BYPASS_AUTH=true in .env
 * 2. Apply this middleware before routes in server.ts
 *
 * NEVER enable in production.
 */
export const devAuthBypass: RequestHandler = (req, _res, next) => {
  const config = getConfig();
  const bypassEnabled = process.env.DEV_BYPASS_AUTH === 'true';

  if (config.env === 'dev' && bypassEnabled && !req.tenantContext) {
    // Read tenantId from x-tenant-id header, query param (SSE EventSource
    // fallback — EventSource cannot set custom headers), or default
    const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
    const queryTenantId = (req.query?.tenantId as string) || undefined;
    const tenantId = headerTenantId || queryTenantId || process.env.DEV_TENANT_ID || 'dev-tenant-1';

    // Inject test tenant context (same structure as E2E tests)
    (req as any).tenantContext = {
      tenantId,
      orgId: undefined,
      userId: process.env.DEV_USER_ID || 'dev-user',
      role: 'ADMIN',
      permissions: ['*'],
      authType: 'user' as const,
      isSuperAdmin: false,
    };
    console.log('[dev-auth] Injected test tenant context:', {
      tenantId: (req as any).tenantContext.tenantId,
      userId: (req as any).tenantContext.userId,
    });
  }

  next();
};
