/**
 * Channel OAuth Routes
 *
 * Generic OAuth endpoints for channel connections.
 * POST /api/v1/channel-oauth/:channelType/authorize — initiate OAuth flow
 * GET  /api/v1/channel-oauth/:channelType/callback  — handle provider callback
 *
 * Authenticated routes use authMiddleware; the callback route uses unifiedAuth
 * (without requireAuth) because IdP redirects (e.g. Slack) don't carry a JWT header.
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware, unifiedAuth } from '../middleware/auth.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { writeAuditLog } from '../repos/auth-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { DEFAULT_LOCAL_ORIGINS } from '@agent-platform/config';
import type { ChannelOAuthService } from '../services/channel-oauth/channel-oauth-service.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/channel-oauth',
  tags: ['Channel OAuth'],
});
const log = createLogger('channel-oauth-route');

/** Maximum allowed length for channel type names */
const MAX_CHANNEL_TYPE_LENGTH = 32;
/** Maximum allowed length for redirectUri */
const MAX_REDIRECT_URI_LENGTH = 2048;

/** Allowed redirect URI patterns (exact origins).
 *  Falls back to CORS origins since the redirect always comes from Studio. */
function getAllowedRedirectOrigins(): string[] {
  const configured = getConfig().security.oauthAllowedRedirectOrigins;
  if (configured.length > 0) return configured;
  // Fall back to CORS origins — the OAuth redirect always comes from Studio,
  // which is always in the CORS allowlist.
  const corsOrigins = getConfig().cors.origins;
  if (Array.isArray(corsOrigins) && corsOrigins.length > 0) return corsOrigins;
  if (process.env.NODE_ENV === 'production') {
    log.warn('oauthAllowedRedirectOrigins not configured in production — no origins allowed');
    return [];
  }
  return DEFAULT_LOCAL_ORIGINS;
}

/** Validate channel type — lowercase alphanumeric, dash, underscore only */
function isValidChannelType(channelType: string): boolean {
  return /^[a-z0-9_-]+$/.test(channelType) && channelType.length <= MAX_CHANNEL_TYPE_LENGTH;
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

/** Get ChannelOAuthService from app.locals */
function getChannelOAuthService(req: any): ChannelOAuthService | null {
  return (req.app.locals as any).channelOAuthService ?? null;
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

/** POST /api/v1/channel-oauth/:channelType/authorize request body */
const authorizeBodySchema = z.object({
  redirectUri: z.string().url().max(MAX_REDIRECT_URI_LENGTH),
  projectId: z.string().min(1),
});

/** GET /api/v1/channel-oauth/:channelType/callback query parameters */
const callbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
});

/** Log an audit event for channel OAuth operations */
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
 * POST /api/v1/channel-oauth/:channelType/authorize — Initiate channel OAuth flow
 *
 * Body: { redirectUri, projectId }
 * tenantId + userId extracted from auth context.
 * Requires 'credential:write' permission.
 */
openapi.route(
  'post',
  '/:channelType/authorize',
  {
    summary: 'Initiate channel OAuth flow',
    description:
      'Start an OAuth authorization flow for a channel type. Returns authUrl and state for client-side redirect.',
    body: authorizeBodySchema,
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

      const { channelType } = req.params;
      // Validate/sanitize channelType param
      if (!isValidChannelType(channelType)) {
        res.status(400).json({ success: false, error: 'Invalid channel type' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      // Validate request body
      const result = authorizeBodySchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Invalid request body' });
        return;
      }

      const { redirectUri, projectId } = result.data;

      // Validate redirectUri against allowlist
      if (!isAllowedRedirectUri(redirectUri)) {
        res.status(400).json({ success: false, error: 'Redirect URI not in allowed origins' });
        return;
      }

      const service = getChannelOAuthService(req);
      if (!service) {
        res.status(503).json({ success: false, error: 'Channel OAuth service not configured' });
        return;
      }

      const { authUrl, state } = await service.initiateFlow(
        channelType,
        tenantId,
        userId,
        projectId,
        redirectUri,
      );

      log.info('Channel OAuth flow initiated', { channelType, tenantId, requestId });
      logAuditEvent(
        'channel-oauth:authorize',
        tenantId,
        userId,
        { channelType, projectId },
        requestId,
      );

      res.json({ success: true, authUrl, state });
    } catch (error: any) {
      log.error('Failed to initiate channel OAuth flow', { error: error?.message, requestId });
      // Sanitize error messages
      res.status(500).json({ success: false, error: 'Failed to initiate OAuth flow' });
    }
  },
);

// =============================================================================
// CALLBACK ROUTE (uses unifiedAuth — no JWT required)
// =============================================================================

/**
 * GET /api/v1/channel-oauth/:channelType/callback — Handle channel OAuth callback
 *
 * Query: { code, state }
 * Uses unifiedAuth (without requireAuth) because IdP redirects don't carry JWT headers.
 * The tenantId/userId/projectId are embedded in the CSRF state from initiation.
 * Returns JSON with credentials + metadata (Studio callback page handles postMessage to parent).
 */
openapi.route(
  'get',
  '/:channelType/callback',
  {
    summary: 'Handle channel OAuth callback',
    description:
      'Callback endpoint for OAuth providers. Exchanges code for credentials and returns result with metadata.',
    query: callbackQuerySchema,
    response: z.object({ success: z.literal(true) }),
  },
  unifiedAuth,
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { channelType } = req.params;
      // Validate channelType
      if (!isValidChannelType(channelType)) {
        res.status(400).json({ success: false, error: 'Invalid channel type' });
        return;
      }

      // Validate query parameters
      const result = callbackQuerySchema.safeParse(req.query);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Missing code or state parameter' });
        return;
      }

      const { code, state } = result.data;

      const service = getChannelOAuthService(req);
      if (!service) {
        res.status(503).json({ success: false, error: 'Channel OAuth service not configured' });
        return;
      }

      const oauthResult = await service.handleCallback(channelType, code, state);

      log.info('Channel OAuth callback completed', { channelType, requestId });

      res.json({
        success: true,
        channelType,
        credentials: oauthResult.credentials,
        externalIdentifier: oauthResult.externalIdentifier,
        displayName: oauthResult.displayName,
        metadata: oauthResult.metadata,
        projectId: oauthResult.projectId,
      });
    } catch (error: any) {
      log.error('Channel OAuth callback failed', { error: error?.message, requestId });
      // Sanitize error messages
      res.status(400).json({ success: false, error: error?.message ?? 'OAuth callback failed' });
    }
  },
);

export default openapi.router;
