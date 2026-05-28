import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EventWebhookForwarder,
  type WebhookSubscription,
} from '../webhook/event-webhook-forwarder.js';
import type { PlatformEvent } from '../schema/platform-event.js';
import { createTestEvent, createLLMCallEvent, TENANT_A, resetEventCounter } from './helpers.js';

function createMockDeliveryQueue() {
  const jobs: unknown[] = [];
  return {
    add: vi.fn(async (name: string, data: unknown) => {
      jobs.push(data);
    }),
    jobs,
  };
}

function createSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    tenantId: TENANT_A,
    eventPattern: 'events.session.*',
    url: 'https://example.com/webhook',
    secret: 'test-secret',
    enabled: true,
    ...overrides,
  };
}

describe('EventWebhookForwarder', () => {
  let deliveryQueue: ReturnType<typeof createMockDeliveryQueue>;
  let forwarder: EventWebhookForwarder;
  let subscriptions: WebhookSubscription[];

  beforeEach(() => {
    resetEventCounter();
    deliveryQueue = createMockDeliveryQueue();
    subscriptions = [createSubscription()];

    forwarder = new EventWebhookForwarder({
      deliveryQueue,
      getSubscriptions: async (tenantId: string) =>
        subscriptions.filter((s) => s.tenantId === tenantId),
      cacheTTLMs: 60_000,
      maxCacheSize: 100,
    });
  });

  describe('maybeForward()', () => {
    it('forwards matching events to webhook queue', async () => {
      const event = createTestEvent();
      await forwarder.maybeForward(event);

      expect(deliveryQueue.add).toHaveBeenCalledTimes(1);
      expect(deliveryQueue.add).toHaveBeenCalledWith(
        'webhook-delivery',
        expect.objectContaining({
          subscriptionId: 'sub-1',
          url: 'https://example.com/webhook',
        }),
      );
    });

    it('does not forward non-matching events', async () => {
      const llmEvent = createLLMCallEvent();
      await forwarder.maybeForward(llmEvent);

      // event pattern is 'events.session.*' so llm events should not match
      expect(deliveryQueue.add).not.toHaveBeenCalled();
    });

    it('does not forward to disabled subscriptions', async () => {
      subscriptions = [createSubscription({ enabled: false })];

      const event = createTestEvent();
      await forwarder.maybeForward(event);

      expect(deliveryQueue.add).not.toHaveBeenCalled();
    });

    it('forwards to multiple matching subscriptions', async () => {
      subscriptions = [
        createSubscription({ id: 'sub-1', eventPattern: 'events.session.*' }),
        createSubscription({
          id: 'sub-2',
          eventPattern: 'events.session.started',
        }),
      ];

      const event = createTestEvent({ event_type: 'session.started' });
      await forwarder.maybeForward(event);

      expect(deliveryQueue.add).toHaveBeenCalledTimes(2);
    });

    it('handles exact pattern match', async () => {
      subscriptions = [
        createSubscription({
          eventPattern: 'events.session.started', // exact match
        }),
      ];

      const started = createTestEvent({ event_type: 'session.started' });
      const ended = createTestEvent({ event_type: 'session.ended' });

      await forwarder.maybeForward(started);
      await forwarder.maybeForward(ended);

      expect(deliveryQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('pattern matching', () => {
    it('wildcard pattern matches all events in category', async () => {
      subscriptions = [createSubscription({ eventPattern: 'events.llm.*' })];

      await forwarder.maybeForward(createLLMCallEvent({ event_type: 'llm.call.completed' }));

      expect(deliveryQueue.add).toHaveBeenCalledTimes(1);
    });

    it('pattern without events. prefix works', async () => {
      subscriptions = [createSubscription({ eventPattern: 'session.*' })];

      const event = createTestEvent({ event_type: 'session.started' });
      await forwarder.maybeForward(event);

      expect(deliveryQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscription caching', () => {
    it('caches subscriptions to avoid repeated DB lookups', async () => {
      const getSubsSpy = vi.fn(async () => subscriptions);

      const cachedForwarder = new EventWebhookForwarder({
        deliveryQueue,
        getSubscriptions: getSubsSpy,
        cacheTTLMs: 60_000,
      });

      await cachedForwarder.maybeForward(createTestEvent());
      await cachedForwarder.maybeForward(createTestEvent());
      await cachedForwarder.maybeForward(createTestEvent());

      // getSubscriptions should only be called once (result cached)
      expect(getSubsSpy).toHaveBeenCalledTimes(1);
    });

    it('clearCache forces a fresh lookup', async () => {
      const getSubsSpy = vi.fn(async () => subscriptions);

      const cachedForwarder = new EventWebhookForwarder({
        deliveryQueue,
        getSubscriptions: getSubsSpy,
        cacheTTLMs: 60_000,
      });

      await cachedForwarder.maybeForward(createTestEvent());
      cachedForwarder.clearCache();
      await cachedForwarder.maybeForward(createTestEvent());

      expect(getSubsSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('does not throw on getSubscriptions failure', async () => {
      const errorForwarder = new EventWebhookForwarder({
        deliveryQueue,
        getSubscriptions: async () => {
          throw new Error('DB unavailable');
        },
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Should not throw
      await errorForwarder.maybeForward(createTestEvent());
      errorSpy.mockRestore();
    });
  });
});
