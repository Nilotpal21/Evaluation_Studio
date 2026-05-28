/**
 * SDK WebSocket Ticket Route
 *
 * POST /api/v1/sdk/ws-ticket — Exchange an SDK session token for a short-lived,
 * one-time WebSocket credential.
 */

import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { createLogger } from '@abl/compiler/platform';
import { z } from 'zod';
import { runtimeRegistry } from '../openapi/registry.js';
import {
  applyRateLimitHeaders,
  checkTenantOperationRateLimit,
} from '../middleware/rate-limiter.js';
import { verifyRuntimeSdkSessionForAuth } from '../services/identity/sdk-session-token-auth.js';
import { issueSdkWsTicket } from '../services/identity/sdk-ws-ticket-store.js';

const log = createLogger('sdk-ws-ticket-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/v1/sdk',
  tags: ['SDK'],
});
const router = openapi.router;

const SDKWsTicketRequestSchema = z.object({}).strict();

const SDKWsTicketResponseSchema = z.object({
  ticket: z.string().describe('Short-lived one-time WebSocket credential'),
  expiresIn: z.number().describe('Ticket TTL in seconds'),
});

openapi.route(
  'post',
  '/ws-ticket',
  {
    summary: 'Mint an SDK WebSocket ticket',
    description:
      'Exchanges the current SDK session token for a short-lived one-time credential used with the sdk-ticket WebSocket subprotocol.',
    body: SDKWsTicketRequestSchema,
    response: SDKWsTicketResponseSchema,
    successStatus: 200,
    auth: false,
  },
  async (req, res) => {
    const tokenHeader = req.headers['x-sdk-token'];
    const token = typeof tokenHeader === 'string' ? tokenHeader.trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Missing X-SDK-Token header' });
      return;
    }

    const verified = await verifyRuntimeSdkSessionForAuth(token);
    if (!verified.success) {
      res.status(verified.status).json({
        error: verified.code,
        message: verified.error,
      });
      return;
    }

    const rateLimit = await checkTenantOperationRateLimit({
      tenantId: verified.payload.tenantId,
      projectId: verified.payload.projectId,
      operation: 'request',
      overrideLimits: { requestsPerMinute: 20 },
    });
    applyRateLimitHeaders(res, rateLimit);
    if (!rateLimit.allowed) {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
        operation: 'request',
        limit: rateLimit.limit,
        retryAfterMs: rateLimit.resetMs,
      });
      return;
    }

    const issued = await issueSdkWsTicket(verified.payload, verified.envelope);
    if (!issued.success) {
      log.warn('SDK WebSocket ticket issuance unavailable', {
        tenantId: verified.payload.tenantId,
        projectId: verified.payload.projectId,
        channelId: verified.payload.channelId,
      });
      res.status(503).json({
        error: 'SDK_WS_TICKET_UNAVAILABLE',
        message: 'SDK WebSocket ticket issuance is unavailable',
      });
      return;
    }

    res.json({
      ticket: issued.ticket,
      expiresIn: issued.expiresIn,
    });
  },
);

export default router;
