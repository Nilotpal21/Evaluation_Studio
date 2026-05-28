import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  handleWebhook,
  type WebhookHandlerDeps,
  type WebhookRequest,
} from '../triggers/webhook-handler.js';
import { ConnectorRegistry } from '../registry.js';
import type { TriggerRegistration } from '../triggers/types.js';

function makeRegistration(overrides: Partial<TriggerRegistration> = {}): TriggerRegistration {
  return {
    _id: 'reg-1',
    tenantId: 't1',
    projectId: 'p1',
    workflowId: 'wf-1',
    connectorName: 'slack',
    triggerName: 'new_message',
    connectionId: 'conn-1',
    triggerType: 'webhook',
    status: 'active',
    config: {},
    consecutiveErrors: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WebhookHandlerDeps> = {}): WebhookHandlerDeps {
  const registry = new ConnectorRegistry();
  registry.register({
    name: 'slack',
    displayName: 'Slack',
    version: '1.0.0',
    description: 'Slack connector',
    auth: { type: 'oauth2' },
    triggers: [
      {
        name: 'new_message',
        displayName: 'New Message',
        description: 'Triggers on new message',
        triggerType: 'webhook',
        props: [],
        onEnable: vi.fn().mockResolvedValue(undefined),
        onDisable: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue([]),
        verify: vi.fn().mockResolvedValue(true),
      },
    ],
    actions: [],
  });

  return {
    registry,
    registrationModel: {
      findOne: vi.fn().mockResolvedValue(makeRegistration()),
      findOneAndUpdate: vi.fn().mockResolvedValue(makeRegistration()),
    },
    redis: {
      set: vi.fn().mockResolvedValue('OK'),
    },
    restateClient: {
      startWorkflow: vi.fn().mockResolvedValue(undefined),
    },
    decryptSecret: vi.fn().mockResolvedValue('my-secret'),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<WebhookRequest> = {}): WebhookRequest {
  return {
    params: { connectorName: 'slack', registrationId: 'reg-1' },
    headers: { 'content-type': 'application/json' },
    body: { text: 'hello' },
    rawBody: Buffer.from(JSON.stringify({ text: 'hello' })),
    ...overrides,
  };
}

describe('handleWebhook', () => {
  it('returns 404 when registration not found', async () => {
    const deps = makeDeps({
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(null),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await handleWebhook(makeRequest(), deps);
    expect(result.status).toBe(404);
    expect(result.body.error).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
  });

  it('invokes Restate workflow on valid webhook', async () => {
    const deps = makeDeps();
    const result = await handleWebhook(makeRequest(), deps);

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.executionId).toBeDefined();
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        tenantId: 't1',
        projectId: 'p1',
        triggerType: 'event',
        triggerPayload: { text: 'hello' },
      }),
    );
  });

  it('resets error counter on successful webhook', async () => {
    const deps = makeDeps();
    await handleWebhook(makeRequest(), deps);

    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1' },
      expect.objectContaining({
        $set: expect.objectContaining({ consecutiveErrors: 0 }),
      }),
    );
  });

  it('returns 401 when connector verify() fails', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      name: 'github',
      displayName: 'GitHub',
      version: '1.0.0',
      description: 'GitHub connector',
      auth: { type: 'oauth2' },
      triggers: [
        {
          name: 'push',
          displayName: 'Push',
          description: 'Push event',
          triggerType: 'webhook',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([]),
          verify: vi.fn().mockResolvedValue(false),
        },
      ],
      actions: [],
    });

    const deps = makeDeps({
      registry,
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(
          makeRegistration({
            connectorName: 'github',
            triggerName: 'push',
            webhookSecret: 'encrypted-secret',
          }),
        ),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
    });

    const req = makeRequest({
      params: { connectorName: 'github', registrationId: 'reg-1' },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({ code: 'INVALID_SIGNATURE', message: 'Invalid signature' });
  });

  it('validates generic HMAC-SHA256 signature when connector has no verify()', async () => {
    const secret = 'test-secret';
    const body = JSON.stringify({ event: 'test' });
    const rawBody = Buffer.from(body);
    const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const deps = makeDeps({
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(makeRegistration({ webhookSecret: 'encrypted' })),
        findOneAndUpdate: vi.fn().mockResolvedValue(makeRegistration()),
      },
      decryptSecret: vi.fn().mockResolvedValue(secret),
    });

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-signature-256': `sha256=${hmac}`,
      },
      body: JSON.parse(body),
      rawBody,
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(200);
  });

  it('returns 401 on invalid HMAC signature', async () => {
    // Use a connector without verify() so the generic HMAC path is exercised
    const noVerifyRegistry = new ConnectorRegistry();
    noVerifyRegistry.register({
      name: 'slack',
      displayName: 'Slack',
      version: '1.0.0',
      description: 'Slack connector',
      auth: { type: 'oauth2' },
      triggers: [
        {
          name: 'new_message',
          displayName: 'New Message',
          description: 'Triggers on new message',
          triggerType: 'webhook',
          props: [],
          onEnable: vi.fn().mockResolvedValue(undefined),
          onDisable: vi.fn().mockResolvedValue(undefined),
          run: vi.fn().mockResolvedValue([]),
        },
      ],
      actions: [],
    });

    const deps = makeDeps({
      registry: noVerifyRegistry,
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(makeRegistration({ webhookSecret: 'encrypted' })),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
      },
      decryptSecret: vi.fn().mockResolvedValue('correct-secret'),
    });

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(401);
  });

  it('rejects replayed events via timestamp check', async () => {
    const deps = makeDeps();
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': oldTimestamp,
      },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(401);
    expect(result.body.error).toEqual({ code: 'REPLAY_DETECTED', message: 'Replay detected' });
  });

  it('deduplicates by event ID', async () => {
    const deps = makeDeps({
      redis: {
        set: vi.fn().mockResolvedValue(null), // NX returns null = already exists
      },
    });

    const req = makeRequest({
      headers: {
        'content-type': 'application/json',
        'x-webhook-id': 'evt-123',
      },
    });

    const result = await handleWebhook(req, deps);
    expect(result.status).toBe(200);
    expect(result.body.deduplicated).toBe(true);
    expect(deps.restateClient.startWorkflow).not.toHaveBeenCalled();
  });

  it('returns 503 when Restate is unavailable and tracks errors', async () => {
    const deps = makeDeps({
      restateClient: {
        startWorkflow: vi.fn().mockRejectedValue(new Error('Connection refused')),
      },
    });

    const result = await handleWebhook(makeRequest(), deps);
    expect(result.status).toBe(503);
    expect(result.body.error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Workflow engine unavailable',
    });

    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't1' },
      expect.objectContaining({
        $inc: { consecutiveErrors: 1 },
      }),
      { new: true },
    );
  });

  it('auto-pauses trigger after reaching error threshold', async () => {
    const deps = makeDeps({
      restateClient: {
        startWorkflow: vi.fn().mockRejectedValue(new Error('Connection refused')),
      },
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(makeRegistration()),
        findOneAndUpdate: vi
          .fn()
          .mockResolvedValueOnce(makeRegistration({ consecutiveErrors: 10 })) // First call: inc errors
          .mockResolvedValue(null), // Second call: set status to error
      },
    });

    await handleWebhook(makeRequest(), deps);

    // Should have been called twice: once to increment, once to set error status
    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(deps.registrationModel.findOneAndUpdate).toHaveBeenLastCalledWith(
      { _id: 'reg-1', tenantId: 't1' },
      { $set: { status: 'error' } },
    );
  });

  it('passes workflowVersionId to startWorkflow when present on registration', async () => {
    const deps = makeDeps({
      registrationModel: {
        findOne: vi.fn().mockResolvedValue(makeRegistration({ workflowVersionId: 'ver-1' })),
        findOneAndUpdate: vi.fn().mockResolvedValue(makeRegistration()),
      },
    });

    const result = await handleWebhook(makeRequest(), deps);

    expect(result.status).toBe(200);
    expect(deps.restateClient.startWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workflowId: 'wf-1',
        workflowVersionId: 'ver-1',
      }),
    );
  });

  it('omits workflowVersionId from startWorkflow when absent on registration', async () => {
    const deps = makeDeps();

    await handleWebhook(makeRequest(), deps);

    const call = (deps.restateClient.startWorkflow as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).not.toHaveProperty('workflowVersionId');
  });
});
