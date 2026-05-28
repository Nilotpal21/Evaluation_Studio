/**
 * OAuth Routes
 *
 * REST API for end-user OAuth token management.
 * Authenticated routes use authMiddleware; the callback route uses unifiedAuth
 * (without requireAuth) because IdP redirects (e.g. Google, Slack) don't carry a JWT header.
 *
 * Handles: initiate flow, callback, list tokens, revoke.
 * OAuth tokens are encrypted at rest with tenant-scoped AES-256-GCM keys.
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware, unifiedAuth } from '../middleware/auth.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { isDatabaseAvailable } from '../db/index.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { DEFAULT_LOCAL_ORIGINS } from '@agent-platform/config';
import {
  listOAuthGrantTokensForUser,
  revokeOAuthGrantForUser,
} from '../services/oauth-grant-service.js';
import type { ToolOAuthService } from '../services/tool-oauth-service.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/oauth',
  tags: ['OAuth'],
});
const router: RouterType = openapi.router;
const log = createLogger('oauth-route');

/** Maximum allowed length for provider names */
const MAX_PROVIDER_LENGTH = 64;
/** Maximum allowed length for redirectUri */
const MAX_REDIRECT_URI_LENGTH = 2048;

/** Allowed redirect URI patterns (exact origins). Configured via security.oauthAllowedRedirectOrigins. */
function getAllowedRedirectOrigins(): string[] {
  const configured = getConfig().security.oauthAllowedRedirectOrigins;
  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === 'production') {
    log.warn('oauthAllowedRedirectOrigins not configured in production — no origins allowed');
    return [];
  }
  return DEFAULT_LOCAL_ORIGINS;
}

/** Validate provider name — alphanumeric, dash, underscore only */
function isValidProvider(provider: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(provider) && provider.length <= MAX_PROVIDER_LENGTH;
}

/** Validate redirectUri against allowlist */
function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  try {
    const parsed = new URL(uri);
    const origin = parsed.origin;
    return getAllowedRedirectOrigins().includes(origin);
  } catch {
    return false;
  }
}

/** Get ToolOAuthService from app.locals */
function getOAuthService(req: any): ToolOAuthService | null {
  return (req.app.locals as any).toolOAuthService ?? null;
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

/** POST /api/oauth/authorize/:provider request body */
const authorizeRequestSchema = z.object({
  redirectUri: z.string().url().max(MAX_REDIRECT_URI_LENGTH),
  scopes: z.array(z.string()).optional(),
});

/** GET /api/v1/oauth/callback/:provider query parameters */
const callbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
});

/** GET /api/oauth/tokens query parameters */
const listTokensQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

