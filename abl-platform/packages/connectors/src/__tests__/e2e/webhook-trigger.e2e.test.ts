/**
 * E2E Test: Webhook Trigger End-to-End
 *
 * Tests the webhook handler with real cryptographic HMAC verification,
 * real Redis deduplication (when available), real timestamp validation,
 * and real auto-pause behavior. Uses in-memory implementations where
 * external services (Redis, Restate) are not available.
 *
 * No mocks of codebase components. External service interfaces (Redis, Restate)
 * are implemented as lightweight in-memory doubles since they are external
 * infrastructure, not part of this codebase.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  handleWebhook,
  type WebhookHandlerDeps,
  type WebhookRequest,
} from '../../triggers/webhook-handler.js';
import { ConnectorRegistry } from '../../registry.js';
import type { Connector, ConnectorTrigger, WebhookVerifyContext } from '../../types.js';
import type { TriggerRegistration, TriggerRegistrationModel } from '../../triggers/types.js';
import { TRIGGER_AUTO_PAUSE_THRESHOLD } from '../../triggers/constants.js';

// ─── In-Memory Redis (external service double) ─────────────────────────────

/**
 * Minimal Redis-like implementation for deduplication.
 * This is an external infrastructure double (Redis is not part of our codebase).
 */
class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(
    key: string,
    value: string,
    mode: string,
    duration: number,
    flag: string,
  ): Promise<string | null> {
    // Clean up expired keys
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }

    if (flag === 'NX' && this.store.has(key)) {
      return null; // Key already exists
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

// ─── In-Memory Registration Store ───────────────────────────────────────────

/**
 * In-memory TriggerRegistrationModel backed by a plain array.
 * Implements real query logic (filter matching, $set, $inc) so the
 * webhook handler exercises its actual code paths.
 */
class InMemoryRegistrationModel implements TriggerRegistrationModel {
  private registrations: TriggerRegistration[] = [];

  seed(reg: TriggerRegistration): void {
    this.registrations.push({ ...reg });
  }

  async findOne(filter: Record<string, unknown>): Promise<TriggerRegistration | null> {
    return (
      this.registrations.find((r) => {
        for (const [key, value] of Object.entries(filter)) {
          if ((r as Record<string, unknown>)[key] !== value) return false;
        }
        return true;
      }) ?? null
    );
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<TriggerRegistration | null> {
    const reg = this.registrations.find((r) => {
      for (const [key, value] of Object.entries(filter)) {
        if ((r as Record<string, unknown>)[key] !== value) return false;
      }
      return true;
    });

    if (!reg) return null;

    // Apply $set
    const $set = update.$set as Record<string, unknown> | undefined;
    if ($set) {
      for (const [key, value] of Object.entries($set)) {
        (reg as Record<string, unknown>)[key] = value;
      }
    }

    // Apply $inc
    const $inc = update.$inc as Record<string, number> | undefined;
    if ($inc) {
      for (const [key, value] of Object.entries($inc)) {
        const current = (reg as Record<string, unknown>)[key];
        (reg as Record<string, unknown>)[key] = (typeof current === 'number' ? current : 0) + value;
      }
    }

    return { ...reg };
  }

  getAll(): TriggerRegistration[] {
    return this.registrations.map((r) => ({ ...r }));
  }

  clear(): void {
    this.registrations = [];
  }
}

// ─── Restate Ingress Double ─────────────────────────────────────────────────

/**
 * Tracks workflow invocations for assertion.
 * Restate is external infrastructure.
 */
class InMemoryRestateClient {
  readonly invocations: Array<{ executionId: string; input: Record<string, unknown> }> = [];
  private shouldFail = false;

  setFailing(fail: boolean): void {
    this.shouldFail = fail;
  }

  async startWorkflow(executionId: string, input: Record<string, unknown>): Promise<void> {
    if (this.shouldFail) {
      throw new Error('Restate ingress unavailable');
    }
    this.invocations.push({ executionId, input });
  }
}

// ─── Test Connector with Verify ─────────────────────────────────────────────

function makeWebhookConnector(
  verifyFn?: (ctx: WebhookVerifyContext) => Promise<boolean>,
): Connector {
  const trigger: ConnectorTrigger = {
    name: 'incoming_webhook',
    displayName: 'Incoming Webhook',
    description: 'Fires on incoming webhook',
    triggerType: 'webhook',
    props: [],
    onEnable: async () => {},
    onDisable: async () => {},
    run: async () => [],
  };

  if (verifyFn) {
    trigger.verify = verifyFn;
  }

  return {
    name: 'test-webhook-connector',
    displayName: 'Test Webhook Connector',
    version: '1.0.0',
    description: 'Connector for webhook E2E testing',
    auth: { type: 'api_key' },
    triggers: [trigger],
    actions: [],
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret-key-for-hmac';

function makeRegistration(overrides: Partial<TriggerRegistration> = {}): TriggerRegistration {
  return {
    _id: 'reg-e2e-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    workflowId: 'wf-e2e-1',
    connectorName: 'test-webhook-connector',
    triggerName: 'incoming_webhook',
    connectionId: 'conn-1',
    triggerType: 'webhook',
    status: 'active',
    config: {},
    webhookSecret: 'encrypted-secret',
    consecutiveErrors: 0,
    ...overrides,
  };
}

function computeHmac(secret: string, rawBody: Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makeRequest(overrides: Partial<WebhookRequest> = {}): WebhookRequest {
  const body = { event: 'test', data: { message: 'hello' } };
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    params: { connectorName: 'test-webhook-connector', registrationId: 'reg-e2e-1' },
    headers: { 'content-type': 'application/json' },
    body,
    rawBody,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E: Webhook Trigger', () => {
  let redis: InMemoryRedis;
  let registrationModel: InMemoryRegistrationModel;
  let restateClient: InMemoryRestateClient;

  beforeEach(() => {
    redis = new InMemoryRedis();
    registrationModel = new InMemoryRegistrationModel();
    restateClient = new InMemoryRestateClient();
  });

  function createDeps(connector?: Connector): WebhookHandlerDeps {
    const registry = new ConnectorRegistry();
    registry.register(connector ?? makeWebhookConnector());

    return {
      registry,
      registrationModel,
      redis,
      restateClient,
      decryptSecret: async (_encrypted: string, _tenantId: string) => WEBHOOK_SECRET,
    };
  }

  // ── 1. Valid webhook with correct HMAC → 200 + workflow invocation ─────

  it('processes valid webhook with correct HMAC and invokes workflow', async () => {
    // Use a connector WITHOUT verify() so generic HMAC path is exercised
    const connector = makeWebhookConnector();
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const body = { event: 'push', repo: 'myrepo' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = computeHmac(WEBHOOK_SECRET, rawBody);

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-timestamp': new Date().toISOString(),
        'x-webhook-id': 'evt-unique-1',
      },
      body,
      rawBody,
    });

    const result = await handleWebhook(req, deps);

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.executionId).toBeDefined();
    expect(restateClient.invocations.length).toBe(1);

    const invocation = restateClient.invocations[0];
    expect(invocation.input).toMatchObject({
      workflowId: 'wf-e2e-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      triggerType: 'event',
    });
  });

  // ── 2. Connector-specific verify function ─────────────────────────────

  it('uses connector-specific verify when available', async () => {
    const verifyFn = async (ctx: WebhookVerifyContext): Promise<boolean> => {
      // Custom verification: check a custom header
      const sig = ctx.headers['x-custom-signature'];
      if (!sig) return false;
      const expected = crypto
        .createHmac('sha256', ctx.auth.secret as string)
        .update(ctx.rawBody)
        .digest('hex');
      return sig === expected;
    };

    const connector = makeWebhookConnector(verifyFn);
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const body = { action: 'created' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const customSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-custom-signature': customSig,
      },
      body,
      rawBody,
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  // ── 3. Replay with same event ID → 200 + deduplicated ─────────────────

  it('deduplicates replay with same event ID', async () => {
    const connector = makeWebhookConnector();
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const body = { event: 'test' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const hmac = computeHmac(WEBHOOK_SECRET, rawBody);
    const eventId = 'evt-dedup-test-001';

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-signature-256': `sha256=${hmac}`,
        'x-webhook-id': eventId,
      },
      body,
      rawBody,
    });

    // First request: should succeed
    const first = await handleWebhook(req, deps);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.deduplicated).toBeUndefined();
    expect(restateClient.invocations.length).toBe(1);

    // Second request with same event ID: should be deduplicated
    const second = await handleWebhook(req, deps);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    // No additional workflow invocation
    expect(restateClient.invocations.length).toBe(1);
  });

  // ── 4. Invalid HMAC → 401 ─────────────────────────────────────────────

  it('rejects webhook with invalid HMAC signature', async () => {
    const connector = makeWebhookConnector();
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const body = { event: 'test' };
    const rawBody = Buffer.from(JSON.stringify(body));

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body,
      rawBody,
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({ code: 'INVALID_SIGNATURE', message: 'Invalid signature' });
    // No workflow invocation
    expect(restateClient.invocations.length).toBe(0);
  });

  // ── 5. Missing HMAC when secret is configured → 401 ───────────────────

  it('rejects webhook with missing signature when secret is configured', async () => {
    const connector = makeWebhookConnector();
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        // No signature header
      },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({ code: 'MISSING_SIGNATURE', message: 'Missing signature' });
    expect(restateClient.invocations.length).toBe(0);
  });

  // ── 6. Stale timestamp → 401 ──────────────────────────────────────────

  it('rejects webhook with stale timestamp (replay protection)', async () => {
    // Use connector WITH verify that always passes, so we get past HMAC to timestamp check
    const connector = makeWebhookConnector(async () => true);
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': staleTimestamp,
      },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({ code: 'REPLAY_DETECTED', message: 'Replay detected' });
    expect(restateClient.invocations.length).toBe(0);
  });

  // ── 7. Consecutive failures → auto-pause ──────────────────────────────

  it('auto-pauses trigger after consecutive failures reaching threshold', async () => {
    const connector = makeWebhookConnector(async () => true);
    // Seed with errors just below threshold
    registrationModel.seed(
      makeRegistration({ consecutiveErrors: TRIGGER_AUTO_PAUSE_THRESHOLD - 1 }),
    );
    const deps = createDeps(connector);

    // Make Restate fail
    restateClient.setFailing(true);

    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
    });

    const result = await handleWebhook(req, deps);

    // Should return 503 (workflow engine unavailable)
    expect(result.status).toBe(503);
    expect(result.body.error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Workflow engine unavailable',
    });

    // Verify the registration was updated to error status
    const regs = registrationModel.getAll();
    const reg = regs.find((r) => r._id === 'reg-e2e-1');
    expect(reg).toBeDefined();
    expect(reg!.status).toBe('error');
    expect(reg!.consecutiveErrors).toBe(TRIGGER_AUTO_PAUSE_THRESHOLD);
  });

  // ── 8. Successful webhook resets error counter ─────────────────────────

  it('resets consecutive error counter on successful webhook', async () => {
    const connector = makeWebhookConnector(async () => true);
    registrationModel.seed(makeRegistration({ consecutiveErrors: 5 }));
    const deps = createDeps(connector);

    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(200);

    // Check that error counter was reset
    const regs = registrationModel.getAll();
    const reg = regs.find((r) => r._id === 'reg-e2e-1');
    expect(reg).toBeDefined();
    expect(reg!.consecutiveErrors).toBe(0);
  });

  // ── 9. Unknown registration → 404 ─────────────────────────────────────

  it('returns 404 for unknown registration', async () => {
    const connector = makeWebhookConnector();
    // Don't seed any registrations
    const deps = createDeps(connector);

    const req = makeRequest();
    const result = await handleWebhook(req, deps);

    expect(result.status).toBe(404);
    expect(result.body.error).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
  });

  // ── 10. Connector-specific verify rejects → 401 ───────────────────────

  it('returns 401 when connector-specific verify returns false', async () => {
    const connector = makeWebhookConnector(async () => false);
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const req = makeRequest();
    const result = await handleWebhook(req, deps);

    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({ code: 'INVALID_SIGNATURE', message: 'Invalid signature' });
  });

  // ── 11. Workflow invocation payload correctness ────────────────────────

  it('passes correct trigger metadata to workflow invocation', async () => {
    const connector = makeWebhookConnector(async () => true);
    registrationModel.seed(makeRegistration());
    const deps = createDeps(connector);

    const body = { channel: 'general', text: 'Hello world' };
    const rawBody = Buffer.from(JSON.stringify(body));

    const req = makeRequest({
      headers: { 'content-type': 'application/json' },
      body,
      rawBody,
    });

    await handleWebhook(req, deps);

    expect(restateClient.invocations.length).toBe(1);
    const inv = restateClient.invocations[0];
    expect(inv.input).toMatchObject({
      workflowId: 'wf-e2e-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      triggerType: 'event',
      triggerPayload: { channel: 'general', text: 'Hello world' },
      triggerMetadata: {
        connectorName: 'test-webhook-connector',
        triggerName: 'incoming_webhook',
        registrationId: 'reg-e2e-1',
      },
    });
  });
});
