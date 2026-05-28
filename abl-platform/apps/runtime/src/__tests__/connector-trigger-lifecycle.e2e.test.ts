/**
 * Connector Trigger Lifecycle E2E Tests (E2E-3 + E2E-8)
 *
 * Tests trigger registration lifecycle and webhook security via HTTP API:
 * - E2E-3: Create -> webhook dispatch -> pause -> resume -> delete lifecycle
 * - E2E-8: HMAC signature verification, replay protection, event dedup
 *
 * Uses real Express server with full middleware chain for management routes.
 * Webhook route is unauthenticated (simulates external service POSTing).
 * External infrastructure (Redis, Restate) uses in-memory doubles.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  handleWebhook,
  ConnectorRegistry,
  type WebhookHandlerDeps,
  type WebhookRequest,
  type WebhookResult,
  type TriggerRedisClient,
  type RestateIngressClient,
  type WorkflowTriggerInput,
  type TriggerRegistrationModel,
  type TriggerRegistration as TriggerRegistrationType,
} from '@agent-platform/connectors';
import type { Connector } from '@agent-platform/connectors';
import { TriggerRegistration } from '@agent-platform/database/models';
import { decryptForTenantAuto, encryptForTenantAuto } from '@agent-platform/shared/encryption';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  requestJson,
  authHeaders,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

const TIMEOUT = 90_000;

// ─── In-Memory Redis (external service double) ─────────────────────────────

class InMemoryRedis implements TriggerRedisClient {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(
    key: string,
    value: string,
    mode: string,
    duration: number,
    flag: string,
  ): Promise<string | null> {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }

    if (flag === 'NX' && this.store.has(key)) {
      return null;
    }

    this.store.set(key, {
      value,
      expiresAt: now + duration,
    });
    return 'OK';
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── In-Memory Restate Client (external service double) ─────────────────────

class InMemoryRestateClient implements RestateIngressClient {
  readonly invocations: Array<{
    executionId: string;
    input: WorkflowTriggerInput;
  }> = [];

  async startWorkflow(executionId: string, input: WorkflowTriggerInput): Promise<void> {
    this.invocations.push({ executionId, input });
  }

  clear(): void {
    this.invocations.length = 0;
  }
}

// ─── Test Connector ─────────────────────────────────────────────────────────

const webhookTestConnector: Connector = {
  name: 'test-webhook-connector',
  displayName: 'Test Webhook Connector',
  version: '1.0.0',
  description: 'Webhook connector for E2E testing',
  auth: { type: 'api_key' },
  triggers: [
    {
      name: 'incoming_webhook',
      displayName: 'Incoming Webhook',
      description: 'Fires on incoming webhook',
      triggerType: 'webhook',
      props: [],
      onEnable: async () => {},
      onDisable: async () => {},
      run: async () => [],
    },
  ],
  actions: [],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeHmac(secret: string, rawBody: Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Connector Trigger Lifecycle E2E (E2E-3 + E2E-8)', () => {
  let harness: RuntimeApiHarness;
  let primary: BootstrapProjectResult;
  let redis: InMemoryRedis;
  let restateClient: InMemoryRestateClient;
  let registry: ConnectorRegistry;
  let webhookDeps: WebhookHandlerDeps;

  beforeAll(async () => {
    redis = new InMemoryRedis();
    restateClient = new InMemoryRestateClient();
    registry = new ConnectorRegistry();
    registry.register(webhookTestConnector);

    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);

      // ── Authenticated trigger management routes (test-only) ─────────
      const triggerRouter = Router({ mergeParams: true });
      triggerRouter.use(authMiddleware);
      triggerRouter.use(requireProjectScope('projectId'));

      // POST / — create trigger registration
      triggerRouter.post('/', async (req: Request, res: Response) => {
        try {
          if (!(await requireProjectPermission(req, res, 'connection:write'))) return;

          const tenantId = (req as any).tenantContext?.tenantId || '';
          const { projectId } = req.params;
          const { connectorName, triggerName, workflowId, connectionId, config } = req.body;

          const secret = generateWebhookSecret();
          const encrypted = await encryptForTenantAuto(secret, tenantId, projectId);

          const doc = await TriggerRegistration.create({
            tenantId,
            projectId,
            connectorName,
            triggerName,
            workflowId,
            connectionId,
            triggerType: 'webhook',
            status: 'active',
            config: config || {},
            webhookSecret: encrypted,
            consecutiveErrors: 0,
          });

          res.status(201).json({
            success: true,
            data: {
              ...doc.toObject(),
              webhookUrl: `/webhooks/${connectorName}/${doc._id}`,
            },
            _webhookSecretPlain: secret,
          });
        } catch (err) {
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });

      // GET /:id — get trigger registration
      triggerRouter.get('/:id', async (req: Request, res: Response) => {
        try {
          if (!(await requireProjectPermission(req, res, 'connection:read'))) return;

          const tenantId = (req as any).tenantContext?.tenantId || '';
          const { projectId, id } = req.params;

          const doc = await TriggerRegistration.findOne({
            _id: id,
            tenantId,
            projectId,
          }).lean();

          if (!doc) {
            res.status(404).json({
              success: false,
              error: { code: 'NOT_FOUND', message: 'Trigger not found' },
            });
            return;
          }

          res.json({ success: true, data: doc });
        } catch (err) {
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });

      // POST /:id/pause — pause trigger
      triggerRouter.post('/:id/pause', async (req: Request, res: Response) => {
        try {
          if (!(await requireProjectPermission(req, res, 'connection:write'))) return;

          const tenantId = (req as any).tenantContext?.tenantId || '';
          const { projectId, id } = req.params;

          const doc = await TriggerRegistration.findOneAndUpdate(
            { _id: id, tenantId, projectId },
            { $set: { status: 'paused' } },
            { new: true },
          ).lean();

          if (!doc) {
            res.status(404).json({
              success: false,
              error: { code: 'NOT_FOUND', message: 'Trigger not found' },
            });
            return;
          }

          res.json({ success: true, data: doc });
        } catch (err) {
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });

      // POST /:id/resume — resume trigger
      triggerRouter.post('/:id/resume', async (req: Request, res: Response) => {
        try {
          if (!(await requireProjectPermission(req, res, 'connection:write'))) return;

          const tenantId = (req as any).tenantContext?.tenantId || '';
          const { projectId, id } = req.params;

          const doc = await TriggerRegistration.findOneAndUpdate(
            { _id: id, tenantId, projectId },
            { $set: { status: 'active', consecutiveErrors: 0 } },
            { new: true },
          ).lean();

          if (!doc) {
            res.status(404).json({
              success: false,
              error: { code: 'NOT_FOUND', message: 'Trigger not found' },
            });
            return;
          }

          res.json({ success: true, data: doc });
        } catch (err) {
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });

      // DELETE /:id — delete trigger
      triggerRouter.delete('/:id', async (req: Request, res: Response) => {
        try {
          if (!(await requireProjectPermission(req, res, 'connection:write'))) return;

          const tenantId = (req as any).tenantContext?.tenantId || '';
          const { projectId, id } = req.params;

          const doc = await TriggerRegistration.findOneAndDelete({
            _id: id,
            tenantId,
            projectId,
          }).lean();

          if (!doc) {
            res.status(404).json({
              success: false,
              error: { code: 'NOT_FOUND', message: 'Trigger not found' },
            });
            return;
          }

          res.json({ success: true, data: { deleted: true } });
        } catch (err) {
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });

      app.use('/api/projects/:projectId/triggers', triggerRouter);

      // ── Unauthenticated webhook route ────────────────────────────────
      app.post('/webhooks/:connectorName/:registrationId', async (req: Request, res: Response) => {
        try {
          const rawBody: Buffer =
            (req as any).rawBody instanceof Buffer
              ? (req as any).rawBody
              : Buffer.from(JSON.stringify(req.body ?? {}));

          const parsedBody =
            typeof req.body === 'object' && req.body !== null
              ? req.body
              : rawBody.length > 0
                ? JSON.parse(rawBody.toString())
                : {};

          const webhookReq: WebhookRequest = {
            params: {
              connectorName: req.params.connectorName,
              registrationId: req.params.registrationId,
            },
            headers: req.headers as Record<string, string>,
            body: parsedBody,
            rawBody,
          };

          const result: WebhookResult = await handleWebhook(webhookReq, webhookDeps);
          res.status(result.status).json(result.body);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });

    // Build a TriggerRegistrationModel adapter around real Mongoose model
    const registrationModelAdapter: TriggerRegistrationModel = {
      async findOne(filter: Record<string, unknown>): Promise<TriggerRegistrationType | null> {
        const doc = await TriggerRegistration.findOne(filter).lean();
        if (!doc) return null;
        return doc as unknown as TriggerRegistrationType;
      },
      async findOneAndUpdate(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ): Promise<TriggerRegistrationType | null> {
        const doc = await TriggerRegistration.findOneAndUpdate(filter, update, {
          ...options,
          new: true,
        }).lean();
        if (!doc) return null;
        return doc as unknown as TriggerRegistrationType;
      },
    };

    webhookDeps = {
      registry,
      registrationModel: registrationModelAdapter,
      redis,
      restateClient,
      decryptSecret: async (encryptedSecret: string, tenantId: string): Promise<string> => {
        return decryptForTenantAuto(encryptedSecret, tenantId);
      },
    };

    primary = await bootstrapProject(
      harness,
      uniqueEmail('trigger-e2e'),
      uniqueSlug('tenant-trig'),
      uniqueSlug('project-trig'),
    );
  }, TIMEOUT);

  afterAll(async () => {
    await harness?.close();
  }, TIMEOUT);

  beforeEach(() => {
    redis.clear();
    restateClient.clear();
  });

  // ─── Helper: send raw webhook POST ─────────────────────────────────────

  async function sendWebhook(
    connectorName: string,
    registrationId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const rawBody = JSON.stringify(body);
    const allHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    const response = await fetch(`${harness.baseUrl}/webhooks/${connectorName}/${registrationId}`, {
      method: 'POST',
      headers: allHeaders,
      body: rawBody,
    });

    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) : {};
    return { status: response.status, body: parsed };
  }

  // ─── Helper: create trigger via API ────────────────────────────────────

  async function createTriggerViaApi(overrides: Record<string, unknown> = {}) {
    const response = await requestJson<{
      success: boolean;
      data: Record<string, unknown>;
      _webhookSecretPlain: string;
    }>(harness, `/api/projects/${primary.projectId}/triggers`, {
      method: 'POST',
      headers: authHeaders(primary.token),
      body: {
        connectorName: 'test-webhook-connector',
        triggerName: 'incoming_webhook',
        workflowId: `wf-${crypto.randomUUID().slice(0, 8)}`,
        connectionId: `conn-${crypto.randomUUID().slice(0, 8)}`,
        ...overrides,
      },
    });
    return response;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // E2E-3: Trigger Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  describe('E2E-3: Trigger Lifecycle', () => {
    let triggerId: string;
    let webhookSecret: string;
    let connectorName: string;
    let workflowId: string;

    test('1. POST creates trigger registration', async () => {
      workflowId = `wf-lifecycle-${crypto.randomUUID().slice(0, 8)}`;
      const response = await createTriggerViaApi({ workflowId });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data._id).toBeDefined();
      expect(response.body.data.status).toBe('active');
      expect(response.body.data.triggerType).toBe('webhook');
      expect(response.body.data.webhookSecret).toBeDefined();
      expect(response.body.data.webhookUrl).toContain('/webhooks/');
      expect(response.body._webhookSecretPlain).toBeDefined();

      triggerId = response.body.data._id as string;
      webhookSecret = response.body._webhookSecretPlain;
      connectorName = response.body.data.connectorName as string;
    });

    test('2. POST valid signed webhook dispatches to Restate', async () => {
      const payload = { event: 'issue_created', data: { id: 42 } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);

      const result = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.executionId).toBeDefined();

      expect(restateClient.invocations.length).toBe(1);
      const invocation = restateClient.invocations[0];
      expect(invocation.input.workflowId).toBe(workflowId);
      expect(invocation.input.tenantId).toBe(primary.tenantId);
      expect(invocation.input.projectId).toBe(primary.projectId);
      expect(invocation.input.triggerType).toBe('event');
      expect(invocation.input.triggerPayload).toMatchObject(payload);
    });

    test('3. GET verifies lastFiredAt was updated', async () => {
      const response = await requestJson<{
        success: boolean;
        data: Record<string, unknown>;
      }>(harness, `/api/projects/${primary.projectId}/triggers/${triggerId}`, {
        method: 'GET',
        headers: authHeaders(primary.token),
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.lastFiredAt).toBeDefined();
      expect(response.body.data.consecutiveErrors).toBe(0);
    });

    test('4. POST /:id/pause changes status to paused', async () => {
      const response = await requestJson<{
        success: boolean;
        data: Record<string, unknown>;
      }>(harness, `/api/projects/${primary.projectId}/triggers/${triggerId}/pause`, {
        method: 'POST',
        headers: authHeaders(primary.token),
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('paused');
    });

    test('5. Webhook while paused returns 404 (handler filters by active status)', async () => {
      restateClient.clear();

      const payload = { event: 'should_be_dropped' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);

      const result = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
      });

      // handleWebhook filters by status: 'active', paused registration returns 404
      expect(result.status).toBe(404);
      expect(result.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Not found' });
      // No new Restate invocation
      expect(restateClient.invocations.length).toBe(0);
    });

    test('6. POST /:id/resume changes status back to active', async () => {
      const response = await requestJson<{
        success: boolean;
        data: Record<string, unknown>;
      }>(harness, `/api/projects/${primary.projectId}/triggers/${triggerId}/resume`, {
        method: 'POST',
        headers: authHeaders(primary.token),
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('active');
    });

    test('7. Webhook after resume dispatches successfully', async () => {
      restateClient.clear();

      const payload = { event: 'resumed_event', data: { resumed: true } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);

      const result = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
      });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(restateClient.invocations.length).toBe(1);
    });

    test('8. DELETE removes trigger from DB', async () => {
      const response = await requestJson<{
        success: boolean;
        data: Record<string, unknown>;
      }>(harness, `/api/projects/${primary.projectId}/triggers/${triggerId}`, {
        method: 'DELETE',
        headers: authHeaders(primary.token),
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.deleted).toBe(true);
    });

    test('9. Webhook after delete returns 404', async () => {
      restateClient.clear();

      const payload = { event: 'post_delete' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);

      const result = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
      });

      expect(result.status).toBe(404);
      expect(result.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Not found' });
      expect(restateClient.invocations.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // E2E-8: Webhook Security
  // ─────────────────────────────────────────────────────────────────────────

  describe('E2E-8: Webhook Security', () => {
    let triggerId: string;
    let webhookSecret: string;
    let connectorName: string;

    beforeAll(async () => {
      const response = await createTriggerViaApi({
        workflowId: `wf-security-${crypto.randomUUID().slice(0, 8)}`,
      });
      expect(response.status).toBe(201);
      triggerId = response.body.data._id as string;
      webhookSecret = response.body._webhookSecretPlain;
      connectorName = response.body.data.connectorName as string;
    });

    test('1. Invalid HMAC signature returns 401', async () => {
      const payload = { event: 'test_invalid_hmac' };
      const result = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      });

      expect(result.status).toBe(401);
      expect(result.body.error).toMatchObject({ code: 'INVALID_SIGNATURE' });
      expect(restateClient.invocations.length).toBe(0);
    });

    test('2. Missing signature when secret exists returns 401', async () => {
      const payload = { event: 'test_missing_sig' };
      const result = await sendWebhook(connectorName, triggerId, payload);
      // No x-signature-256 header

      expect(result.status).toBe(401);
      expect(result.body.error).toMatchObject({ code: 'MISSING_SIGNATURE' });
      expect(restateClient.invocations.length).toBe(0);
    });

    test('3. Stale timestamp returns 401 (replay protection)', async () => {
      const payload = { event: 'test_stale_timestamp' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);
      // 10 minutes ago — beyond the 5-minute replay tolerance
      const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const result = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-timestamp': staleTimestamp,
      });

      expect(result.status).toBe(401);
      expect(result.body.error).toMatchObject({ code: 'REPLAY_DETECTED' });
      expect(restateClient.invocations.length).toBe(0);
    });

    test('4. Duplicate event ID returns 200 with deduplicated: true', async () => {
      const eventId = `evt-dedup-${crypto.randomUUID().slice(0, 8)}`;
      const payload = { event: 'test_dedup' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);

      // First request: processed normally
      const first = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-id': eventId,
      });
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(first.body.deduplicated).toBeUndefined();
      expect(restateClient.invocations.length).toBe(1);

      // Second request with same event ID: deduplicated
      const second = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-id': eventId,
      });
      expect(second.status).toBe(200);
      expect(second.body.deduplicated).toBe(true);
      // No additional invocation
      expect(restateClient.invocations.length).toBe(1);
    });

    test('5. After dedup TTL expires, event is processed again', async () => {
      restateClient.clear();

      const eventId = `evt-ttl-${crypto.randomUUID().slice(0, 8)}`;
      const payload = { event: 'test_ttl_expiry' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const hmac = computeHmac(webhookSecret, rawBody);

      // First request
      const first = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-id': eventId,
      });
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(restateClient.invocations.length).toBe(1);

      // Clear the in-memory redis to simulate TTL expiry
      redis.clear();

      // Same event ID but TTL expired: should be processed again
      const second = await sendWebhook(connectorName, triggerId, payload, {
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-id': eventId,
      });
      expect(second.status).toBe(200);
      expect(second.body.ok).toBe(true);
      expect(second.body.deduplicated).toBeUndefined();
      expect(restateClient.invocations.length).toBe(2);
    });
  });
});
