/**
 * Escalation E2E Tests
 *
 * Tests the escalation resolution and status HTTP API endpoints through the real
 * Express middleware chain: auth → rate limiting → project scope → session ownership
 * → Zod validation → handler.
 *
 * Architecture decisions:
 * - HumanTask records are seeded via the Mongoose model because no HTTP API exists
 *   for creating escalation tasks (they are created internally during runtime execution).
 * - All assertions use HTTP API responses — no direct DB reads for verification.
 * - Redis is required for the distributed lock in the resolution handler.
 * - Auth uses devLogin + bootstrapProject for real JWT-based authentication.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import sessionsRouter from '../routes/sessions.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';
import {
  bootstrapProject,
  requestJson,
  authHeaders,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

const E2E_TIMEOUT_MS = 120_000;

const describeEscalationE2E = isRedisServerHarnessAvailable() ? describe : describe.skip;

describeEscalationE2E('Escalation E2E', () => {
  let harness: RuntimeApiHarness;
  let redisHarness: RedisServerHarness;
  let token: string;
  let tenantId: string;
  let projectId: string;

  // Unique session IDs per test to avoid cross-test interference
  let sessionCounter = 0;
  function nextSessionId(): string {
    return `esc-e2e-session-${++sessionCounter}-${Date.now()}`;
  }

  beforeAll(async () => {
    redisHarness = await startRedisServerHarness();

    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
      },
      { REDIS_ENABLED: 'true', REDIS_URL: redisHarness.url },
    );

    // Initialize the Redis client singleton now that env vars are set
    const { initializeRedis } = await import('../services/redis/redis-client.js');
    await initializeRedis();

    const bootstrap = await bootstrapProject(
      harness,
      uniqueEmail('escalation-e2e'),
      uniqueSlug('esc-tenant'),
      uniqueSlug('esc-project'),
    );
    token = bootstrap.token;
    tenantId = bootstrap.tenantId;
    projectId = bootstrap.projectId;
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    const { disconnectRedis } = await import('../services/redis/redis-client.js');
    await disconnectRedis();
    await harness?.close();
    await redisHarness?.close();
  });

  // ---------------------------------------------------------------------------
  // HumanTask seeding — required because no HTTP API exists for HumanTask creation.
  // Escalation tasks are created internally by the runtime during ESCALATE execution.
  // ---------------------------------------------------------------------------

  async function seedHumanTask(
    sessionId: string,
    overrides?: Record<string, unknown>,
  ): Promise<string> {
    const { HumanTask } = await import('@agent-platform/database/models');
    const doc = new HumanTask({
      tenantId,
      projectId,
      type: 'escalation',
      mailbox: 'agent',
      status: 'pending',
      priority: 'medium',
      title: 'Test escalation — customer needs human help',
      source: {
        type: 'agent_escalation',
        sessionId,
        agentName: 'test-agent',
      },
      context: {
        on_human_complete: [
          { condition: 'decision == "resolved"', action: 'continue' },
          { condition: 'decision == "transfer"', action: 'handoff' },
          { condition: 'always', action: 'continue' },
        ],
      },
      escalationChain: [],
      currentEscalationLevel: 0,
      ...overrides,
    });
    await doc.save();
    return doc._id as string;
  }

  beforeEach(async () => {
    await redisHarness.clear();
  });

  // ---------------------------------------------------------------------------
  // Resolution API — POST /:id/escalation/resolve
  // ---------------------------------------------------------------------------

  describe('POST /:id/escalation/resolve', () => {
    it('resolves an escalation with valid decision → 200 + action', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      const res = await requestJson<{
        success: boolean;
        data?: { action: string; humanTaskId: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            decision: 'resolved',
            notes: 'Customer issue fixed',
            respondedBy: 'human-agent-001',
          },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.action).toBe('continue');
      expect(res.body.data?.humanTaskId).toBeTruthy();
    });

    it('returns matched action from on_human_complete conditions', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      const res = await requestJson<{
        success: boolean;
        data?: { action: string; humanTaskId: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            decision: 'transfer',
            respondedBy: 'human-agent-002',
          },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.action).toBe('handoff');
    });

    it('returns 409 for already-resolved escalation', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId, { status: 'completed' });

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            decision: 'resolved',
            respondedBy: 'agent-003',
          },
        },
      });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ESCALATION_ALREADY_RESOLVED');
    });

    it('returns 422 for invalid resolution body', async () => {
      const sessionId = nextSessionId();

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            // Missing required 'decision' field
            respondedBy: 'agent-004',
          },
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('INVALID_RESOLUTION');
    });

    it('returns 422 when resolution object is missing entirely', async () => {
      const sessionId = nextSessionId();

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {},
      });

      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe('INVALID_RESOLUTION');
    });

    it('returns 422 for empty decision string', async () => {
      const sessionId = nextSessionId();

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            decision: '', // z.string().min(1) rejects empty strings
            respondedBy: 'agent-005',
          },
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe('INVALID_RESOLUTION');
    });

    it('returns 404 for non-existent session escalation', async () => {
      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/nonexistent-session-id/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            decision: 'resolved',
            respondedBy: 'agent-006',
          },
        },
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ESCALATION_NOT_FOUND');
    });

    it('double resolution returns 409 on second attempt', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      // First resolution — succeeds
      const first = await requestJson<{ success: boolean }>(
        harness,
        `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body: {
            resolution: { decision: 'resolved', respondedBy: 'agent-007' },
          },
        },
      );
      expect(first.status).toBe(200);
      expect(first.body.success).toBe(true);

      // Second resolution — already completed
      const second = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: { decision: 'resolved', respondedBy: 'agent-008' },
        },
      });
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('ESCALATION_ALREADY_RESOLVED');
    });
  });

  // ---------------------------------------------------------------------------
  // Status API — GET /:id/escalation
  // ---------------------------------------------------------------------------

  describe('GET /:id/escalation', () => {
    it('returns escalation status for pending task', async () => {
      const sessionId = nextSessionId();
      const humanTaskId = await seedHumanTask(sessionId);

      const res = await requestJson<{
        success: boolean;
        data?: {
          humanTaskId: string;
          status: string;
          priority: string;
          title: string;
          createdAt: string;
          updatedAt: string;
        };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.humanTaskId).toBe(humanTaskId);
      expect(res.body.data?.status).toBe('pending');
      expect(res.body.data?.priority).toBe('medium');
      expect(res.body.data?.title).toBe('Test escalation — customer needs human help');
    });

    it('returns ITSM connector ticket details when present', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId, {
        connectorTicketId: 'INC-2026-001',
        connectorTicketUrl: 'https://itsm.example.com/incidents/INC-2026-001',
        connectorActionName: 'servicenow_create_incident',
      });

      const res = await requestJson<{
        success: boolean;
        data?: {
          humanTaskId: string;
          connectorTicketId: string;
          connectorTicketUrl: string;
        };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.connectorTicketId).toBe('INC-2026-001');
      expect(res.body.data?.connectorTicketUrl).toBe(
        'https://itsm.example.com/incidents/INC-2026-001',
      );
    });

    it('returns completed status with response after resolution', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      // Resolve the escalation first
      await requestJson(
        harness,
        `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`,
        {
          method: 'POST',
          headers: authHeaders(token),
          body: {
            resolution: {
              decision: 'resolved',
              notes: 'Fixed the issue',
              respondedBy: 'human-agent-010',
            },
          },
        },
      );

      // Now check status
      const res = await requestJson<{
        success: boolean;
        data?: {
          status: string;
          response?: {
            respondedBy: string;
            decision: string;
            notes: string;
          };
        };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.status).toBe('completed');
      expect(res.body.data?.response?.respondedBy).toBe('human-agent-010');
      expect(res.body.data?.response?.decision).toBe('resolved');
      expect(res.body.data?.response?.notes).toBe('Fixed the issue');
    });

    it('returns 404 for non-existent session escalation', async () => {
      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/nonexistent-id/escalation`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error?.code).toBe('ESCALATION_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // ITSM Connector Failure (E2E-3)
  // ---------------------------------------------------------------------------

  describe('ITSM connector failure is non-blocking (E2E-3)', () => {
    it('escalation with failed connector has null connectorTicketId', async () => {
      const sessionId = nextSessionId();
      // Seed HumanTask with connector_action configured but no ticket info —
      // simulates what happens when the ITSM webhook fails (fire-and-forget
      // in routing-executor catches errors and leaves ticket fields null)
      await seedHumanTask(sessionId, {
        connectorActionName: 'servicenow_create_incident',
        // connectorTicketId intentionally absent — connector call failed
        // connectorTicketUrl intentionally absent
      });

      const res = await requestJson<{
        success: boolean;
        data?: {
          humanTaskId: string;
          status: string;
          connectorTicketId?: string | null;
          connectorTicketUrl?: string | null;
        };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      // Escalation exists and is pending — connector failure didn't prevent creation
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.status).toBe('pending');

      // Connector ticket fields should be absent (connector failed)
      expect(res.body.data?.connectorTicketId).toBeUndefined();
      expect(res.body.data?.connectorTicketUrl).toBeUndefined();
    });

    it('escalation is still resolvable after connector failure', async () => {
      const sessionId = nextSessionId();
      // Connector action configured but failed — no ticket info
      await seedHumanTask(sessionId, {
        connectorActionName: 'servicenow_create_incident',
      });

      // Resolution should succeed — connector failure is non-blocking
      const res = await requestJson<{
        success: boolean;
        data?: { action: string; humanTaskId: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: {
            decision: 'resolved',
            notes: 'Resolved despite ITSM failure',
            respondedBy: 'human-agent-itsm',
          },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.action).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent Resolution (INT-11 at E2E level)
  // ---------------------------------------------------------------------------

  describe('concurrent resolution idempotency', () => {
    it('concurrent resolve attempts — one succeeds, others get 409', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      // Fire 3 concurrent resolution requests
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          requestJson<{
            success: boolean;
            data?: { action: string };
            error?: { code: string };
          }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
            method: 'POST',
            headers: authHeaders(token),
            body: {
              resolution: {
                decision: 'resolved',
                respondedBy: `concurrent-agent-${i}`,
              },
            },
          }),
        ),
      );

      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);

      // Exactly one should succeed
      expect(successes).toHaveLength(1);
      expect(successes[0].body.success).toBe(true);

      // Others should get 409 (already resolved)
      expect(conflicts).toHaveLength(2);
      for (const c of conflicts) {
        expect(c.body.error?.code).toBe('ESCALATION_ALREADY_RESOLVED');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Auth & Permission (E2E-15 partial)
  // ---------------------------------------------------------------------------

  describe('auth requirements (E2E-15)', () => {
    it('resolve without auth token returns 401', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        // No auth headers
        body: {
          resolution: { decision: 'resolved', respondedBy: 'anon' },
        },
      });

      expect(res.status).toBe(401);
    });

    it('GET escalation without auth token returns 401', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation`, {
        method: 'GET',
        // No auth headers
      });

      expect(res.status).toBe(401);
    });

    it('resolve with invalid auth token returns 401', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId);

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token-xyz' },
        body: {
          resolution: { decision: 'resolved', respondedBy: 'invalid-user' },
        },
      });

      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant Isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('resolve returns 404 for escalation belonging to different tenant', async () => {
      const sessionId = nextSessionId();
      // Seed with a different tenantId — simulates another tenant's escalation
      await seedHumanTask(sessionId, { tenantId: 'other-tenant-xyz' });

      // Our token's tenantId won't match the HumanTask's tenantId
      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation/resolve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: {
          resolution: { decision: 'resolved', respondedBy: 'agent-cross-tenant' },
        },
      });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('ESCALATION_NOT_FOUND');
    });

    it('GET status returns 404 for escalation belonging to different tenant', async () => {
      const sessionId = nextSessionId();
      await seedHumanTask(sessionId, { tenantId: 'other-tenant-xyz' });

      const res = await requestJson<{
        success: boolean;
        error?: { code: string; message: string };
      }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/escalation`, {
        method: 'GET',
        headers: authHeaders(token),
      });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('ESCALATION_NOT_FOUND');
    });
  });
});
