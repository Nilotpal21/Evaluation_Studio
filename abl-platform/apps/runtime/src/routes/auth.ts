/**
 * Dev Authentication Routes
 *
 * Provides dev-login endpoint for MCP debug tool and local development.
 * Only available when NODE_ENV !== 'production'.
 *
 * Mirrors the studio dev-login pattern:
 *   1. Find or create user in DB
 *   2. Resolve default tenant membership
 *   3. Include tenantId + role in JWT payload
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { findUserByEmail, createUser } from '../repos/auth-repo.js';
import {
  resolveFirstMembership,
  buildAccessTokenPayload,
  signAccessToken,
} from '../utils/jwt-utils.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/auth',
  tags: ['Auth'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (error, _req, res) => {
    res.status(400).json({ error: 'Invalid request', details: error.issues });
  },
});
const router: RouterType = openapi.router;

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const devLoginRequestSchema = z.object({
  email: z.string().email().optional().describe('User email (defaults to dev@kore.ai)'),
  name: z.string().optional().describe('User name (defaults to email prefix)'),
});

const devLoginResponseSchema = z.object({
  accessToken: z.string().describe('JWT access token'),
  user: z.object({
    id: z.string().describe('User ID'),
    email: z.string().describe('User email'),
    name: z.string().describe('User name'),
  }),
  tenantId: z.string().optional().describe('Default tenant ID'),
  role: z.string().optional().describe('User role in tenant'),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/auth/dev-login
 * Create a dev JWT token for local development and MCP debug tool
 */
openapi.route(
  'post',
  '/dev-login',
  {
    summary: 'Create dev JWT token',
    description:
      'Create a development JWT token for local development and MCP debug tool. Only available in non-production environments.',
    body: devLoginRequestSchema,
    response: devLoginResponseSchema,
  },
  async (req, res) => {
    const config = getConfig();

    if (config.env === 'production') {
      res.status(403).json({ error: 'Dev login not available in production' });
      return;
    }

    try {
      const validatedBody = getValidatedRequestData(res)?.body as
        | z.infer<typeof devLoginRequestSchema>
        | undefined;
      const { email, name } = validatedBody ?? {};
      const userEmail = email || 'dev@kore.ai';
      const userName = name || userEmail.split('@')[0];

      // Find or create user in DB (matches seed user email)
      let user = await findUserByEmail(userEmail);
      if (!user) {
        user = await createUser({
          email: userEmail,
          name: userName,
          googleId: `dev-${userEmail}`,
        });
      }

      // Resolve default tenant membership
      const membership = await resolveFirstMembership(user.id);
      const payload = buildAccessTokenPayload(user, membership);
      const token = signAccessToken(payload, config.jwt.secret);

      res.json({
        accessToken: token,
        user: { id: user.id, email: user.email, name: user.name },
        ...(membership ? { tenantId: membership.tenantId, role: membership.role } : {}),
      });
    } catch (error) {
      console.error('[Auth] Dev login error:', error);
      res.status(500).json({ error: 'Dev login failed' });
    }
  },
);

export default openapi.router;
