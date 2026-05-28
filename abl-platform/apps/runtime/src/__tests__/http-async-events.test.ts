/**
 * HTTP Async Event Contract Test
 *
 * Verifies that the WebhookEventType union in types.ts covers all planned
 * webhook event types and that downstream types (DeliveryJobPayload,
 * NormalizedOutgoingMessage) reference it consistently.
 *
 * The full type union is the forward-looking contract. The route handler
 * accepts the currently wired HTTP Async events (`agent.response` and
 * `agent.status`); session lifecycle delivery and error reporting remain
 * future members until their workers are wired.
 */
import { describe, it, expect } from 'vitest';
import type {
  WebhookEventType,
  DeliveryJobPayload,
  NormalizedOutgoingMessage,
} from '../channels/types.js';

/**
 * Every event type the platform intends to deliver via webhook.
 *
 * The `satisfies WebhookEventType[]` annotation ensures each element is a
 * valid member of the union, but it does NOT enforce exhaustiveness \u2014 if a
 * new literal is added to the WebhookEventType union, TypeScript will NOT
 * error here.  The toHaveLength(4) assertion below is a manual guard: bump
 * it whenever a new event type is added to the union AND to this array.
 */
const ALL_WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  'agent.response',
  'agent.status',
  'session.completed',
  'session.escalated',
  'delivery.failed',
] satisfies WebhookEventType[];

describe('HTTP Async event contract', () => {
  // Bump this count whenever a new event type is added to the union AND the array above.
  it('WebhookEventType union covers exactly 5 event types', () => {
    expect(ALL_WEBHOOK_EVENT_TYPES).toHaveLength(5);
  });

  it('every declared event type is a unique string', () => {
    const unique = new Set(ALL_WEBHOOK_EVENT_TYPES);
    expect(unique.size).toBe(ALL_WEBHOOK_EVENT_TYPES.length);
  });

  it('agent.response is assignable to WebhookEventType', () => {
    const eventType: WebhookEventType = 'agent.response';
    expect(eventType).toBe('agent.response');
  });

  it('agent.status is assignable to WebhookEventType', () => {
    const eventType: WebhookEventType = 'agent.status';
    expect(eventType).toBe('agent.status');
  });

  it('session.completed is assignable to WebhookEventType', () => {
    const eventType: WebhookEventType = 'session.completed';
    expect(eventType).toBe('session.completed');
  });

  it('session.escalated is assignable to WebhookEventType', () => {
    const eventType: WebhookEventType = 'session.escalated';
    expect(eventType).toBe('session.escalated');
  });

  it('delivery.failed is assignable to WebhookEventType', () => {
    const eventType: WebhookEventType = 'delivery.failed';
    expect(eventType).toBe('delivery.failed');
  });

  it('DeliveryJobPayload.eventType accepts all WebhookEventType values', () => {
    // Compile-time: the typed assignment proves DeliveryJobPayload.eventType
    // is compatible with every WebhookEventType member.
    // Runtime: we verify the constructed payloads are structurally valid.
    for (const eventType of ALL_WEBHOOK_EVENT_TYPES) {
      const payload: DeliveryJobPayload = {
        deliveryId: 'test-delivery',
        subscriptionId: 'test-sub',
        tenantId: 'test-tenant',
        eventType,
        payload: '{}',
      };
      expect(payload.eventType).toBe(eventType);
    }
  });

  it('NormalizedOutgoingMessage.eventType accepts all WebhookEventType values', () => {
    // Compile-time: the typed assignment proves NormalizedOutgoingMessage.eventType
    // is compatible with every WebhookEventType member.
    // Runtime: we verify the constructed messages are structurally valid.
    for (const eventType of ALL_WEBHOOK_EVENT_TYPES) {
      const message: NormalizedOutgoingMessage = {
        sessionId: 'test-session',
        text: 'test',
        eventType,
      };
      expect(message.eventType).toBe(eventType);
    }
  });

  it('event types follow the domain.action naming convention', () => {
    for (const eventType of ALL_WEBHOOK_EVENT_TYPES) {
      expect(eventType).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
