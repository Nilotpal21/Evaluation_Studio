import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminResilienceRouter from '../routes/platform-admin-resilience.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  devLogin,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
} from './helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';
import {
  initializeRedis,
  disconnectRedis,
  getRedisClient,
} from '../services/redis/redis-client.js';
import { resetCircuitBreakerRegistry } from '../services/resilience/hybrid-cb-registry.js';
import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';

const E2E_TIMEOUT_MS = 90_000;
const BREAKER_KEY_SUFFIX = 'resilience-e2e-service';
const describePlatformAdminResilience = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describePlatformAdminResilience('Platform admin resilience E2E', () => {
  let harness: RuntimeApiHarness;
  let redisHarness: RedisServerHarness;

  beforeAll(async () => {
    redisHarness = await startRedisServerHarness();
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/resilience', platformAdminResilienceRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redisHarness.url,
      },
      {
        requireAsyncInfra: false,
      },
    );

    await initializeRedis();
  }, E2E_TIMEOUT_MS);

  beforeEach(async () => {
    await harness.resetRuntimeState();
    await redisHarness.clear();
    resetCircuitBreakerRegistry();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    resetCircuitBreakerRegistry();
    await disconnectRedis();
    await harness?.close();
    await redisHarness?.close();
  });

  async function loginAsSuperAdmin(): Promise<string> {
    const login = await devLogin(harness, uniqueEmail('platform-admin-resilience'));
    await setSuperAdmins([login.user.id]);
    return login.accessToken;
  }

  async function seedOpenToolServiceBreaker(tenantId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) {
      throw new Error('Redis client was not initialized');
    }

    const breaker = new RedisCircuitBreaker(redis, 'tool_service', {
      failureThreshold: 1,
      successThreshold: 1,
      resetTimeout: 5_000,
      monitorWindow: 30_000,
      halfOpenMaxConcurrent: 1,
      failureRateThreshold: 100,
      minimumRequestCount: 100,
    });

    await expect(
      breaker.execute(`${tenantId}:${BREAKER_KEY_SUFFIX}`, async () => {
        throw new Error('upstream unavailable');
      }),
    ).rejects.toThrow('upstream unavailable');
  }

  it('rejects unauthenticated force-reset requests through the real auth chain', async () => {
    const response = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
    }>(harness, '/api/platform/admin/resilience/tenants/tenant-noauth/force-reset', {
      method: 'POST',
      body: { targetState: 'CLOSED' },
    });

    expect(response.status).toBe(401);
  });

  it('validates targetState on the real HTTP route', async () => {
    const token = await loginAsSuperAdmin();

    const response = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
      details?: Array<{ path: string[]; message: string }>;
    }>(harness, '/api/platform/admin/resilience/tenants/tenant-validation/force-reset', {
      method: 'POST',
      headers: authHeaders(token),
      body: { targetState: 'BROKEN' },
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('VALIDATION_ERROR');
    expect(response.body.details?.length).toBeGreaterThan(0);
  });

  it('force-resets a tenant breaker to HALF_OPEN and clears stale counts via the HTTP API', async () => {
    const tenantId = 'tenant-resilience-e2e';
    const token = await loginAsSuperAdmin();

    await seedOpenToolServiceBreaker(tenantId);

    const beforeReset = await requestJson<{
      success: boolean;
      data: {
        tenantId: string;
        healthy: boolean;
        toolServices: Array<{
          key: string;
          metrics: {
            state: string;
            failureCount: number;
            successCount: number;
            totalCount: number;
            halfOpenCount: number;
          };
        }>;
      };
    }>(harness, `/api/platform/admin/resilience/tenants/${tenantId}/health`, {
      headers: authHeaders(token),
    });

    expect(beforeReset.status).toBe(200);
    expect(beforeReset.body.success).toBe(true);
    expect(beforeReset.body.data.healthy).toBe(false);
    expect(beforeReset.body.data.toolServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `${tenantId}:${BREAKER_KEY_SUFFIX}`,
          metrics: expect.objectContaining({
            state: 'OPEN',
            failureCount: 1,
          }),
        }),
      ]),
    );

    const resetResponse = await requestJson<{
      success: boolean;
      data: { tenantId: string; targetState: string; message: string };
    }>(harness, `/api/platform/admin/resilience/tenants/${tenantId}/force-reset`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { targetState: 'HALF_OPEN' },
    });

    expect(resetResponse.status).toBe(200);
    expect(resetResponse.body.success).toBe(true);
    expect(resetResponse.body.data.tenantId).toBe(tenantId);
    expect(resetResponse.body.data.targetState).toBe('HALF_OPEN');

    const afterReset = await requestJson<{
      success: boolean;
      data: {
        tenantId: string;
        healthy: boolean;
        toolServices: Array<{
          key: string;
          metrics: {
            state: string;
            failureCount: number;
            successCount: number;
            totalCount: number;
            halfOpenCount: number;
          };
        }>;
      };
    }>(harness, `/api/platform/admin/resilience/tenants/${tenantId}/health`, {
      headers: authHeaders(token),
    });

    expect(afterReset.status).toBe(200);
    expect(afterReset.body.success).toBe(true);
    expect(afterReset.body.data.healthy).toBe(true);
    expect(afterReset.body.data.toolServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `${tenantId}:${BREAKER_KEY_SUFFIX}`,
          metrics: expect.objectContaining({
            state: 'HALF_OPEN',
            failureCount: 0,
            successCount: 0,
            totalCount: 0,
            halfOpenCount: 0,
          }),
        }),
      ]),
    );
  });
});
