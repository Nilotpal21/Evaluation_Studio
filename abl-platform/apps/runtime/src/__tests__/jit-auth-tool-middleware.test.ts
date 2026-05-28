/**
 * Tests for JIT Auth Tool Middleware (Phase 5 — Tasks 5.5, 5.6)
 *
 * Verifies:
 * - Tool with jit_auth: true and missing credentials → pauses → auth_challenge sent
 * - auth_response(completed) → tool retries → succeeds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuthProfileToolMiddleware } from '../services/auth-profile/auth-profile-tool-middleware.js';
import {
  getPausedExecutionStore,
  resetPausedExecutionStore,
} from '../services/auth-profile/paused-execution-store.js';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

// Mock Redis
vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

// Mock resolveToolAuth to simulate profile not found, then found on retry
const mockState = vi.hoisted(() => ({
  resolveCallCount: 0,
}));

const hoisted = vi.hoisted(() => {
  class HoistedAuthProfileNotFoundError extends Error {
    constructor(profileName: string, toolName: string, jitAuth: boolean) {
      super(
        `AUTH_PROFILE_NOT_FOUND: Profile "${profileName}" not found for tool "${toolName}".${
          jitAuth ? ' JIT auth will trigger user consent.' : ' Profile not found or inactive.'
        }`,
      );
      this.name = 'AuthProfileNotFoundError';
    }
  }

  return {
    AuthProfileNotFoundError: HoistedAuthProfileNotFoundError,
  };
});

vi.mock('../services/auth-profile/resolve-tool-auth.js', () => ({
  AuthProfileNotFoundError: hoisted.AuthProfileNotFoundError,
  resolveToolAuth: vi.fn(async () => {
    mockState.resolveCallCount += 1;
    if (mockState.resolveCallCount <= 1) {
      throw new hoisted.AuthProfileNotFoundError('google-oauth', 'calendar-lookup', true);
    }
    // Second call succeeds (after auth)
    return {
      headers: { Authorization: 'Bearer fresh-token-123' },
      source: 'auth_profile' as const,
      authType: 'oauth2',
    };
  }),
}));

function makeToolDef(overrides: Record<string, unknown> = {}) {
  return {
    name: 'calendar-lookup',
    auth_profile_ref: 'google-oauth',
    jit_auth: true,
    http_binding: {
      endpoint: 'https://api.google.com/calendar',
      method: 'GET' as const,
      headers: {},
      auth: { type: 'none' as const },
    },
    ...overrides,
  };
}

describe('JIT Auth Tool Middleware', () => {
  let sendAuthChallenge: ReturnType<typeof vi.fn>;
  let initiateJitOAuth: ReturnType<typeof vi.fn>;
  let nextFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockState.resolveCallCount = 0;
    resetPausedExecutionStore();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    sendAuthChallenge = vi.fn();
    initiateJitOAuth = vi.fn().mockResolvedValue('https://auth.example.com/authorize');
    nextFn = vi.fn(
      async (): Promise<ToolCallResult> => ({
        result: '{"events": ["meeting at 3pm"]}',
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through tools without auth_profile_ref', async () => {
    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sendAuthChallenge,
      initiateJitOAuth,
    });

    const ctx: ToolCallContext = {
      toolName: 'no-auth-tool',
      params: {},
      timeoutMs: 30000,
      tool: { name: 'no-auth-tool' } as any,
    };

    await middleware(ctx, nextFn);
    expect(nextFn).toHaveBeenCalledOnce();
    expect(sendAuthChallenge).not.toHaveBeenCalled();
  });

  it('returns structured JIT auth error on non-interactive channels', async () => {
    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
    });

    const ctx: ToolCallContext = {
      toolName: 'calendar-lookup',
      params: {},
      timeoutMs: 30000,
      tool: makeToolDef() as any,
    };

    const result = await middleware(ctx, nextFn);
    const parsed = JSON.parse(String(result.result)) as Record<string, unknown>;

    expect(parsed.code).toBe('JIT_AUTH_NOT_SUPPORTED');
    expect(parsed.authCode).toBe('AUTH_JIT_UNSUPPORTED');
    expect(String(parsed.error)).toContain('interactive authorization challenge');
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('sends auth_challenge when jit_auth tool has no credentials (Task 5.5)', async () => {
    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sendAuthChallenge,
      initiateJitOAuth,
    });

    const tool = makeToolDef();
    const ctx: ToolCallContext = {
      toolName: 'calendar-lookup',
      params: {},
      timeoutMs: 30000,
      tool: tool as any,
    };

    // Start the middleware (it will pause internally)
    const resultPromise = middleware(ctx, nextFn);

    // Give the middleware time to reach the pause point
    await vi.advanceTimersByTimeAsync(50);

    // Verify auth_challenge was sent
    expect(sendAuthChallenge).toHaveBeenCalledOnce();
    expect(sendAuthChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        authType: 'oauth2',
        profileName: 'google-oauth',
      }),
    );

    // Verify execution is paused
    const store = getPausedExecutionStore();
    // Find the toolCallId from the challenge call
    const challengeArgs = sendAuthChallenge.mock.calls[0][0];
    const toolCallId = challengeArgs.toolCallId;
    expect(store.has(toolCallId)).toBe(true);

    // Resolve the pause (simulate auth_response(completed))
    store.resolve(toolCallId);

    const result = await resultPromise;

    // Tool should have been retried with fresh credentials
    expect(nextFn).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.result)).toContain('meeting at 3pm');
  });

  it('returns error when jit_auth times out (Task 5.7 via middleware)', async () => {
    // Override timeout to be very short
    process.env.JIT_AUTH_TIMEOUT_MS = '100';

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sendAuthChallenge,
      initiateJitOAuth,
    });

    const tool = makeToolDef();
    const ctx: ToolCallContext = {
      toolName: 'calendar-lookup',
      params: {},
      timeoutMs: 30000,
      tool: tool as any,
    };

    const resultPromise = middleware(ctx, nextFn);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(200);

    const result = await resultPromise;

    expect(JSON.stringify(result.result)).toContain('AUTH_TIMEOUT');
    expect(nextFn).not.toHaveBeenCalled();

    delete process.env.JIT_AUTH_TIMEOUT_MS;
  });
});
