/**
 * Channel OAuth Routes Integration Tests
 *
 * Verifies the channel OAuth endpoints:
 *   POST /api/v1/channel-oauth/:channelType/authorize — initiate OAuth flow
 *   GET  /api/v1/channel-oauth/:channelType/callback  — handle provider callback
 *
 * Tests cover:
 *   - Successful authorize flow (valid body -> authUrl + state)
 *   - Invalid redirectUri (not in allowlist) -> 400
 *   - Invalid channelType -> 400
 *   - Unauthenticated requests -> 401
 *   - Successful callback (valid code + state -> credentials)
 *   - Missing code/state on callback -> 400
 *   - Service error on callback (invalid state) -> 400
 *   - Service not configured (null) -> 503
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS -- must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  unifiedAuth: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    security: { oauthAllowedRedirectOrigins: ['http://localhost:3000'] },
  })),
}));

vi.mock('@agent-platform/config', () => ({
  DEFAULT_LOCAL_ORIGINS: ['http://localhost:3000'],
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const CHANNEL_OAUTH_BASE = '/api/v1/channel-oauth';

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/**
 * Creates a test Express app with the channel-oauth router mounted.
 * Optionally disables auth context or the channelOAuthService.
 */
async function createTestApp(opts?: { noService?: boolean; noAuth?: boolean }) {
  const app = express();
  app.use(express.json());

  if (!opts?.noAuth) {
    const ctx = makeTenantContext('tenant-1', 'user-1', 'ADMIN');
    app.use(injectTenantContext(ctx));
  }

  if (!opts?.noService) {
    app.locals.channelOAuthService = {
      initiateFlow: vi.fn().mockResolvedValue({
        authUrl: 'https://slack.com/oauth/v2/authorize?client_id=test&state=abc123',
        state: 'abc123',
      }),
      handleCallback: vi.fn().mockResolvedValue({
        credentials: { bot_token: 'xoxb-test', signing_secret: 'test-secret' },
        externalIdentifier: 'T123:A456',
        displayName: 'Slack - Test Workspace',
        metadata: { teamId: 'T123', botUserId: 'U789' },
        tenantId: 'tenant-1',
        userId: 'user-1',
        projectId: 'project-1',
      }),
    };
  }

  const channelOAuthRouter = (await import('../../routes/channel-oauth.js')).default;
  app.use('/api/v1/channel-oauth', channelOAuthRouter);

  return new Promise<{ baseUrl: string; server: http.Server; app: express.Express }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server, app });
    });
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Channel OAuth routes', () => {
  // ---------------------------------------------------------------------------
  // POST /api/v1/channel-oauth/:channelType/authorize — success
  // ---------------------------------------------------------------------------
  describe('POST /:channelType/authorize — valid request', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp());
    });

    afterAll(() => {
      server?.close();
    });

    test('returns success with authUrl and state', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${CHANNEL_OAUTH_BASE}/slack/authorize`,
        {
          body: { redirectUri: 'http://localhost:3000/callback', projectId: 'project-1' },
        },
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.authUrl).toBe('https://slack.com/oauth/v2/authorize?client_id=test&state=abc123');
      expect(body.state).toBe('abc123');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/channel-oauth/:channelType/authorize — invalid redirectUri
  // ---------------------------------------------------------------------------
  describe('POST /:channelType/authorize — invalid redirectUri', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp());
    });

    afterAll(() => {
      server?.close();
    });

    test('returns 400 when redirectUri is not in allowed origins', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${CHANNEL_OAUTH_BASE}/slack/authorize`,
        {
          body: { redirectUri: 'https://evil.com/callback', projectId: 'project-1' },
        },
      );
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Redirect URI not in allowed origins');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/channel-oauth/:channelType/authorize — invalid channelType
  // ---------------------------------------------------------------------------
  describe('POST /:channelType/authorize — invalid channelType', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp());
    });

    afterAll(() => {
      server?.close();
    });

    test('returns 400 when channelType contains invalid characters', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${CHANNEL_OAUTH_BASE}/INVALID%21TYPE/authorize`,
        {
          body: { redirectUri: 'http://localhost:3000/callback', projectId: 'project-1' },
        },
      );
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid channel type');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/channel-oauth/:channelType/authorize — unauthenticated (no tenantContext)
  // ---------------------------------------------------------------------------
  describe('POST /:channelType/authorize — unauthenticated', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp({ noAuth: true }));
    });

    afterAll(() => {
      server?.close();
    });

    test('returns 401 without tenantContext', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${CHANNEL_OAUTH_BASE}/slack/authorize`,
        {
          body: { redirectUri: 'http://localhost:3000/callback', projectId: 'project-1' },
        },
      );
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/channel-oauth/:channelType/callback — valid code + state
  // ---------------------------------------------------------------------------
  describe('GET /:channelType/callback — valid request', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp());
    });

    afterAll(() => {
      server?.close();
    });

    test('returns credentials and metadata', async () => {
      const { status, body } = await request(
        baseUrl,
        'GET',
        `${CHANNEL_OAUTH_BASE}/slack/callback?code=test-code&state=abc123`,
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.channelType).toBe('slack');
      expect(body.credentials).toEqual({
        bot_token: 'xoxb-test',
        signing_secret: 'test-secret',
      });
      expect(body.externalIdentifier).toBe('T123:A456');
      expect(body.displayName).toBe('Slack - Test Workspace');
      expect(body.metadata).toEqual({ teamId: 'T123', botUserId: 'U789' });
      expect(body.projectId).toBe('project-1');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/channel-oauth/:channelType/callback — missing code or state
  // ---------------------------------------------------------------------------
  describe('GET /:channelType/callback — missing parameters', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp());
    });

    afterAll(() => {
      server?.close();
    });

    test('returns 400 when code is missing', async () => {
      const { status, body } = await request(
        baseUrl,
        'GET',
        `${CHANNEL_OAUTH_BASE}/slack/callback?state=abc123`,
      );
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing code or state');
    });

    test('returns 400 when state is missing', async () => {
      const { status, body } = await request(
        baseUrl,
        'GET',
        `${CHANNEL_OAUTH_BASE}/slack/callback?code=test-code`,
      );
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing code or state');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/channel-oauth/:channelType/callback — service throws (invalid state)
  // ---------------------------------------------------------------------------
  describe('GET /:channelType/callback — service error (invalid state)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      const result = await createTestApp();
      baseUrl = result.baseUrl;
      server = result.server;

      // Override handleCallback to throw
      result.app.locals.channelOAuthService.handleCallback = vi
        .fn()
        .mockRejectedValue(new Error('Invalid or expired state parameter'));
    });

    afterAll(() => {
      server?.close();
    });

    test('returns 400 when service throws for invalid state', async () => {
      const { status, body } = await request(
        baseUrl,
        'GET',
        `${CHANNEL_OAUTH_BASE}/slack/callback?code=test-code&state=bad-state`,
      );
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid or expired state parameter');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/channel-oauth/:channelType/authorize — service not configured (null)
  // ---------------------------------------------------------------------------
  describe('POST /:channelType/authorize — service not configured', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createTestApp({ noService: true }));
    });

    afterAll(() => {
      server?.close();
    });

    test('returns 503 when channelOAuthService is not configured', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${CHANNEL_OAUTH_BASE}/slack/authorize`,
        {
          body: { redirectUri: 'http://localhost:3000/callback', projectId: 'project-1' },
        },
      );
      expect(status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Channel OAuth service not configured');
    });
  });
});
