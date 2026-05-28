/**
 * RuntimeEventBus Tests
 *
 * Verifies tenant-gated delivery, subscriber management, error isolation,
 * unsubscribe, and shutdown behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimeEventBus } from '../../../services/event-bus/event-bus.js';
import { EventSubscriptionRegistry } from '../../../services/event-bus/subscription-registry.js';
import type { AnyPlatformEvent } from '../../../services/event-bus/types.js';

// Suppress logger output in tests
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AnyPlatformEvent> = {}): AnyPlatformEvent {
  return {
    eventId: 'evt-001',
    type: 'session.created',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    agentName: 'test-agent',
    channel: 'web',
    timestamp: '2026-03-01T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

function subscribeRegistry(
  registry: EventSubscriptionRegistry,
  tenantId: string,
  eventTypes: string[],
): void {
  const subs = new Map<string, Set<string>>();
  subs.set(tenantId, new Set(eventTypes));
  registry.updateSubscriptions(subs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeEventBus', () => {
  let registry: EventSubscriptionRegistry;
  let bus: RuntimeEventBus;

  beforeEach(() => {
    registry = new EventSubscriptionRegistry();
    bus = new RuntimeEventBus(registry);
  });

  // -----------------------------------------------------------------------
  // Delivery when subscribed
  // -----------------------------------------------------------------------

  it('delivers events when tenant is subscribed', () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);
    const handler = vi.fn();
    bus.subscribe(handler);

    const event = makeEvent();
    bus.emit(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  // -----------------------------------------------------------------------
  // Tenant gating
  // -----------------------------------------------------------------------

  it('does NOT deliver when tenant is not subscribed', () => {
    // Registry is empty — no tenants subscribed
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT deliver when tenant subscribes to a different event type', () => {
    subscribeRegistry(registry, 'tenant-1', ['message.user']);
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit(makeEvent({ type: 'session.created' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT deliver events for a different tenant', () => {
    subscribeRegistry(registry, 'tenant-other', ['session.created']);
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit(makeEvent({ tenantId: 'tenant-1' }));

    expect(handler).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Multiple subscribers
  // -----------------------------------------------------------------------

  it('delivers to multiple subscribers', () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.subscribe(handler1);
    bus.subscribe(handler2);

    const event = makeEvent();
    bus.emit(event);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler1).toHaveBeenCalledWith(event);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledWith(event);
  });

  // -----------------------------------------------------------------------
  // Error isolation
  // -----------------------------------------------------------------------

  it('does not throw if a subscriber throws, and still delivers to remaining subscribers', () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);

    const throwingHandler = vi.fn(() => {
      throw new Error('subscriber boom');
    });
    const safeHandler = vi.fn();

    bus.subscribe(throwingHandler);
    bus.subscribe(safeHandler);

    const event = makeEvent();
    // Should not throw
    expect(() => bus.emit(event)).not.toThrow();

    expect(throwingHandler).toHaveBeenCalledTimes(1);
    expect(safeHandler).toHaveBeenCalledTimes(1);
    expect(safeHandler).toHaveBeenCalledWith(event);
  });

  // -----------------------------------------------------------------------
  // Unsubscribe
  // -----------------------------------------------------------------------

  it('stops delivering after unsubscribe', () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit(makeEvent());
    expect(handler).toHaveBeenCalledTimes(1);

    bus.unsubscribe(handler);
    bus.emit(makeEvent());
    // Should not have been called again
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('only removes the specific subscriber on unsubscribe', () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.subscribe(handler1);
    bus.subscribe(handler2);

    bus.unsubscribe(handler1);
    bus.emit(makeEvent());

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  it('stops delivering after shutdown', async () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);
    const handler = vi.fn();
    bus.subscribe(handler);

    await bus.shutdown();
    bus.emit(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('clears all subscribers on shutdown', async () => {
    subscribeRegistry(registry, 'tenant-1', ['session.created']);
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.subscribe(handler1);
    bus.subscribe(handler2);

    await bus.shutdown();
    bus.emit(makeEvent());

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });
});
