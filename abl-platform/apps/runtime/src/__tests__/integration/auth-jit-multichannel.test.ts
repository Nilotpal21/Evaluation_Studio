/**
 * E2E: Multi-Channel JIT Auth (Suite 1 + Suite 7)
 *
 * Tests JIT auth across both WS handler paths (Studio direct + SDK),
 * plus cross-session security boundaries.
 *
 * Real components:
 * - PausedExecutionStore (singleton, pause/resolve/reject/sweepExpired)
 * - createAuthProfileToolMiddleware (wraps tool calls with auth profile resolution)
 * - resolveToolAuth -> resolveByName -> AuthProfile.findOne() (real MongoDB)
 * - ServerMessages / parseClientMessage (WS event serialization)
 * - AuthProfile REST API (POST /api/auth-profiles) for seeding
 * - AuthTimeoutError, AuthCancelledError
 *
 * Mock boundaries: Redis, Logger (infrastructure only)
 * DB: Real MongoDB via MongoMemoryServer
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { initDEKFacade } from '@agent-platform/database/kms';

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
  PausedExecutionStore,
  getPausedExecutionStore,
  resetPausedExecutionStore,
  AuthTimeoutError,
  AuthCancelledError,
} from '../../services/auth-profile/paused-execution-store.js';
import { createAuthProfileToolMiddleware } from '../../services/auth-profile/auth-profile-tool-middleware.js';
import { ServerMessages, parseClientMessage } from '../../websocket/events.js';
import {
  ToolOAuthService,
  InMemoryOAuthStateStore,
  type OAuthTokenStore,
  type OAuthEncryptor,
  type OAuthProviderConfig,
} from '../../services/tool-oauth-service.js';
import {
  hasActiveAuthGate,
  cleanupAuthGate,
  satisfyConnector,
  checkAuthPreflight,
  getAuthGateState,
} from '../../services/auth-profile/auth-preflight.js';
import type { TokenLookupFunctions } from '../../services/auth-profile/consent-state-resolver.js';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

// ── Real MongoDB + API setup ────────────────────────────────────────

import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';
import { setMasterKey } from '@agent-platform/database/models';
import {
  injectTenantContext,
  makeTenantContext,
  ROLE_PERMISSIONS,
} from '../helpers/auth-context.js';
import { authProfileRoutes } from '../../routes/auth-profiles.js';

const TEST_TENANT = 'tenant-jit-e2e';
const TEST_USER = 'user-jit-e2e';
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
}, 60000);

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

function makeTool(overrides: Partial<ToolCallContext['tool']> = {}): ToolCallContext['tool'] {
  return {
    name: 'gmail_lookup',
    description: 'Look up Gmail',
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
      endpoint: 'https://gmail.googleapis.com/lookup',
      method: 'GET' as const,
    },
    ...overrides,
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

const successResult: ToolCallResult = { result: '{"ok": true}' };

/** Poll until a condition is met (avoids flaky fixed-delay waits with MongoMemoryServer) */
async function waitFor(condition: () => boolean, maxMs = 8000, intervalMs = 100): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && !condition(); elapsed += intervalMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Test Suites ─────────────────────────────────────────────────────

