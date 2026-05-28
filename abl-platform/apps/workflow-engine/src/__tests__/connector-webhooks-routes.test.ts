/**
 * Connector Webhook Routes — Express wrapper tests
 *
 * The underlying handleWebhook() logic (HMAC verify, dedup, Restate dispatch,
 * auto-pause) is covered exhaustively by the integration suite in
 * packages/connectors/src/__tests__/integration/webhook-dispatch.integration.test.ts.
 *
 * This suite focuses on the Express adapter:
 *   - rawBody is captured by the verify() hook and forwarded into WebhookRequest.rawBody
 *   - route params thread into WebhookRequest.params
 *   - status codes and JSON bodies returned by handleWebhook are forwarded 1:1
 *   - the route returns 500 on unexpected throws (defensive — handleWebhook
 *     shouldn't throw, but if it does we don't want to leak stack traces)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { ConnectorRegistry } from '@agent-platform/connectors';
import type { TriggerRegistration, WorkflowTriggerInput } from '@agent-platform/connectors';
import {
  createConnectorWebhookRouter,
  type ConnectorWebhookRouteDeps,
} from '../routes/connector-webhooks.js';

const CONNECTOR_NAME = 'route-test-connector';
const TRIGGER_NAME = 'on_event';
const TENANT_ID = 'tenant-route-1';
const PROJECT_ID = 'project-route-1';
const WORKFLOW_ID = 'workflow-route-1';
const REGISTRATION_ID = 'reg-route-1';

/** Minimal inline connector with a verify() that HMAC-checks the raw body. */
function makeRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register({
    name: CONNECTOR_NAME,
    displayName: 'Route Test Connector',
    auth: { type: 'none' as const },
    actions: [],
    triggers: [
      {
        name: TRIGGER_NAME,
        displayName: 'On Event',
        description: 'Webhook trigger for route tests',
        triggerType: 'webhook' as const,
        props: [],
        outputSchema: { type: 'object' },
        async run() {
          return { items: [] };
        },
        async verify(ctx: {
          headers: Record<string, string>;
          rawBody: Buffer;
          auth: { secret?: string };
        }): Promise<boolean> {
          // No secret configured → skip verify (handler only runs verify
          // when rawBody is present; absence of a secret means "unsigned",
          // which is valid for tests that exercise other code paths).
          if (!ctx.auth.secret) return true;
          const sig = ctx.headers['x-signature-256']?.replace(/^sha256=/, '') ?? '';
          const expected = crypto
            .createHmac('sha256', ctx.auth.secret)
            .update(ctx.rawBody)
            .digest('hex');
          try {
            const a = Buffer.from(sig, 'hex');
            const b = Buffer.from(expected, 'hex');
            return a.length === b.length && crypto.timingSafeEqual(a, b);
          } catch {
            return false;
          }
        },
      } as any,
    ],
  } as any);
  return registry;
}

function makeRegistration(overrides: Partial<TriggerRegistration> = {}): TriggerRegistration {
  return {
    _id: REGISTRATION_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workflowId: WORKFLOW_ID,
    connectorName: CONNECTOR_NAME,
    triggerName: TRIGGER_NAME,
    connectionId: 'conn-route-1',
    triggerType: 'webhook',
    status: 'active',
    config: {},
    consecutiveErrors: 0,
    ...overrides,
  } as TriggerRegistration;
}

function makeDeps(overrides: Partial<ConnectorWebhookRouteDeps> = {}): ConnectorWebhookRouteDeps {
  const findOne = vi.fn().mockResolvedValue(makeRegistration());
  const findOneAndUpdate = vi.fn().mockResolvedValue(null);
  return {
    registry: makeRegistry(),
    registrationModel: { findOne, findOneAndUpdate } as any,
    redis: {
      set: vi.fn().mockResolvedValue('OK'),
    } as any,
    restateClient: {
      startWorkflow: vi
        .fn<(executionId: string, input: WorkflowTriggerInput) => Promise<void>>()
        .mockResolvedValue(undefined),
    } as any,
    decryptSecret: vi.fn().mockResolvedValue('plaintext-secret'),
    ...overrides,
  };
}

