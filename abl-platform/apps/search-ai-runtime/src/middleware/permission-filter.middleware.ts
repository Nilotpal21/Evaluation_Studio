import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { getIdPTokenValidator } from '../services/idp/idp-token-validator-compat.js';
import type { UserIdentity } from '@agent-platform/shared-auth/idp';
import { RedisClient } from '../services/cache/redis-client.js';
import {
  resolveValidationConfigForToken,
  EndUserAuthError,
} from '../services/end-user/end-user-auth.service.js';

const logger = createLogger('permission-filter-middleware');

/**
 * Authentication mode for search queries
 */
export type AuthMode = 'public' | 'user';

/**
 * Extended Request type with permission context
 */
export interface PermissionAwareRequest extends Request {
  authMode: AuthMode;
  userIdentity?: UserIdentity;
}

/**
 * Permission Filter Middleware
 *
 * Handles X-Auth-Mode and X-End-User-Token headers for search queries.
 * Routes to user mode (IdP-based) or public mode (public content only).
 *
 * Design:
 * - Backward compatible: Defaults to public mode if X-Auth-Mode not provided
 * - User mode requires valid X-End-User-Token (IdP JWT)
 * - Validates IdP token and extracts user identity
 * - Sets req.authMode and req.userIdentity for downstream handlers
 *
 * Headers:
 * - Authorization: Bearer {apiKey} (existing platform auth, unchanged)
 * - X-Auth-Mode: "user" | "public" (optional, default: "public")
 * - X-End-User-Token: {idpToken} (required if X-Auth-Mode = "user")
 *
 * Security:
 * - Platform auth (API key) validates tenant access (existing)
 * - IdP token validates end-user identity (new)
 * - Both layers required for user mode
 * - Public mode only requires platform auth
 */
export function createPermissionFilterMiddleware(redisClient: RedisClient) {
  const idpValidator = getIdPTokenValidator(redisClient);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const permReq = req as PermissionAwareRequest;

    // SECURITY: Require tenantContext from unified auth middleware
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'MISSING_TENANT_CONTEXT', message: 'Authentication required' },
      });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    try {
      // Step 0: If end-user auth middleware already resolved identity, propagate it.
      // This handles the case where end-user authenticates via session token or
      // direct IdP token through the end-user-auth.middleware (Paths A, C).
      if ((req as any).authMode === 'user' && (req as any).userIdentity) {
        permReq.authMode = 'user';
        permReq.userIdentity = (req as any).userIdentity;
        logger.debug('User mode (pre-resolved by end-user auth middleware)', { tenantId });
        return next();
      }

      // Step 1: Read X-Auth-Mode header (default: "public")
      const authModeHeader = req.header('X-Auth-Mode')?.toLowerCase();
      const authMode: AuthMode = authModeHeader === 'user' ? 'user' : 'public';

      // Step 2: Handle public mode (default, backward compatible)
      if (authMode === 'public') {
        permReq.authMode = 'public';
        permReq.userIdentity = undefined;
        logger.debug('Public mode (no IdP token)', { tenantId });
        return next();
      }

      // Step 3: Handle user mode (IdP-based or internal service-forwarded)
      //
      // Two sub-paths:
      // (a) X-End-User-Token: External IdP JWT — validate signature via JWKS
      // (b) X-User-Identity: Trusted internal service forwarding pre-validated identity
      //     (only accepted from service tokens — sub starts with "service:")
      //
      const idpToken = req.header('X-End-User-Token');
      const userIdentityHeader = req.header('X-User-Identity');

      // Path (b): Internal service forwarding user identity (e.g., Runtime → SearchAI)
      if (!idpToken && userIdentityHeader) {
        const callerUserId = req.tenantContext?.userId;
        const isInternalService =
          typeof callerUserId === 'string' && callerUserId.startsWith('service:');
        if (!isInternalService) {
          logger.warn('X-User-Identity rejected — caller is not an internal service', {
            tenantId,
          });
          res.status(403).json({
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'X-User-Identity can only be used by internal services',
            },
          });
          return;
        }

        try {
          const parsed = JSON.parse(userIdentityHeader);
          if (!parsed.email || typeof parsed.email !== 'string') {
            throw new Error('X-User-Identity must contain email');
          }
          const forwardedIdentity: UserIdentity = {
            email: parsed.email.toLowerCase(),
            name: parsed.name ?? undefined,
            idpUserId: parsed.idpUserId ?? parsed.email,
            idpProvider: parsed.idpProvider ?? 'custom',
            domain: parsed.domain ?? parsed.email.split('@')[1] ?? '',
            groups: Array.isArray(parsed.groups) ? parsed.groups : undefined,
          };
          permReq.authMode = 'user';
          permReq.userIdentity = forwardedIdentity;
          logger.info('User mode (internal service forwarded identity)', {
            tenantId,
            email: forwardedIdentity.email,
            callerService: callerUserId,
          });
          return next();
        } catch (parseError) {
          logger.error('Failed to parse X-User-Identity header', {
            tenantId,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          });
          res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_USER_IDENTITY',
              message: 'X-User-Identity header must be valid JSON with email field',
            },
          });
          return;
        }
      }

      // Path (a): External IdP token validation
      if (!idpToken) {
        logger.warn('User mode requested but X-End-User-Token missing', {
          tenantId: tenantId,
        });
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_END_USER_TOKEN',
            message: 'X-End-User-Token header required when X-Auth-Mode is "user"',
          },
        });
        return;
      }

      // Step 4: Validate IdP token (with multi-IdP issuer pre-match when profiles configured)
      try {
        // Try to resolve validation config from project's auth profiles (Path D multi-IdP).
        // If profiles are configured, this does issuer pre-match and returns config.
        // If no profiles configured, returns undefined → fall back to JWKS-only (backward compat).
        const projectId = req.tenantContext?.projectId;
        let validationConfig;
        if (projectId) {
          try {
            validationConfig = await resolveValidationConfigForToken(idpToken, tenantId, projectId);
          } catch (resolveErr) {
            if (resolveErr instanceof EndUserAuthError) {
              res.status(resolveErr.statusCode).json({
                success: false,
                error: { code: resolveErr.code, message: resolveErr.message },
              });
              return;
            }
            // Non-auth errors: fall through to JWKS-only
            logger.warn('Failed to resolve validation config, falling back to JWKS-only', {
              tenantId,
              error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
            });
          }
        }

        const userIdentity = await idpValidator.validateToken(
          idpToken,
          tenantId,
          validationConfig ?? undefined,
        );

        // Step 5: Set request context for downstream handlers
        permReq.authMode = 'user';
        permReq.userIdentity = userIdentity;

        logger.info('User mode authenticated', {
          tenantId,
          email: userIdentity.email,
          provider: userIdentity.idpProvider,
          multiIdp: !!validationConfig,
        });

        next();
      } catch (error) {
        if (error instanceof EndUserAuthError) {
          res.status(error.statusCode).json({
            success: false,
            error: { code: error.code, message: error.message },
          });
          return;
        }

        logger.error('IdP token validation failed', {
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });

        // Return 401 for invalid tokens
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_END_USER_TOKEN',
            message: error instanceof Error ? error.message : 'Failed to validate end-user token',
          },
        });
        return;
      }
    } catch (error) {
      logger.error('Permission filter middleware error', {
        tenantId: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to process authentication mode',
        },
      });
    }
  };
}
