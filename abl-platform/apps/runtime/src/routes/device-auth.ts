/**
 * Device Authorization Routes (RFC 8628)
 *
 * Provides device authorization flow endpoints for CLI/MCP tool authentication.
 * Mounted at /api/auth/device in the runtime Express app.
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import {
  createDeviceAuthRequest,
  getDeviceAuthByUserCode,
  authorizeDeviceRequest,
  pollDeviceToken,
  createDeviceTokenPair,
} from '../services/device-auth-service.js';
import { getConfig } from '../config/index.js';
import { authMiddleware } from '../middleware/auth.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/auth/device',
  tags: ['Device Auth'],
});
const router: RouterType = openapi.router;

// =============================================================================
// Rate limiting for token endpoint (per-IP)
// =============================================================================

const tokenPollLimiter = new Map<string, { count: number; resetAt: number }>();

function checkTokenRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = tokenPollLimiter.get(ip);

  if (!entry || entry.resetAt < now) {
    tokenPollLimiter.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= 12) {
    return false; // 12 req/min per IP
  }

  entry.count++;
  return true;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of tokenPollLimiter) {
    if (entry.resetAt < now) {
      tokenPollLimiter.delete(ip);
    }
  }
}, 5 * 60_000).unref();

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * POST /api/auth/device — Initiate device authorization flow
 * Body: { scopes?: string[] }
 * Returns: RFC 8628 device authorization response
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Initiate device authorization flow',
    description: 'Create a new device authorization request (RFC 8628)',
    body: z.object({
      scopes: z.array(z.string()).optional().describe('OAuth scopes for this device'),
    }),
    response: z.object({
      device_code: z.string(),
      user_code: z.string(),
      verification_uri: z.string(),
      verification_uri_complete: z.string(),
      expires_in: z.number().describe('Expiration time in seconds'),
      interval: z.number().describe('Recommended polling interval in seconds'),
    }),
    successStatus: 200,
  },
  async (req, res) => {
    try {
      const { scopes = ['read_traces', 'read_state', 'subscribe'] } = req.body;

      const { deviceCode, userCode, expiresAt } = await createDeviceAuthRequest(scopes);

      const config = getConfig();
      // Priority: explicit env var → config → request origin (co-hosted) → error
      let studioUrl = process.env['STUDIO_URL'] || config.server.frontendUrl;
      if (!studioUrl) {
        // In deployed environments, Studio and Runtime share the same origin
        const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
        const host = req.get('x-forwarded-host') || req.get('host');
        if (host) {
          studioUrl = `${proto}://${host}`;
        } else {
          // Last resort — should never happen in production
          studioUrl = 'https://agents.kore.ai';
        }
      }
      const verificationUri = `${studioUrl}/auth/device`;

      res.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${userCode}`,
        expires_in: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
        interval: 5,
      });
    } catch (error) {
      console.error('[Device Auth] Error creating request:', error);
      res.status(500).json({ error: 'Failed to create device authorization request' });
    }
  },
);

/**
 * GET /api/auth/device/lookup — Look up device auth request by user code
 * Query: ?code=XXXX-XXXX
 */
openapi.route(
  'get',
  '/lookup',
  {
    summary: 'Look up device auth request by user code',
    description: 'Retrieve device authorization request details for display on the browser',
    query: z.object({
      code: z.string().describe('Device user code from device'),
    }),
    response: z.object({
      userCode: z.string(),
      scopes: z.array(z.string()),
      expiresAt: z.string().describe('ISO 8601 expiration timestamp'),
    }),
  },
  async (req, res) => {
    try {
      const code = req.query['code'] as string;
      if (!code) {
        res.status(400).json({ error: 'Missing code parameter' });
        return;
      }

      const request = await getDeviceAuthByUserCode(code);
      if (!request) {
        res.status(404).json({ error: 'Invalid or expired code' });
        return;
      }

      if (request.expiresAt < new Date()) {
        res.status(410).json({ error: 'Code expired' });
        return;
      }

      if (request.authorizedAt) {
        res.status(409).json({ error: 'Code already authorized' });
        return;
      }

      res.json({
        userCode: request.userCode,
        scopes: request.scopes as string[],
        expiresAt: request.expiresAt.toISOString(),
      });
    } catch (error) {
      console.error('[Device Auth] Lookup error:', error);
      res.status(500).json({ error: 'Lookup failed' });
    }
  },
);

