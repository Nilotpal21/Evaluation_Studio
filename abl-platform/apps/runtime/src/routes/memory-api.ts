/**
 * Memory API Route
 *
 * POST /api/v1/memory — HTTP bridge for sandbox pod memory callbacks.
 *
 * Sandbox code (Python/JS) running inside gVisor calls back to this endpoint
 * to read/write agent memory stores. The request carries a sandbox JWT
 * (signed with sandbox.jwtSecret) that identifies the session.
 *
 * Flow:
 *   Sandbox pod → POST /api/v1/memory { action, memoryStoreName, payload? }
 *     → JWT verify (sandbox secret) → extract sessionId
 *     → MemoryBridgeRegistry.get(sessionId) → ToolMemoryBridge
 *     → bridge.get_content / set_content / delete_content
 *   ← { success, data?, error? }
 */

import { type Router as RouterType } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { createLogger } from '@abl/compiler/platform';
import { getConfig, isConfigLoaded } from '../config/index.js';
import { getMemoryBridgeRegistry } from '../services/execution/memory-bridge-registry.js';
import { runtimeRegistry } from '../openapi/registry.js';

const log = createLogger('memory-api');
const openapi = createOpenAPIRouter(runtimeRegistry, {
  tags: ['Memory API'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (_error, _req, res) => {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Missing action or memoryStoreName' },
    });
  },
});
const router: RouterType = openapi.router;

const memoryApiBodySchema = z.object({
  action: z.string().min(1).optional(),
  memoryStoreName: z.string().min(1).optional(),
  payload: z.unknown().optional(),
});

type MemoryApiBody = z.infer<typeof memoryApiBodySchema>;

const memoryApiResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    success: z.literal(true),
  }),
]);

interface SandboxJwtPayload {
  sessionId?: string;
  accountId?: string;
  userId?: string;
  appvId?: string;
  projectId?: string;
  envId?: string;
}

/**
 * Extract and verify the sandbox JWT from the Authorization header.
 * Supports both bare tokens and "Bearer <token>" format.
 */
function extractAndVerifyToken(authHeader: string | undefined, secret: string): SandboxJwtPayload {
  if (!authHeader) {
    throw new Error('Missing Authorization header');
  }

  // Support both "Bearer <token>" and bare token (agenticai convention)
  const token = authHeader.replace(/^bearer\s+/i, '');
  if (!token) {
    throw new Error('Empty Authorization token');
  }

  return jwt.verify(token, secret) as SandboxJwtPayload;
}

openapi.route(
  'post',
  '/api/v1/memory',
  {
    summary: 'Handle sandbox memory callbacks',
    description:
      'HTTP bridge for sandbox pods to read and write per-session memory using a sandbox-signed Authorization token.',
    body: memoryApiBodySchema,
    response: memoryApiResponseSchema,
    auth: false,
  },
  async (req, res) => {
    try {
      // Verify sandbox JWT secret is configured
      if (!isConfigLoaded()) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Config not loaded' },
        });
        return;
      }
      const sandboxSecret = getConfig().sandbox.jwtSecret;
      if (!sandboxSecret) {
        log.error('Memory API called but sandbox.jwtSecret is not configured');
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Sandbox auth not configured' },
        });
        return;
      }

      // Verify JWT
      let claims: SandboxJwtPayload;
      try {
        claims = extractAndVerifyToken(req.headers.authorization, sandboxSecret);
      } catch (err) {
        log.debug('Memory API JWT verification failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
        });
        return;
      }

      const { sessionId, accountId } = claims;
      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Token missing sessionId' },
        });
        return;
      }

      // Look up the memory bridge for this session
      const registry = getMemoryBridgeRegistry();
      const entry = registry.get(sessionId);
      if (!entry) {
        // Return 404 per CLAUDE.md: cross-scope access returns 404
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
        return;
      }

      // Tenant isolation: verify accountId matches (return 404 on mismatch to avoid leaking existence)
      if (accountId && entry.accountId && accountId !== entry.accountId) {
        log.warn('Memory API tenant mismatch', { sessionId, claimAccountId: accountId });
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
        return;
      }

      const validatedBody = getValidatedRequestData(res)?.body as MemoryApiBody | undefined;
      const body = validatedBody ?? (req.body as MemoryApiBody);
      const { action, memoryStoreName, payload } = body;

      if (!action || !memoryStoreName) {
        res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Missing action or memoryStoreName' },
        });
        return;
      }

      const bridge = entry.bridge;

      // Route by action
      switch (action) {
        case 'get': {
          const data = await bridge.get_content(memoryStoreName);
          res.json({ success: true, data });
          return;
        }
        case 'set': {
          const value =
            payload != null && typeof payload === 'object' && 'content' in payload
              ? (payload as { content: unknown }).content
              : payload;
          await bridge.set_content(memoryStoreName, value);
          res.json({ success: true });
          return;
        }
        case 'delete': {
          const deleted = await bridge.delete_content(memoryStoreName);
          res.json({ success: true, data: { deleted } });
          return;
        }
        default:
          res.status(400).json({
            success: false,
            error: { code: 'BAD_REQUEST', message: `Unknown action: ${String(action)}` },
          });
          return;
      }
    } catch (err) {
      log.error('Memory API unexpected error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    }
  },
);

export default router;
