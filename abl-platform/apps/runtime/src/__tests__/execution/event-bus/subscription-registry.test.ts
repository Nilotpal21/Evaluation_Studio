/**
 * EventSubscriptionRegistry Tests
 *
 * Verifies subscription lookup, multi-tenant isolation, manual updates,
 * periodic sync, and error resilience.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventSubscriptionRegistry } from '../../../services/event-bus/subscription-registry.js';

// Suppress logger output in tests
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('EventSubscriptionRegistry', () => {
  let registry: EventSubscriptionRegistry;

  beforeEach(() => {
    registry = new EventSubscriptionRegistry();
  });

  afterEach(() => {
    registry.stop();
  });

  // -----------------------------------------------------------------------
  // Basic lookup
  // -----------------------------------------------------------------------

  it('returns false for an unregistered tenant', () => {
    expect(registry.isSubscribed('unknown-tenant', 'session.created')).toBe(false);
  });

  it('returns true after manual registration via updateSubscriptions', () => {
    const subs = new Map<string, Set<string>>();
    subs.set('tenant-1', new Set(['session.created', 'message.user']));
    registry.updateSubscriptions(subs);

    expect(registry.isSubscribed('tenant-1', 'session.created')).toBe(true);
    expect(registry.isSubscribed('tenant-1', 'message.user')).toBe(true);
  });

  it('returns false for a tenant with empty subscriptions', () => {
    const subs = new Map<string, Set<string>>();
    subs.set('tenant-1', new Set());
    registry.updateSubscriptions(subs);

    expect(registry.isSubscribed('tenant-1', 'session.created')).toBe(false);
  });

  it('returns false when event type is not in the subscription set', () => {
    const subs = new Map<string, Set<string>>();
    subs.set('tenant-1', new Set(['session.created']));
    registry.updateSubscriptions(subs);

    expect(registry.isSubscribed('tenant-1', 'tool.called')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Multi-tenant isolation
  // -----------------------------------------------------------------------

  it('supports multiple tenants independently', () => {
    const subs = new Map<string, Set<string>>();
    subs.set('tenant-a', new Set(['session.created']));
    subs.set('tenant-b', new Set(['message.user']));
    registry.updateSubscriptions(subs);

    expect(registry.isSubscribed('tenant-a', 'session.created')).toBe(true);
    expect(registry.isSubscribed('tenant-a', 'message.user')).toBe(false);
    expect(registry.isSubscribed('tenant-b', 'message.user')).toBe(true);
    expect(registry.isSubscribed('tenant-b', 'session.created')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Replacement semantics
  // -----------------------------------------------------------------------

  it('replaces subscriptions entirely on update', () => {
    const firstSubs = new Map<string, Set<string>>();
    firstSubs.set('tenant-1', new Set(['session.created']));
    registry.updateSubscriptions(firstSubs);
    expect(registry.isSubscribed('tenant-1', 'session.created')).toBe(true);

    // Replace with a new map that does not include tenant-1
    const secondSubs = new Map<string, Set<string>>();
    secondSubs.set('tenant-2', new Set(['tool.called']));
    registry.updateSubscriptions(secondSubs);

    expect(registry.isSubscribed('tenant-1', 'session.created')).toBe(false);
    expect(registry.isSubscribed('tenant-2', 'tool.called')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // startSync
  // -----------------------------------------------------------------------

  it('calls sync function immediately on startSync', async () => {
    const syncFn = vi.fn(async () => {
      const subs = new Map<string, Set<string>>();
      subs.set('synced-tenant', new Set(['message.agent']));
      return subs;
    });

    await registry.startSync(syncFn, 60_000);

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(registry.isSubscribed('synced-tenant', 'message.agent')).toBe(true);
  });

  it('periodically calls sync function', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const syncFn = vi.fn(async () => {
      callCount++;
      const subs = new Map<string, Set<string>>();
      subs.set('tenant-1', new Set([`event-${callCount}`]));
      return subs;
    });

    await registry.startSync(syncFn, 1000);
    expect(callCount).toBe(1);

    // Advance timer to trigger periodic sync
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(3);

    registry.stop();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Error resilience
  // -----------------------------------------------------------------------

  it('does not crash if sync function throws', async () => {
    const failingSyncFn = vi.fn(async () => {
      throw new Error('DB connection lost');
    });

    // Should not throw — the error is caught and logged internally
    await expect(registry.startSync(failingSyncFn, 60_000)).resolves.toBeUndefined();
  });

  it('keeps previous state if sync function throws', async () => {
    const subs = new Map<string, Set<string>>();
    subs.set('tenant-1', new Set(['session.created']));
    registry.updateSubscriptions(subs);

    const failingSyncFn = vi.fn(async () => {
      throw new Error('DB connection lost');
    });

    // startSync will call refresh internally, which catches the error
    await registry.startSync(failingSyncFn, 60_000);

    // Previous state should be preserved
    expect(registry.isSubscribed('tenant-1', 'session.created')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  it('stops periodic sync after stop()', async () => {
    vi.useFakeTimers();

    const syncFn = vi.fn(async () => new Map<string, Set<string>>());

    await registry.startSync(syncFn, 1000);
    expect(syncFn).toHaveBeenCalledTimes(1);

    registry.stop();

    await vi.advanceTimersByTimeAsync(3000);
    // Should not have been called again after stop
    expect(syncFn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
