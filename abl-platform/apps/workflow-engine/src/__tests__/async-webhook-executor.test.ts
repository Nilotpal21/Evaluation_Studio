import { describe, it, expect } from 'vitest';
import {
  buildAsyncWebhookRequest,
  getAsyncWebhookTimeout,
  type AsyncWebhookStep,
  type CallbackUrlBuilder,
} from '../executors/async-webhook-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

const ctx: WorkflowContextData = {
  trigger: {
    type: 'webhook',
    payload: { orderId: 'ORD-123', webhookSecret: 'sec-abc' },
  },
  workflow: { id: 'wf-1', name: 'async-flow', executionId: 'exec-42' },
  tenant: { tenantId: 't1', projectId: 'p1' },
  steps: {},
  vars: {},
};

const mockCallbackBuilder: CallbackUrlBuilder = {
  buildCallbackUrl: (executionId: string, stepId: string) =>
    `https://platform.example.com/api/workflows/callbacks/${executionId}/${stepId}`,
};

describe('buildAsyncWebhookRequest', () => {
  it('builds request with resolved URL and injected callback URL', () => {
    const step: AsyncWebhookStep = {
      id: 'webhook-1',
      type: 'async_webhook',
      url: 'https://external.example.com/process/{{trigger.payload.orderId}}',
      body: {
        order: '{{trigger.payload.orderId}}',
      },
    };

    const request = buildAsyncWebhookRequest(step, ctx, mockCallbackBuilder);

    expect(request.url).toBe('https://external.example.com/process/ORD-123');
    expect(request.method).toBe('POST');
    expect(request.body.order).toBe('ORD-123');
    expect(request.body.callbackUrl).toBe(
      'https://platform.example.com/api/workflows/callbacks/exec-42/webhook-1',
    );
    expect(request.callbackId).toBe('exec-42:webhook-1');
  });

  it('uses custom callback URL field', () => {
    const step: AsyncWebhookStep = {
      id: 'webhook-2',
      type: 'async_webhook',
      url: 'https://api.example.com/hook',
      callbackUrlField: 'responseUrl',
    };

    const request = buildAsyncWebhookRequest(step, ctx, mockCallbackBuilder);

    expect(request.body.responseUrl).toBeDefined();
    expect(request.body.callbackUrl).toBeUndefined();
  });

  it('resolves headers from expressions', () => {
    const step: AsyncWebhookStep = {
      id: 'webhook-3',
      type: 'async_webhook',
      url: 'https://api.example.com/hook',
      headers: {
        'X-Webhook-Secret': '{{trigger.payload.webhookSecret}}',
        'Content-Type': 'application/json',
      },
    };

    const request = buildAsyncWebhookRequest(step, ctx, mockCallbackBuilder);

    expect(request.headers['X-Webhook-Secret']).toBe('sec-abc');
    expect(request.headers['Content-Type']).toBe('application/json');
  });

  it('uses specified HTTP method', () => {
    const step: AsyncWebhookStep = {
      id: 'webhook-4',
      type: 'async_webhook',
      url: 'https://api.example.com/hook',
      method: 'PUT',
    };

    const request = buildAsyncWebhookRequest(step, ctx, mockCallbackBuilder);
    expect(request.method).toBe('PUT');
  });
});

describe('getAsyncWebhookTimeout', () => {
  it('returns custom timeout when specified', () => {
    const step: AsyncWebhookStep = {
      id: 'w1',
      type: 'async_webhook',
      url: 'https://example.com',
      timeout: 60_000,
    };
    expect(getAsyncWebhookTimeout(step)).toBe(60_000);
  });

  it('returns default 24h timeout when not specified', () => {
    const step: AsyncWebhookStep = {
      id: 'w2',
      type: 'async_webhook',
      url: 'https://example.com',
    };
    expect(getAsyncWebhookTimeout(step)).toBe(24 * 60 * 60 * 1000);
  });
});