/**
 * POST /api/auth/device/authorize — User approves/denies from browser
 * Body: { user_code: string, allow: boolean }
 * Requires JWT authentication
 */
openapi.route(
  'post',
  '/authorize',
  {
    summary: 'Authorize or deny device request',
    description: 'User approves or denies device authorization from browser (requires JWT)',
    body: z.object({
      user_code: z.string().describe('Device user code from device'),
      allow: z.boolean().describe('Whether to allow (true) or deny (false) the device'),
    }),
    response: z.object({
      success: z.boolean(),
      message: z.string().optional(),
    }),
  },
  authMiddleware,
  async (req, res) => {
    try {
      const { user_code, allow } = req.body;

      if (!user_code) {
        res.status(400).json({ error: 'Missing user_code' });
        return;
      }

      if (!allow) {
        res.json({ success: false, message: 'Access denied by user' });
        return;
      }

      // req.user is set by authMiddleware (AuthUser shape: { id, email, name })
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User identity not resolved' });
        return;
      }
      const success = await authorizeDeviceRequest(user_code, userId);

      if (!success) {
        res.status(404).json({ error: 'Invalid, expired, or already authorized code' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[Device Auth] Authorize error:', error);
      res.status(500).json({ error: 'Authorization failed' });
    }
  },
);

/**
 * POST /api/auth/device/token — CLI/MCP polls until authorized
 * Body: { device_code: string, grant_type?: 'urn:ietf:params:oauth:grant-type:device_code' }
 * Rate limited: 12 req/min per IP
 */
openapi.route(
  'post',
  '/token',
  {
    summary: 'Poll for token after user authorizes device',
    description:
      'RFC 8628 token endpoint. Device polls until authorized (rate limited: 12 req/min per IP)',
    body: z.object({
      device_code: z.string().describe('Device code from initial device request'),
      grant_type: z
        .string()
        .optional()
        .describe('OAuth grant type (optional, for RFC 8628 compliance)'),
    }),
    response: z.object({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      token_type: z.string().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
  },
  async (req, res) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

      if (!checkTokenRateLimit(clientIp)) {
        res.status(429).json({
          error: 'slow_down',
          error_description: 'Too many requests. Wait before polling again.',
        });
        return;
      }

      const { device_code } = req.body;
      if (!device_code) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'Missing device_code' });
        return;
      }

      const result = await pollDeviceToken(device_code);

      switch (result.status) {
        case 'pending':
          res.status(428).json({
            error: 'authorization_pending',
            error_description: 'User has not yet authorized this device.',
          });
          return;

        case 'expired':
          res.status(410).json({
            error: 'expired_token',
            error_description: 'Device code has expired. Start a new authorization flow.',
          });
          return;

        case 'consumed':
          res.status(409).json({
            error: 'token_already_used',
            error_description: 'This device code has already been used.',
          });
          return;

        case 'authorized': {
          if (!result.userId) {
            res
              .status(500)
              .json({ error: 'server_error', error_description: 'Missing user context' });
            return;
          }

          const { accessToken, refreshToken, expiresIn } = await createDeviceTokenPair(
            result.userId,
          );

          res.json({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
            scope: result.scopes?.join(' ') || '',
          });
          return;
        }
      }
    } catch (error) {
      console.error('[Device Auth] Token error:', error);
      res.status(500).json({ error: 'server_error', error_description: 'Token exchange failed' });
    }
  },
);

export default openapi.router;
