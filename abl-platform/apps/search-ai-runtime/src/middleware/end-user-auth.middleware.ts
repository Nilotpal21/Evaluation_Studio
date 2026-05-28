/**
 * End-User Auth Middleware
 *
 * Runs BEFORE the existing authMiddleware in the query router chain.
 * Handles requests from end-users who authenticate via IdP tokens
 * (no API key required).
 *
 * Decision logic:
 * - If Authorization header present → pass through (let authMiddleware handle)
 * - If X-Auth-Mode: user + no Authorization → handle end-user auth
 * - Otherwise → pass through
 *
 * When handling end-user auth:
 * - Resolves tenant from indexId (URL parameter)
 * - Validates session token (X-Search-Session-Token) or IdP token (X-End-User-Token)
 * - Sets req.tenantContext so downstream middleware works unchanged
 * - Sets req.authMode and req.userIdentity for permission filter
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';
import {
  getEndUserAuthService,
  EndUserAuthError,
} from '../services/end-user/end-user-auth.service.js';
import type { UserIdentity } from '@agent-platform/shared-auth/idp';

const logger = createLogger('end-user-auth-middleware');

/**
 * Create end-user auth middleware.
 *
 * This middleware intercepts requests that:
 * 1. Have NO Authorization header (no API key / platform JWT)
 * 2. Have X-Auth-Mode: user header
 *
 * For matching requests, it resolves identity and sets tenantContext.
 * Non-matching requests pass through unchanged.
 */
export function createEndUserAuthMiddleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Guard: If Authorization header is present, skip — existing auth handles it
    const authHeader = req.headers.authorization;
    if (authHeader) {
      return next();
    }

    // Guard: Only activate for X-Auth-Mode: user
    const authMode = req.header('X-Auth-Mode')?.toLowerCase();
    if (authMode !== 'user') {
      return next();
    }

    // End-user auth path: resolve identity from tokens
    const indexId = req.params.indexId;
    if (!indexId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_INDEX_ID',
          message: 'indexId parameter required for end-user authentication',
        },
      });
      return;
    }

    const sessionToken = req.header('X-Search-Session-Token');
    const idpToken = req.header('X-End-User-Token');

    if (!sessionToken && !idpToken) {
      res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message:
            'End-user authentication required. Provide X-Search-Session-Token or X-End-User-Token header.',
        },
      });
      return;
    }

    try {
      const service = getEndUserAuthService();
      const result = await service.resolveEndUserIdentity({
        indexId,
        sessionToken: sessionToken ?? undefined,
        idpToken: idpToken ?? undefined,
      });

      // Set tenantContext — same shape as authMiddleware sets
      req.tenantContext = {
        tenantId: result.tenantId,
        userId: result.userIdentity.email,
        role: 'end_user',
        permissions: ['search:read', 'search:query', 'knowledge_base:read'],
        authType: 'api_key', // Closest existing type for downstream compat
        isSuperAdmin: false,
        projectId: result.projectId,
      };

      // Set end-user specific context for permission filter
      (req as any).authMode = 'user';
      (req as any).userIdentity = result.userIdentity;
      (req as any).endUserContactId = result.contactId;
      // Propagate configured rate limits for downstream rate-limit middleware
      if (result.rateLimits) {
        (req as any).endUserRateLimits = result.rateLimits;
      }

      logger.info('End-user authenticated via middleware', {
        tenantId: result.tenantId,
        projectId: result.projectId,
        email: result.userIdentity.email,
        provider: result.userIdentity.idpProvider,
        authMethod: sessionToken ? 'session_token' : 'idp_token',
      });

      next();
    } catch (error) {
      if (error instanceof EndUserAuthError) {
        res.status(error.statusCode).json({
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('End-user auth middleware error', { error: message, indexId });

      // Map common JWT errors to appropriate status codes
      if (
        message.includes('expired') ||
        message.includes('invalid signature') ||
        message.includes('jwt malformed')
      ) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Authentication token is invalid or expired',
          },
        });
        return;
      }

      res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_FAILED',
          message: 'End-user authentication failed',
        },
      });
    }
  };
}
