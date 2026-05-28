/**
 * Internal Service Auth Middleware
 *
 * Verifies service-to-service JWTs on /api/internal/* routes.
 * Extracts tenantId and projectId from the verified token payload
 * so internal endpoints never trust raw request headers for identity.
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { verifyServiceToken, type ServiceTokenPayload } from '@agent-platform/shared-auth';
import { getConfig } from '../config/index.js';

const log = createLogger('internal-service-auth');

/** Extends Express Request with verified service token data */
export interface InternalServiceRequest extends Request {
  serviceToken: ServiceTokenPayload;
}

/**
 * Middleware that verifies a service-to-service JWT from the Authorization header.
 * Rejects with 401 if the token is missing, invalid, or not a service token.
 *
 * After verification, `req.serviceToken` contains the verified payload with
 * `tenantId` and `projectId` — use these instead of raw headers.
 */
export function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    log.warn('Missing authorization header on internal endpoint', {
      path: req.path,
    });
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing service authorization' },
    });
    return;
  }

  const token = authHeader.split(' ')[1];
  const secret = getConfig().jwt.secret;
  const payload = verifyServiceToken(token, secret);

  if (!payload) {
    log.warn('Invalid service token on internal endpoint', {
      path: req.path,
    });
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired service token' },
    });
    return;
  }

  (req as InternalServiceRequest).serviceToken = payload;

  // Cross-check projectId when present in both token and request (body, params, or query)
  const bodyProjectId =
    req.body?.projectId ?? req.params?.projectId ?? (req.query?.projectId as string | undefined);
  if (payload.projectId && bodyProjectId && payload.projectId !== bodyProjectId) {
    log.warn('Service token projectId mismatch', {
      path: req.path,
      tokenProjectId: payload.projectId,
      bodyProjectId,
    });
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Project ID mismatch with service token' },
    });
    return;
  }

  // Cross-check tenantId when present in the request. Closes a security gap where
  // a service token issued for tenant A could be used against an endpoint addressing
  // tenant B as long as projectId either matched or was absent from the token.
  const bodyTenantId =
    req.body?.tenantId ?? req.params?.tenantId ?? (req.query?.tenantId as string | undefined);
  if (bodyTenantId && payload.tenantId !== bodyTenantId) {
    log.warn('Service token tenantId mismatch', {
      path: req.path,
      tokenTenantId: payload.tenantId,
      bodyTenantId,
    });
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Tenant ID mismatch with service token' },
    });
    return;
  }

  next();
}

/**
 * Defense-in-depth cross-check for routes that read tenant/project IDs from the
 * request body and pass them to scoped queries. The base middleware
 * (`requireServiceAuth`) cross-checks tenant/project only when the body carries
 * those fields, and only requires projectId match when both sides have it. This
 * helper closes the asymmetric gap for project-scoped routes:
 *
 *  - The token's tenantId MUST equal the body tenantId.
 *  - The token MUST carry a projectId claim.
 *  - The token's projectId MUST equal the body projectId.
 *
 * Returns `null` when the request is allowed; returns a 403 envelope payload
 * otherwise. Caller writes the response and returns. Use this in any internal
 * route group whose handlers route on body-supplied tenant/project IDs (the
 * memory routes use it; tools/chat currently scope from the token directly and
 * don't need it).
 */
export function rejectIfTokenMismatch(
  serviceToken: { tenantId: string; projectId?: string },
  body: { tenantId: string; projectId: string },
): { code: 'FORBIDDEN'; message: string } | null {
  if (serviceToken.tenantId !== body.tenantId) {
    return { code: 'FORBIDDEN', message: 'Tenant ID mismatch with service token' };
  }
  if (!serviceToken.projectId) {
    return {
      code: 'FORBIDDEN',
      message: 'Service token must carry a projectId for project-scoped operations',
    };
  }
  if (serviceToken.projectId !== body.projectId) {
    return { code: 'FORBIDDEN', message: 'Project ID mismatch with service token' };
  }
  return null;
}