/** Mirror the production captureRawBody hook on express.json() */
function createApp(deps: ConnectorWebhookRouteDeps): express.Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    }),
  );
  app.use('/api/v1/webhooks', createConnectorWebhookRouter(deps));
  return app;
}

/** Sign a payload the test connector's verify() accepts. */
function signPayload(body: unknown, secret: string): { signature: string; rawBody: string } {
  const rawBody = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret).update(Buffer.from(rawBody)).digest('hex');
  return { signature: `sha256=${hmac}`, rawBody };
}

describe('Connector Webhook Routes — Express adapter', () => {
  let deps: ConnectorWebhookRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  it('dispatches a signed webhook to Restate and forwards 200/executionId', async () => {
    // Registration has a webhookSecret so signature verification runs.
    (deps.registrationModel.findOne as any) = vi
      .fn()
      .mockResolvedValue(makeRegistration({ webhookSecret: 'encrypted-secret' }));
    app = createApp(deps);

    const body = { event: 'message.created', data: { id: 'msg-1' } };
    const { signature } = signPayload(body, 'plaintext-secret');

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/${REGISTRATION_ID}`)
      .set('x-signature-256', signature)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.executionId).toEqual(expect.any(String));

    expect(deps.restateClient.startWorkflow).toHaveBeenCalledOnce();
    const [, input] = (deps.restateClient.startWorkflow as any).mock.calls[0];
    expect(input).toMatchObject({
      workflowId: WORKFLOW_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      triggerType: 'event',
      triggerPayload: body,
      triggerMetadata: expect.objectContaining({
        connectorName: CONNECTOR_NAME,
        triggerName: TRIGGER_NAME,
        registrationId: REGISTRATION_ID,
      }),
    });
  });

  it('returns 401 when signature is invalid (adapter forwards handler status)', async () => {
    (deps.registrationModel.findOne as any) = vi
      .fn()
      .mockResolvedValue(makeRegistration({ webhookSecret: 'encrypted-secret' }));
    app = createApp(deps);

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/${REGISTRATION_ID}`)
      .set('x-signature-256', 'sha256=deadbeef')
      .send({ event: 'fake' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
  });

  it('returns 404 when registration not found', async () => {
    (deps.registrationModel.findOne as any) = vi.fn().mockResolvedValue(null);
    app = createApp(deps);

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/missing-reg`)
      .send({ event: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('threads connectorName and registrationId from URL into registration lookup', async () => {
    // No webhookSecret on the registration — signature verification is skipped,
    // so we only care that params flow through to the lookup filter.
    const findOne = vi.fn().mockResolvedValue(makeRegistration());
    deps = makeDeps({
      registrationModel: { findOne, findOneAndUpdate: vi.fn() } as any,
    });
    app = createApp(deps);

    await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/${REGISTRATION_ID}`)
      .send({ event: 'x' });

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: REGISTRATION_ID,
        connectorName: CONNECTOR_NAME,
        status: 'active',
      }),
    );
  });

  it('deduplicates by x-webhook-id header via redis NX', async () => {
    // First call succeeds, second is deduped (redis.set returns null for NX miss)
    const redisSet = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    deps = makeDeps({ redis: { set: redisSet } as any });
    app = createApp(deps);

    const body = { event: 'duplicate-check' };
    await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/${REGISTRATION_ID}`)
      .set('x-webhook-id', 'evt-123')
      .send(body);
    const res2 = await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/${REGISTRATION_ID}`)
      .set('x-webhook-id', 'evt-123')
      .send(body);

    expect(res2.status).toBe(200);
    expect(res2.body.deduplicated).toBe(true);
    // Only the first call reached Restate
    expect((deps.restateClient.startWorkflow as any).mock.calls.length).toBe(1);
  });

  it('returns 500 when the underlying handler throws unexpectedly', async () => {
    // Force handler to throw by making registrationModel.findOne reject.
    const findOne = vi.fn().mockRejectedValue(new Error('db exploded'));
    deps = makeDeps({
      registrationModel: { findOne, findOneAndUpdate: vi.fn() } as any,
    });
    app = createApp(deps);

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONNECTOR_NAME}/${REGISTRATION_ID}`)
      .send({ event: 'x' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