/** OAuth token response */
const oauthTokenSchema = z.object({
  provider: z.string(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Response for POST /api/v1/oauth/authorize/:provider and GET /api/v1/oauth/callback/:provider */
const successMessageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});

/** Response for GET /api/oauth/tokens */
const listTokensResponseSchema = z.object({
  success: z.literal(true),
  tokens: z.array(oauthTokenSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

/** Generic error response */
const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function isBrowserCallbackRequest(req: any): boolean {
  const fetchDest = typeof req.get === 'function' ? req.get('sec-fetch-dest') : undefined;
  if (fetchDest === 'document') {
    return true;
  }

  return typeof req.accepts === 'function' && req.accepts(['html', 'json']) === 'html';
}

function sendOAuthPopupResultPage(
  res: any,
  params: { success: boolean; message: string; error?: string },
): void {
  const payload = serializeForInlineScript({
    type: 'oauth_complete',
    success: params.success,
    ...(params.error ? { error: params.error } : {}),
  });
  const bodyText = params.success
    ? 'Authorization complete. You can close this window.'
    : params.message;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${params.success ? 'Authorization complete' : 'Authorization failed'}</title>
  </head>
  <body>
    <p>${bodyText}</p>
    <script>
      (function () {
        var payload = ${payload};
        try {
          if (window.opener && typeof window.opener.postMessage === 'function') {
            window.opener.postMessage(payload, '*');
          }
        } catch {}
        ${params.success ? 'setTimeout(function () { window.close(); }, 1200);' : ''}
      })();
    </script>
  </body>
</html>`;

  res.status(params.success ? 200 : 400);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

/** Log an audit event for credential CRUD operations (CL1/E3) */
function logAuditEvent(
  action: string,
  tenantId: string,
  userId: string,
  metadata: Record<string, unknown>,
  requestId?: string,
): void {
  writeAuditLog({
    action,
    tenantId,
    userId,
    metadata: { ...metadata, requestId },
  });
}

// =============================================================================
// AUTHENTICATED ROUTES (require JWT/API key)
// =============================================================================

/**
 * POST /api/oauth/authorize/:provider — Initiate OAuth flow
 *
 * Body: { scopes?, redirectUri }
 * tenantId + userId extracted from auth context.
 * Requires 'credential:write' permission (E1).
 */
openapi.route(
  'post',
  '/authorize/:provider',
  {
    summary: 'Initiate OAuth flow',
    description:
      'Start an OAuth authorization flow for a given provider. Returns authUrl and state for client-side redirect.',
    body: authorizeRequestSchema,
    response: z.object({
      success: z.literal(true),
      authUrl: z.string(),
      state: z.string(),
    }),
  },
  authMiddleware,
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { provider } = req.params;
      // S4: Validate/sanitize provider param
      if (!isValidProvider(provider)) {
        res.status(400).json({ success: false, error: 'Invalid provider name' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      // Validate request body
      const result = authorizeRequestSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Invalid request body' });
        return;
      }

      const { scopes, redirectUri } = result.data;

      // S2: Validate redirectUri against allowlist
      if (!isAllowedRedirectUri(redirectUri)) {
        res.status(400).json({ success: false, error: 'Redirect URI not in allowed origins' });
        return;
      }

      const oauthService = getOAuthService(req);
      if (!oauthService) {
        res.status(503).json({ success: false, error: 'OAuth service not configured' });
        return;
      }

      const { authUrl, state } = await oauthService.initiateOAuthFlow(
        provider,
        tenantId,
        userId,
        scopes ?? [],
        redirectUri,
      );

      // CL5: success logging + CL2: requestId
      log.info('OAuth flow initiated', { provider, tenantId, requestId });
      // E3/CL1: audit log
      logAuditEvent('oauth:authorize', tenantId, userId, { provider }, requestId);

      res.json({ success: true, authUrl, state });
    } catch (error: any) {
      log.error('Failed to initiate OAuth flow', { error: error?.message, requestId });
      // U5: Sanitize error messages
      res.status(500).json({ success: false, error: 'Failed to initiate OAuth flow' });
    }
  },
);

/**
 * GET /api/v1/oauth/callback/:provider — Handle OAuth callback
 *
 * Query: { code, state }
 * Uses unifiedAuth (without requireAuth) because IdP redirects don't carry JWT headers (S1 fix).
 * The tenantId/userId are embedded in the CSRF state from initiation.
 */
openapi.route(
  'get',
  '/callback/:provider',
  {
    summary: 'Handle OAuth callback',
    description:
      'Callback endpoint for OAuth providers to return authorization code and state. Stores encrypted tokens.',
    query: callbackQuerySchema,
    response: z.object({
      success: z.literal(true),
      message: z.string(),
    }),
  },
  unifiedAuth,
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { provider } = req.params;
      // S4: Validate provider
      if (!isValidProvider(provider)) {
        res.status(400).json({ success: false, error: 'Invalid provider name' });
        return;
      }

      // Validate query parameters
      const result = callbackQuerySchema.safeParse(req.query);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Missing code or state parameter' });
        return;
      }

      const { code, state } = result.data;

      const oauthService = getOAuthService(req);
      if (!oauthService) {
        res.status(503).json({ success: false, error: 'OAuth service not configured' });
        return;
      }

      const callbackResult = await oauthService.handleOAuthCallback(provider, code, state);

      log.info('OAuth callback completed', { provider, requestId });

      if (callbackResult.jitMetadata) {
        sendOAuthPopupResultPage(res, {
          success: true,
          message: 'Authorization complete. You can close this window.',
        });
        return;
      }

      res.json({ success: true, message: 'OAuth tokens stored successfully' });
    } catch (error: any) {
      log.error('OAuth callback failed', { error: error?.message, requestId });
      // U5: Sanitize error messages
      if (isBrowserCallbackRequest(req)) {
        sendOAuthPopupResultPage(res, {
          success: false,
          message: 'OAuth callback failed',
          error: 'OAuth callback failed',
        });
        return;
      }
      res.status(400).json({ success: false, error: 'OAuth callback failed' });
    }
  },
);

/**
 * GET /api/oauth/tokens — List authorized OAuth providers (U1)
 *
 * Returns provider names and metadata (no tokens) for the current user.
 */
openapi.route(
  'get',
  '/tokens',
  {
    summary: 'List authorized OAuth providers',
    description:
      'Get list of OAuth providers authorized by the current user. Returns metadata without sensitive tokens.',
    query: listTokensQuerySchema,
    response: listTokensResponseSchema,
  },
  authMiddleware,
  requirePermission('credential:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!isDatabaseAvailable()) {
        res.status(503).json({ success: false, error: 'Database not available' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      // Validate and parse query parameters with defaults
      const result = listTokensQuerySchema.safeParse(req.query);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Invalid query parameters' });
        return;
      }

      const { page, limit } = result.data;
      const { tokens, total } = await listOAuthGrantTokensForUser({
        tenantId,
        userId,
        page,
        limit,
      });

      log.info('Listed OAuth tokens', { tenantId, count: tokens.length, requestId });

      res.json({
        success: true,
        tokens,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      log.error('Failed to list OAuth tokens', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to list OAuth tokens' });
    }
  },
);

/**
 * DELETE /api/oauth/tokens/:provider — Revoke OAuth token
 *
 * tenantId + userId extracted from auth context.
 * Requires 'credential:delete' permission (E1).
 */
openapi.route(
  'delete',
  '/tokens/:provider',
  {
    summary: 'Revoke OAuth token',
    description: 'Revoke and delete the OAuth token for a specific provider.',
    response: z.object({
      success: z.literal(true),
      message: z.string(),
    }),
  },
  authMiddleware,
  requirePermission('credential:delete'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { provider } = req.params;
      // S4: Validate provider
      if (!isValidProvider(provider)) {
        res.status(400).json({ success: false, error: 'Invalid provider name' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      if (!isDatabaseAvailable()) {
        res.status(503).json({ success: false, error: 'Database not available' });
        return;
      }

      await revokeOAuthGrantForUser({ tenantId, userId, provider });

      log.info('OAuth token revoked', { provider, tenantId, requestId });
      logAuditEvent('oauth:revoke', tenantId, userId, { provider }, requestId);

      res.json({ success: true, message: `Token for provider revoked` });
    } catch (error: any) {
      log.error('Failed to revoke OAuth token', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to revoke OAuth token' });
    }
  },
);

export default openapi.router;