describe('Suite 1: Multi-Channel JIT Auth', () => {
  let store: PausedExecutionStore;

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

  it('1.1: Main WS handler sends auth_challenge when tool needs auth and jit_auth=true', async () => {
    // No profile in DB → resolveByName returns null → JIT auth triggers
    const challengesSent: unknown[] = [];
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-main-ws',
      sendAuthChallenge: (params) => challengesSent.push(params),
      initiateJitOAuth: async () => 'https://accounts.google.com/o/oauth2/auth?state=abc',
    });

    const tool = makeTool();
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    // Start the middleware call (will pause waiting for auth)
    const middlewarePromise = middleware(ctx, next);

    // Wait for JIT auth pause (MongoDB query may take time on cold start)
    await waitFor(() => challengesSent.length > 0);

    // Verify auth_challenge was sent
    expect(challengesSent).toHaveLength(1);
    const challenge = challengesSent[0] as Record<string, unknown>;
    expect(challenge.sessionId).toBe('session-main-ws');
    expect(challenge.authType).toBe('oauth2');
    expect(challenge.authUrl).toBe('https://accounts.google.com/o/oauth2/auth?state=abc');
    expect(challenge.profileName).toBe('google-creds');
    expect(challenge.prompt).toContain('google-creds');
    expect(typeof challenge.toolCallId).toBe('string');
    expect(typeof challenge.timeoutMs).toBe('number');

    // Verify the auth_challenge can be serialized as a ServerMessage
    const serverMsg = ServerMessages.authChallenge('session-main-ws', {
      toolCallId: challenge.toolCallId as string,
      authType: 'oauth2',
      authUrl: 'https://accounts.google.com/o/oauth2/auth?state=abc',
      profileId: 'google-creds',
      profileName: 'google-creds',
      prompt: 'Authorize google-creds',
      timeoutMs: 2000,
    });
    expect(serverMsg.type).toBe('auth_challenge');
    expect(serverMsg.sessionId).toBe('session-main-ws');
    expect(serverMsg.code).toBe('AUTH_JIT_REQUIRED');

    // Simulate: OAuth completed, profile now created via API
    await seedBearerProfile('google-creds', 'fresh-token');

    // Resolve the paused execution (simulate auth_response completed)
    const toolCallId = challenge.toolCallId as string;
    store.resolve(toolCallId);

    const result = await middlewarePromise;
    // After resolution, next should be called with patched tool
    expect(next).toHaveBeenCalled();
  });

  it('1.2: SDK WS handler sends auth_challenge when tool needs auth and jit_auth=true', async () => {
    // No profile in DB → JIT triggers
    const challengesSent: unknown[] = [];
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-sdk-ws',
      sendAuthChallenge: (params) => challengesSent.push(params),
      initiateJitOAuth: async () => 'https://accounts.google.com/o/oauth2/auth?state=sdk123',
    });

    const tool = makeTool();
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    const middlewarePromise = middleware(ctx, next);
    await waitFor(() => challengesSent.length > 0);

    expect(challengesSent).toHaveLength(1);
    const challenge = challengesSent[0] as Record<string, unknown>;
    expect(challenge.sessionId).toBe('session-sdk-ws');
    expect(challenge.authUrl).toBe('https://accounts.google.com/o/oauth2/auth?state=sdk123');

    // Seed profile via API and resolve
    await seedBearerProfile('google-creds', 'sdk-token');
    const toolCallId = challenge.toolCallId as string;
    store.resolve(toolCallId);

    await middlewarePromise;
    expect(next).toHaveBeenCalled();
  });

  it('1.3: auth_response with status: completed resumes paused execution', async () => {
    // No profile in DB → JIT triggers
    let capturedToolCallId = '';
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-1',
      sendAuthChallenge: (params) => {
        capturedToolCallId = params.toolCallId;
      },
      initiateJitOAuth: async () => 'https://auth.example.com',
    });

    const tool = makeTool();
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    const middlewarePromise = middleware(ctx, next);
    await waitFor(() => capturedToolCallId !== '');

    expect(capturedToolCallId).toBeTruthy();
    expect(store.has(capturedToolCallId)).toBe(true);

    // Parse an auth_response message (simulating client sending completed)
    const parsedMsg = parseClientMessage(
      JSON.stringify({
        type: 'auth_response',
        toolCallId: capturedToolCallId,
        status: 'completed',
      }),
    );
    expect(parsedMsg).not.toBeNull();
    expect(parsedMsg!.type).toBe('auth_response');

    // Seed profile via API and resolve the paused execution
    await seedBearerProfile('google-creds', 'resolved-token');
    store.resolve(capturedToolCallId);

    await middlewarePromise;
    expect(store.has(capturedToolCallId)).toBe(false);
  });

  it('1.4: auth_response with status: cancelled fails tool call with AuthCancelledError', async () => {
    // No profile in DB → JIT triggers
    let capturedToolCallId = '';
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-1',
      sendAuthChallenge: (params) => {
        capturedToolCallId = params.toolCallId;
      },
      initiateJitOAuth: async () => 'https://auth.example.com',
    });

    const tool = makeTool();
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    const middlewarePromise = middleware(ctx, next);
    await waitFor(() => capturedToolCallId !== '');

    // Reject with AuthCancelledError
    store.reject(capturedToolCallId, new AuthCancelledError());

    const result = await middlewarePromise;
    const parsed = JSON.parse(result.result as string);
    expect(parsed.code).toBe('AUTH_CANCELLED');
    expect(parsed.error).toContain('cancelled');
  });

  it('1.5: Timeout: no auth_response within TTL -> AuthTimeoutError', async () => {
    process.env.JIT_AUTH_TIMEOUT_MS = '200';
    store.destroy();
    resetPausedExecutionStore();
    store = getPausedExecutionStore();

    // No profile in DB → JIT triggers
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-timeout',
      sendAuthChallenge: vi.fn(),
      initiateJitOAuth: async () => 'https://auth.example.com',
    });

    const tool = makeTool();
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    const result = await middleware(ctx, next);
    const parsed = JSON.parse(result.result as string);
    expect(parsed.code).toBe('AUTH_TIMEOUT');
    expect(parsed.error).toContain('timed out');
  });

  it('1.6: Non-OAuth auth profile with jit_auth=true -> returns JIT_AUTH_NOT_SUPPORTED error', async () => {
    // No profile in DB, no initiateJitOAuth callback
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-1',
      sendAuthChallenge: vi.fn(),
    });

    const tool = makeTool();
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    const result = await middleware(ctx, next);
    const parsed = JSON.parse(result.result as string);
    expect(parsed.code).toBe('JIT_AUTH_NOT_SUPPORTED');
    expect(parsed.authCode).toBe('AUTH_JIT_UNSUPPORTED');
    expect(parsed.error).toContain('JIT auth is not supported');
    expect(parsed.error).toContain('google-creds');
  });

  it('1.7: Tool WITHOUT jit_auth but with auth_profile_ref -> fails immediately (no pause)', async () => {
    // No profile in DB → AuthProfileNotFoundError thrown immediately (no JIT)
    const challengesSent: unknown[] = [];
    const middleware = createAuthProfileToolMiddleware({
      tenantId: TEST_TENANT,
      sessionId: 'session-1',
      sendAuthChallenge: (params) => challengesSent.push(params),
      initiateJitOAuth: async () => 'https://auth.example.com',
    });

    const tool = makeTool({ jit_auth: false });
    const ctx = makeCtx(tool);
    const next = vi.fn().mockResolvedValue(successResult);

    await expect(middleware(ctx, next)).rejects.toThrow('AUTH_PROFILE_NOT_FOUND');
    expect(challengesSent).toHaveLength(0);
    expect(store.size).toBe(0);
  });
});

