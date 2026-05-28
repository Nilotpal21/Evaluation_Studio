import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKSessionTokenPayload } from '@agent-platform/shared-auth';

const mockVerifyRuntimeSdkSessionForAuth = vi.fn();
const mockIssueSdkWsTicket = vi.fn();
const mockCheckTenantOperationRateLimit = vi.fn();
const mockApplyRateLimitHeaders = vi.fn();

vi.mock('../../services/identity/sdk-session-token-auth.js', () => ({
  verifyRuntimeSdkSessionForAuth: (...args: unknown[]) =>
    mockVerifyRuntimeSdkSessionForAuth(...args),
}));

vi.mock('../../services/identity/sdk-ws-ticket-store.js', () => ({
  issueSdkWsTicket: (...args: unknown[]) => mockIssueSdkWsTicket(...args),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  checkTenantOperationRateLimit: (...args: unknown[]) => mockCheckTenantOperationRateLimit(...args),
  applyRateLimitHeaders: (...args: unknown[]) => mockApplyRateLimitHeaders(...args),
}));

const { default: sdkWsTicketRouter } = await import('../../routes/sdk-ws-ticket.js');

function createPayload(): SDKSessionTokenPayload {
  return {
    type: 'sdk_session',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    sessionId: 'session-1',
    sessionPrincipal: 'session-1',
    permissions: ['session:send_message'],
    bootstrapType: 'customer',
    verifiedUserId: 'verified-user-1',
    authScope: 'user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sdk', sdkWsTicketRouter);
  return app;
}

describe('SDK WebSocket ticket route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyRuntimeSdkSessionForAuth.mockResolvedValue({
      success: true,
      payload: createPayload(),
      envelope: 'jwe',
    });
    mockIssueSdkWsTicket.mockResolvedValue({
      success: true,
      ticket: 'ticket-1',
      expiresIn: 60,
    });
    mockCheckTenantOperationRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetMs: 60_000,
      limit: 20,
    });
  });

  it('mints a ticket after token verification and tenant rate limiting', async () => {
    await request(createApp())
      .post('/api/v1/sdk/ws-ticket')
      .set('X-SDK-Token', 'sdk-token-1')
      .send({})
      .expect(200, { ticket: 'ticket-1', expiresIn: 60 });

    expect(mockVerifyRuntimeSdkSessionForAuth).toHaveBeenCalledWith('sdk-token-1');
    expect(mockCheckTenantOperationRateLimit).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      operation: 'request',
      overrideLimits: { requestsPerMinute: 20 },
    });
    expect(mockIssueSdkWsTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
      }),
      'jwe',
    );
  });

  it('does not issue a ticket when the rate limit rejects the request', async () => {
    mockCheckTenantOperationRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetMs: 30_000,
      limit: 20,
    });

    const response = await request(createApp())
      .post('/api/v1/sdk/ws-ticket')
      .set('X-SDK-Token', 'sdk-token-1')
      .send({})
      .expect(429);

    expect(response.body.error).toBe('RATE_LIMITED');
    expect(mockIssueSdkWsTicket).not.toHaveBeenCalled();
  });
});
