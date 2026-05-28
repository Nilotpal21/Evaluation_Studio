/**
 * End-User Auth Routes
 *
 * POST /api/search/auth/token — Exchange IdP token for search session token
 *
 * Headers:
 * - X-End-User-Token: {idpJWT} — Required. IdP-issued JWT.
 * - X-Index-Id: {indexId} — Required. Identifies project scope.
 *
 * Response:
 * - 200: { success: true, token: string, expiresIn: number, user: { email, domain } }
 * - 400: Missing required headers
 * - 401: Invalid/expired IdP token
 * - 403: End-user access not enabled or domain not allowed
 * - 404: Index not found
 */

import { Router, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import {
  getEndUserAuthService,
  EndUserAuthError,
} from '../services/end-user/end-user-auth.service.js';

const logger = createLogger('search-runtime-auth-route');

export function createAuthRouter(): RouterType {
  const router: RouterType = Router();

  /**
   * POST /token
   *
   * Exchange IdP token for a search session token.
   * No API key required — indexId identifies the project, IdP token proves identity.
   */
  router.post('/token', async (req, res) => {
    try {
      // Read required headers
      const idpToken = req.header('X-End-User-Token');
      const indexId = req.header('X-Index-Id');

      if (!idpToken) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_IDP_TOKEN',
            message: 'X-End-User-Token header is required',
          },
        });
        return;
      }

      if (!indexId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INDEX_ID',
            message: 'X-Index-Id header is required',
          },
        });
        return;
      }

      // Authenticate and issue session token
      const service = getEndUserAuthService();
      const result = await service.authenticateAndIssueToken({
        idpToken,
        indexId,
      });

      logger.info('Search session token issued', {
        email: result.user.email,
        domain: result.user.domain,
        expiresIn: result.expiresIn,
      });

      res.status(200).json({
        success: true,
        token: result.sessionToken,
        expiresIn: result.expiresIn,
        user: {
          email: result.user.email,
          domain: result.user.domain,
        },
      });
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
      logger.error('Token exchange failed', { error: message });

      // Map JWT/validation errors to appropriate status codes.
      // Sanitize messages — do not leak internal details (issuer URLs, claim names).
      if (
        message.includes('expired') ||
        message.includes('invalid signature') ||
        message.includes('jwt malformed') ||
        message.includes('Token missing') ||
        message.includes('Invalid token') ||
        message.includes('signing key') ||
        message.includes('issuer mismatch')
      ) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_IDP_TOKEN',
            message: 'IdP token is invalid or expired',
          },
        });
        return;
      }

      if (message.includes('domain') && message.includes('not in allowed')) {
        res.status(403).json({
          success: false,
          error: {
            code: 'DOMAIN_NOT_ALLOWED',
            message: 'Email domain is not allowed for this project',
          },
        });
        return;
      }

      if (message.includes('audience')) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUDIENCE_MISMATCH',
            message: 'Token audience does not match expected client',
          },
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Token exchange failed',
        },
      });
    }
  });

  return router;
}

export default createAuthRouter();
