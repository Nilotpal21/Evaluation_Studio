import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PushNotificationDeliveryService } from '../application/push-notification-delivery.js';
import type { EndpointValidator, A2ATracingPort } from '../domain/ports.js';

describe('PushNotificationDeliveryService', () => {
  let validator: EndpointValidator;
  let tracing: A2ATracingPort;
  let service: PushNotificationDeliveryService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    validator = { validate: vi.fn() };
    tracing = { traceOutbound: vi.fn(), traceInbound: vi.fn() };
    service = new PushNotificationDeliveryService(validator, tracing);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs JSON-RPC payload to push notification URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await service.deliverTaskUpdate({ url: 'https://example.com/push' }, 'task-1', 'completed', {
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'text', text: 'Done' }],
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/push',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"tasks/pushNotification"'),
      }),
    );
  });

  it('includes Bearer token in Authorization header when configured', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await service.deliverTaskUpdate(
      { url: 'https://example.com/push', token: 'my-token' },
      'task-1',
      'completed',
    );

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.headers['Authorization']).toBe('Bearer my-token');
  });

  it('validates URL against SSRF rules', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await service.deliverTaskUpdate({ url: 'https://example.com/push' }, 'task-1', 'completed');

    expect(validator.validate).toHaveBeenCalledWith('https://example.com/push');
  });

  it('traces successful delivery', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await service.deliverTaskUpdate({ url: 'https://example.com/push' }, 'task-1', 'completed');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEndpoint: 'https://example.com/push',
        taskId: 'task-1',
        status: 'success',
      }),
    );
  });

  it('traces and throws on HTTP error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(
      service.deliverTaskUpdate({ url: 'https://example.com/push' }, 'task-1', 'completed'),
    ).rejects.toThrow('HTTP 500');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('traces and throws on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await expect(
      service.deliverTaskUpdate({ url: 'https://example.com/push' }, 'task-1', 'completed'),
    ).rejects.toThrow('Connection refused');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'Connection refused' }),
    );
  });
});
