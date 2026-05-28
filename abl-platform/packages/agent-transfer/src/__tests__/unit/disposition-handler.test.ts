import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { DispositionHandler, type DeferredContext } from '../../post-agent/disposition-handler.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('DispositionHandler', () => {
  let redis: InstanceType<typeof Redis>;
  let handler: DispositionHandler;

  beforeEach(() => {
    redis = new Redis();
    handler = new DispositionHandler(redis as any);
  });

  const context: DeferredContext = {
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    provider: 'kore',
    storedAt: Date.now(),
  };

  it('storeDeferredContext stores with 24hr TTL', async () => {
    await handler.storeDeferredContext(context);
    const raw = await redis.get('at_deferred:tenant-1:contact-1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.tenantId).toBe('tenant-1');
    expect(parsed.provider).toBe('kore');

    const ttl = await redis.ttl('at_deferred:tenant-1:contact-1');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('getDeferredContext retrieves stored context', async () => {
    await handler.storeDeferredContext(context);
    const result = await handler.getDeferredContext('tenant-1', 'contact-1');
    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe('tenant-1');
    expect(result!.provider).toBe('kore');
  });

  it('getDeferredContext returns null for missing key', async () => {
    const result = await handler.getDeferredContext('tenant-1', 'contact-999');
    expect(result).toBeNull();
  });

  it('handleDispositionSubmitted updates existing context', async () => {
    await handler.storeDeferredContext(context);

    await handler.handleDispositionSubmitted('tenant-1', 'contact-1', {
      code: 'resolved',
      notes: 'Issue fixed',
      submittedAt: Date.now(),
    });

    const result = await handler.getDeferredContext('tenant-1', 'contact-1');
    expect(result!.metadata).toEqual(
      expect.objectContaining({
        dispositionCode: 'resolved',
        wrapUpNotes: 'Issue fixed',
      }),
    );
  });

  it('handleDispositionSubmitted is no-op if no existing context', async () => {
    await handler.handleDispositionSubmitted('tenant-1', 'contact-missing', {
      code: 'resolved',
      submittedAt: Date.now(),
    });

    const result = await handler.getDeferredContext('tenant-1', 'contact-missing');
    expect(result).toBeNull();
  });

  it('clearDeferredContext removes key', async () => {
    await handler.storeDeferredContext(context);
    await handler.clearDeferredContext('tenant-1', 'contact-1');

    const result = await handler.getDeferredContext('tenant-1', 'contact-1');
    expect(result).toBeNull();
  });

  it('keys are tenant-isolated', async () => {
    const context2 = { ...context, tenantId: 'tenant-2' };
    await handler.storeDeferredContext(context);
    await handler.storeDeferredContext(context2);

    const r1 = await handler.getDeferredContext('tenant-1', 'contact-1');
    const r2 = await handler.getDeferredContext('tenant-2', 'contact-1');

    expect(r1!.tenantId).toBe('tenant-1');
    expect(r2!.tenantId).toBe('tenant-2');

    // Clearing one tenant doesn't affect the other
    await handler.clearDeferredContext('tenant-1', 'contact-1');
    expect(await handler.getDeferredContext('tenant-1', 'contact-1')).toBeNull();
    expect(await handler.getDeferredContext('tenant-2', 'contact-1')).not.toBeNull();
  });
});