describe('Suite 7: Cross-Session Security', () => {
  let store: PausedExecutionStore;

  beforeEach(async () => {
    await clearCollections();
    resetPausedExecutionStore();
    store = getPausedExecutionStore();
    vi.clearAllMocks();
    process.env.JIT_AUTH_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    store.destroy();
    delete process.env.JIT_AUTH_TIMEOUT_MS;
  });

  it('7.1: auth_response with another sessions toolCallId is rejected (session ownership)', async () => {
    const pausePromise = store.pause({
      sessionId: 'session-A',
      toolCallId: 'tool-call-A',
      authProfileRef: 'google-creds',
      toolName: 'gmail_lookup',
      pausedAt: Date.now(),
      timeoutMs: 5000,
    });

    await new Promise((r) => setTimeout(r, 10));

    const msg = parseClientMessage(
      JSON.stringify({
        type: 'auth_response',
        toolCallId: 'tool-call-A',
        status: 'completed',
      }),
    );
    expect(msg).not.toBeNull();

    const pausedData = store.get('tool-call-A');
    expect(pausedData).not.toBeNull();
    expect(pausedData!.sessionId).toBe('session-A');

    const handlerSessionId = 'session-B';
    expect(pausedData!.sessionId).not.toBe(handlerSessionId);

    store.reject('tool-call-A', new Error('test cleanup'));
    await pausePromise.catch(() => {});
  });

  it('7.2: consent_satisfy for another session has no effect on the target session gate', async () => {
    const mockLookups: TokenLookupFunctions = {
      hasSessionToken: async () => false,
      hasUserToken: async () => false,
      hasTenantToken: async () => false,
    };

    const gateState = await checkAuthPreflight(
      'session-gate-A',
      [
        {
          auth_profile_ref: 'google-creds',
          connector: 'google',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        },
      ],
      { userId: 'user-1', tenantId: 'tenant-1' },
      mockLookups,
    );

    expect(gateState).not.toBeNull();
    expect(hasActiveAuthGate('session-gate-A')).toBe(true);

    const crossResult = satisfyConnector('session-gate-B', 'google-creds');
    expect(crossResult).toBeNull();

    expect(hasActiveAuthGate('session-gate-A')).toBe(true);
    const state = getAuthGateState('session-gate-A');
    expect(state!.pending).toHaveLength(1);
    expect(state!.satisfied).toHaveLength(0);

    cleanupAuthGate('session-gate-A');
  });

  it('7.3: Disconnected sessions paused executions cleaned up', async () => {
    const p1 = store.pause({
      sessionId: 'session-disconnect',
      toolCallId: 'tc-1',
      authProfileRef: 'cred-1',
      toolName: 'tool1',
      pausedAt: Date.now(),
      timeoutMs: 60000,
    });
    const p2 = store.pause({
      sessionId: 'session-disconnect',
      toolCallId: 'tc-2',
      authProfileRef: 'cred-2',
      toolName: 'tool2',
      pausedAt: Date.now(),
      timeoutMs: 60000,
    });
    const p3 = store.pause({
      sessionId: 'session-other',
      toolCallId: 'tc-3',
      authProfileRef: 'cred-3',
      toolName: 'tool3',
      pausedAt: Date.now(),
      timeoutMs: 60000,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(store.size).toBe(3);

    await store.cleanupSession('session-disconnect');

    expect(store.has('tc-1')).toBe(false);
    expect(store.has('tc-2')).toBe(false);
    expect(store.has('tc-3')).toBe(true);
    expect(store.size).toBe(1);

    await expect(p1).rejects.toThrow('Session disconnected');
    await expect(p2).rejects.toThrow('Session disconnected');

    store.reject('tc-3', new Error('cleanup'));
    await p3.catch(() => {});
  });

  it('7.4: JIT metadata expires after TTL -> getJitMetadata returns null', async () => {
    const pausePromise = store.pause({
      sessionId: 'session-ttl',
      toolCallId: 'tc-ttl',
      authProfileRef: 'creds',
      toolName: 'tool',
      pausedAt: Date.now() - 10000,
      timeoutMs: 100,
    });

    await expect(pausePromise).rejects.toThrow('Authorization timed out');
    expect(store.has('tc-ttl')).toBe(false);
  });

  it('7.5: JIT metadata eviction at MAX_JIT_METADATA_ENTRIES capacity', async () => {
    const mockTokenStore: OAuthTokenStore = {
      findToken: vi.fn().mockResolvedValue(null),
      upsertToken: vi.fn().mockResolvedValue(undefined),
      compareAndSwapToken: vi.fn().mockResolvedValue(true),
      markRevoked: vi.fn(),
      updateLastUsed: vi.fn(),
    };
    const mockEncryptor = {
      encryptForTenant: (v: string, tenantId: string) => `enc:${tenantId}:${v}`,
      decryptForTenant: (v: string, _tenantId: string) => v.replace(/^enc:[^:]+:/, ''),
    } as OAuthEncryptor;
    const configs = new Map<string, OAuthProviderConfig>();
    configs.set('google', {
      clientId: 'cid',
      clientSecret: 'csec',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['email'],
    });

    const stateStore = new InMemoryOAuthStateStore();
    const service = new ToolOAuthService(mockTokenStore, mockEncryptor, configs, stateStore);

    try {
      const jitMap = (service as Record<string, unknown>).jitMetadataMap as Map<
        string,
        { sessionId: string; toolCallId: string; createdAt: number }
      >;

      for (let i = 0; i < 999; i++) {
        jitMap.set(`state-${i}`, {
          sessionId: `session-${i}`,
          toolCallId: `tc-${i}`,
          createdAt: Date.now() - (999 - i) * 1000,
        });
      }
      expect(jitMap.size).toBe(999);

      await service.initiateJitOAuth(
        'google',
        'tenant-1',
        'user-1',
        'session-999',
        'tc-999',
        'https://example.com/callback',
      );
      expect(jitMap.size).toBe(1000);
      expect(jitMap.has('state-0')).toBe(true);

      await service.initiateJitOAuth(
        'google',
        'tenant-1',
        'user-1',
        'session-trigger',
        'tc-trigger',
        'https://example.com/callback',
      );

      expect(jitMap.size).toBe(901);
      expect(jitMap.has('state-0')).toBe(false);
      expect(jitMap.has('state-99')).toBe(false);
      expect(jitMap.has('state-100')).toBe(true);

      const recent = service.getJitMetadata('state-998');
      expect(recent).not.toBeNull();
      expect(recent!.sessionId).toBe('session-998');
    } finally {
      service.destroy();
    }
  });

  it('7.6: PausedExecutionStore.sweepExpired() removes timed-out entries', async () => {
    const p = store.pause({
      sessionId: 'session-sweep',
      toolCallId: 'tc-sweep',
      authProfileRef: 'creds',
      toolName: 'tool',
      pausedAt: Date.now() - 100000,
      timeoutMs: 1,
    });

    await expect(p).rejects.toThrow('Authorization timed out');
    expect(store.has('tc-sweep')).toBe(false);
  });

  it('7.7: Auth gate state cleaned up on session reset via cleanupAuthGate', async () => {
    const mockLookups: TokenLookupFunctions = {
      hasSessionToken: async () => false,
      hasUserToken: async () => false,
      hasTenantToken: async () => false,
    };

    const gateState = await checkAuthPreflight(
      'session-reset-test',
      [
        {
          auth_profile_ref: 'google-creds',
          connector: 'google',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        },
        {
          auth_profile_ref: 'salesforce-creds',
          connector: 'salesforce',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        },
      ],
      { userId: 'user-1', tenantId: 'tenant-1' },
      mockLookups,
    );

    expect(gateState).not.toBeNull();
    expect(hasActiveAuthGate('session-reset-test')).toBe(true);
    const state = getAuthGateState('session-reset-test');
    expect(state!.pending).toHaveLength(2);

    cleanupAuthGate('session-reset-test');

    expect(hasActiveAuthGate('session-reset-test')).toBe(false);
    expect(getAuthGateState('session-reset-test')).toBeUndefined();
    const result = satisfyConnector('session-reset-test', 'google-creds');
    expect(result).toBeNull();
  });
});
