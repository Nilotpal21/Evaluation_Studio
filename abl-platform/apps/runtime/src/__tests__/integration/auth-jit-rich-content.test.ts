/**
 * E2E: JIT Auth with Rich Templates (Suite 5)
 *
 * Tests tools that combine jit_auth with rich content responses.
 *
 * Real components:
 * - PausedExecutionStore
 * - createAuthProfileToolMiddleware
 * - resolveToolAuth -> resolveByName -> AuthProfile.findOne() (real MongoDB)
 * - RichContentIR type shapes
 * - Auth Profile REST API (POST /api/auth-profiles) for seeding
 *
 * Mock boundaries: Redis, Logger (infrastructure only)
 * DB: Real MongoDB via MongoMemoryServer
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'http';

// ── Mocks (must be before imports) ──────────────────────────────────
// Only mock TRUE external boundaries: logger and Redis

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => false,
  getRedisClient: () => null,
  getRedisHandle: () => null,
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import {
  getPausedExecutionStore,
  resetPausedExecutionStore,
} from '../../services/auth-profile/paused-execution-store.js';
import { createAuthProfileToolMiddleware } from '../../services/auth-profile/auth-profile-tool-middleware.js';
import { ServerMessages, serializeServerMessage } from '../../websocket/events.js';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';
import type { RichContentIR } from '@abl/compiler';
import { initDEKFacade } from '@agent-platform/database/kms';

// ── Real MongoDB + API setup ────────────────────────────────────────

import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';
import { setMasterKey } from '@agent-platform/database/models';
import {
  injectTenantContext,
  makeTenantContext,
  ROLE_PERMISSIONS,
} from '../helpers/auth-context.js';
import { authProfileRoutes } from '../../routes/auth-profiles.js';

const TEST_TENANT = 'tenant-rich-e2e';
const TEST_USER = 'user-rich-e2e';
const SUCCESS_PATH_JIT_AUTH_TIMEOUT_MS = '10000';

let app: express.Express;
let server: Server;

beforeAll(async () => {
  setMasterKey('ab'.repeat(32));
  await setupTestMongo();
  await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });

  // Create minimal Express app with auth-profile routes + test auth context
  app = express();
  app.use(express.json());
  app.use(
    injectTenantContext(
      makeTenantContext(TEST_TENANT, TEST_USER, 'ADMIN', {
        permissions: [
          ...ROLE_PERMISSIONS.ADMIN,
          'auth-profile:create',
          'auth-profile:read',
          'auth-profile:delete',
        ],
      }),
    ),
  );
  app.use('/api/auth-profiles', authProfileRoutes);
  server = app.listen(0);

  // Warm up MongoDB connection + dynamic imports (cold start can take 5+ seconds)
  const { AuthProfile } = await import('@agent-platform/database/models');
  await (AuthProfile as any).findOne({ tenantId: 'warmup' });
}, 60_000);

afterAll(async () => {
  server?.close();
  await teardownTestMongo();
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Seed an active bearer auth profile via the REST API */
async function seedBearerProfile(name: string, token: string) {
  const res = await request(server)
    .post('/api/auth-profiles')
    .send({
      name,
      authType: 'bearer',
      secrets: { token },
    })
    .expect(201);
  expect(res.body.success).toBe(true);
  return res.body.data;
}

function makeToolWithRichContent(
  richContentType: 'adaptive_card' | 'carousel',
): ToolCallContext['tool'] {
  return {
    name: 'rich_content_tool',
    description: 'Tool with rich content',
    parameters: [],
    returns: { type: 'string' },
    hints: {
      cacheable: false,
      latency: 'medium' as const,
      parallelizable: false,
      side_effects: false,
      requires_auth: false,
    },
    auth_profile_ref: 'google-creds',
    jit_auth: true,
    http_binding: {
      endpoint: 'https://api.example.com/data',
      method: 'GET' as const,
    },
  } as ToolCallContext['tool'];
}

function makeCtx(tool: ToolCallContext['tool']): ToolCallContext {
  return {
    toolName: tool!.name,
    params: {},
    timeoutMs: 30000,
    tool,
  };
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Suite 5: JIT Auth with Rich Templates', () => {
  let store: ReturnType<typeof getPausedExecutionStore>;

  beforeEach(async () => {
    await clearCollections();
    resetPausedExecutionStore();
    store = getPausedExecutionStore();
    vi.clearAllMocks();
    // The first auth-profile create/resume path can be cold in CI.
    process.env.JIT_AUTH_TIMEOUT_MS = SUCCESS_PATH_JIT_AUTH_TIMEOUT_MS;
  });

  afterEach(() => {
    store.destroy();
    delete process.env.JIT_AUTH_TIMEOUT_MS;
  });

  it('5.1: Tool with jit_auth + adaptive_card response -> auth_challenge sent, then rich content on resume', async () => {
    // No profile in DB -> JIT auth triggers
    const challengesSent: unknown[] = [];
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-rich-1',
      sendAuthChallenge: (params) => challengesSent.push(params),
      initiateJitOAuth: async () => 'https://auth.example.com/oauth?state=abc',
    });

    const tool = makeToolWithRichContent('adaptive_card');
    const ctx = makeCtx(tool);

    // After JIT auth, the tool returns rich content
    const richContentResult: ToolCallResult = {
      result: JSON.stringify({
        text: 'Here are your calendar events',
        rich_content: {
          adaptive_card: JSON.stringify({
            type: 'AdaptiveCard',
            body: [{ type: 'TextBlock', text: 'Calendar Events' }],
          }),
        },
      }),
    };
    const next = vi.fn().mockResolvedValue(richContentResult);

    const middlewarePromise = middleware(ctx, next);

    // Wait for the JIT auth pause (MongoDB cold-start can take >50ms)
    for (let i = 0; i < 80 && challengesSent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Auth challenge should be sent first
    expect(challengesSent).toHaveLength(1);

    // Verify auth_challenge does not interfere with rich content types
    const challenge = challengesSent[0] as Record<string, unknown>;
    expect(challenge.authType).toBe('oauth2');

    // Simulate: OAuth completed, profile now exists in DB via API
    await seedBearerProfile('google-creds', 'fresh-token');

    // Resolve auth
    const toolCallId = challenge.toolCallId as string;
    store.resolve(toolCallId);

    const result = await middlewarePromise;
    // After resume, the tool should return rich content
    expect(next).toHaveBeenCalled();
    const parsed = JSON.parse(result.result as string);
    expect(parsed.rich_content.adaptive_card).toBeDefined();
  });

  it('5.2: Tool with jit_auth + carousel response -> rich content preserved across pause/resume', async () => {
    // No profile in DB -> JIT auth triggers
    const challengesSent: unknown[] = [];
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-rich-2',
      sendAuthChallenge: (params) => challengesSent.push(params),
      initiateJitOAuth: async () => 'https://auth.example.com/oauth',
    });

    const tool = makeToolWithRichContent('carousel');
    const ctx = makeCtx(tool);

    const carouselResult: ToolCallResult = {
      result: JSON.stringify({
        text: 'Product recommendations',
        rich_content: {
          carousel: {
            cards: [
              { title: 'Product A', subtitle: '$29.99' },
              { title: 'Product B', subtitle: '$49.99' },
            ],
          },
        },
      }),
    };
    const next = vi.fn().mockResolvedValue(carouselResult);

    const middlewarePromise = middleware(ctx, next);

    // Wait for the JIT auth pause
    for (let i = 0; i < 80 && challengesSent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(challengesSent).toHaveLength(1);
    const toolCallId = (challengesSent[0] as Record<string, unknown>).toolCallId as string;

    // Simulate: OAuth completed, profile now exists in DB via API
    await seedBearerProfile('google-creds', 'token');

    // Resolve auth
    store.resolve(toolCallId);

    const result = await middlewarePromise;
    const parsed = JSON.parse(result.result as string);
    expect(parsed.rich_content.carousel.cards).toHaveLength(2);
    expect(parsed.rich_content.carousel.cards[0].title).toBe('Product A');
  });

  it('5.3: auth_challenge message does not corrupt rich content rendering context', () => {
    // Verify auth_challenge and response_end (with rich content) have distinct types
    // and can be serialized independently without field collision

    const authChallenge = ServerMessages.authChallenge('session-1', {
      toolCallId: 'tc-1',
      authType: 'oauth2',
      authUrl: 'https://auth.example.com',
      profileId: 'google-creds',
      profileName: 'Google',
      prompt: 'Authorize Google',
      timeoutMs: 600000,
    });

    const richContent: RichContentIR = {
      adaptive_card: '{"type":"AdaptiveCard","body":[]}',
      carousel: {
        cards: [{ title: 'Item 1' }],
      },
    };

    const responseEnd = ServerMessages.responseEnd(
      'session-1',
      'msg-1',
      'Here are results',
      undefined, // voiceConfig
      richContent,
    );

    // Both can be serialized
    const serializedChallenge = serializeServerMessage(authChallenge);
    const serializedResponse = serializeServerMessage(responseEnd);

    // Parsing back preserves types
    const parsedChallenge = JSON.parse(serializedChallenge);
    const parsedResponse = JSON.parse(serializedResponse);

    expect(parsedChallenge.type).toBe('auth_challenge');
    expect(parsedResponse.type).toBe('response_end');
    expect(parsedResponse.richContent.adaptive_card).toBeDefined();
    expect(parsedResponse.richContent.carousel.cards).toHaveLength(1);

    // No field collision between auth_challenge and rich content
    expect(parsedChallenge.richContent).toBeUndefined();
    expect(parsedResponse.toolCallId).toBeUndefined();
  });

  it('5.4: Timeout during JIT on rich-content tool -> error message, not broken rich content', async () => {
    process.env.JIT_AUTH_TIMEOUT_MS = '100'; // Very short
    store.destroy();
    resetPausedExecutionStore();
    store = getPausedExecutionStore();

    // No profile in DB -> JIT auth triggers, then times out
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-timeout-rich',
      sendAuthChallenge: vi.fn(),
      initiateJitOAuth: async () => 'https://auth.example.com/oauth',
    });

    const tool = makeToolWithRichContent('adaptive_card');
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue({
      result: JSON.stringify({ rich_content: { adaptive_card: '{}' } }),
    });

    const result = await middleware(ctx, next);

    // Should return a clean error, not broken rich content
    const parsed = JSON.parse(result.result as string);
    expect(parsed.code).toBe('AUTH_TIMEOUT');
    expect(parsed.error).toContain('timed out');
    // The result should NOT contain rich_content (it's an error response)
    expect(parsed.rich_content).toBeUndefined();
  });
});
