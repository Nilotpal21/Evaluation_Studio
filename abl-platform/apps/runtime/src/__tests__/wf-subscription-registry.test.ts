/**
 * WfSubscriptionRegistry Tests
 *
 * Tests the per-execution WebSocket subscription registry used by WfBridge.
 * Pure logic — no external deps, no mocks needed.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { WfSubscriptionRegistry } from '../websocket/wf-subscription-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(): WebSocket {
  return {} as unknown as WebSocket;
}

const META = { tenantId: 'tenant-1', projectId: 'proj-1' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WfSubscriptionRegistry', () => {
  let registry: WfSubscriptionRegistry;

  beforeEach(() => {
    registry = new WfSubscriptionRegistry(3);
  });

  // ── register ──────────────────────────────────────────────────────────────

  describe('register', () => {
    test('first subscriber creates entry and signals firstSubscriberForChannel', () => {
      const ws = makeWs();
      const result = registry.register('exec-1', META, ws);

      expect(result).toEqual({ ok: true, firstSubscriberForChannel: true });
      expect(registry.size()).toBe(1);
    });

    test('second connection to same executionId does not signal firstSubscriberForChannel', () => {
      const ws1 = makeWs();
      const ws2 = makeWs();
      registry.register('exec-1', META, ws1);
      const result = registry.register('exec-1', META, ws2);

      expect(result).toEqual({ ok: true, firstSubscriberForChannel: false });
      expect(registry.size()).toBe(1);
    });

    test('returns limit error when maxSize is reached', () => {
      registry.register('exec-1', META, makeWs());
      registry.register('exec-2', META, makeWs());
      registry.register('exec-3', META, makeWs());
      const result = registry.register('exec-4', META, makeWs());

      expect(result).toEqual({ ok: false, reason: 'limit' });
      expect(registry.size()).toBe(3);
    });
  });

  // ── unregister ────────────────────────────────────────────────────────────

  describe('unregister', () => {
    test('removing the last subscriber deletes entry and signals lastSubscriberForChannel', () => {
      const ws = makeWs();
      registry.register('exec-1', META, ws);
      const result = registry.unregister('exec-1', ws);

      expect(result).toEqual({ lastSubscriberForChannel: true });
      expect(registry.size()).toBe(0);
    });

    test('removing one of multiple connections leaves entry intact', () => {
      const ws1 = makeWs();
      const ws2 = makeWs();
      registry.register('exec-1', META, ws1);
      registry.register('exec-1', META, ws2);
      const result = registry.unregister('exec-1', ws1);

      expect(result).toEqual({ lastSubscriberForChannel: false });
      expect(registry.size()).toBe(1);
    });

    test('unregistering a nonexistent executionId returns false', () => {
      const result = registry.unregister('does-not-exist', makeWs());
      expect(result).toEqual({ lastSubscriberForChannel: false });
    });
  });

  // ── removeWebSocket ───────────────────────────────────────────────────────

  describe('removeWebSocket', () => {
    test('removes the ws from all entries where it appears', () => {
      const ws = makeWs();
      registry.register('exec-1', META, ws);
      registry.register('exec-2', META, ws);
      const result = registry.removeWebSocket(ws);

      expect(result.channelsDropped.sort()).toEqual(['exec-1', 'exec-2']);
      expect(registry.size()).toBe(0);
    });

    test('does not drop entries that still have other connections', () => {
      const ws1 = makeWs();
      const ws2 = makeWs();
      registry.register('exec-1', META, ws1);
      registry.register('exec-1', META, ws2);
      const result = registry.removeWebSocket(ws1);

      expect(result.channelsDropped).toEqual([]);
      expect(registry.size()).toBe(1);
    });
  });

  // ── sweep ─────────────────────────────────────────────────────────────────

  describe('sweep', () => {
    test('does not evict entries before their expiry time', () => {
      const ws = makeWs();
      registry.register('exec-1', META, ws);
      registry.markTerminal('exec-1', 30_000);

      const { evicted } = registry.sweep(Date.now());
      expect(evicted).toEqual([]);
      expect(registry.size()).toBe(1);
    });

    test('evicts entries whose expiry has passed', () => {
      const ws = makeWs();
      registry.register('exec-1', META, ws);
      registry.markTerminal('exec-1', 0);

      const { evicted } = registry.sweep(Date.now() + 1);
      expect(evicted).toEqual(['exec-1']);
      expect(registry.size()).toBe(0);
    });

    test('never evicts non-terminal entries (expiresAt null)', () => {
      registry.register('exec-1', META, makeWs());

      const { evicted } = registry.sweep(Date.now() + 1_000_000);
      expect(evicted).toEqual([]);
    });
  });

  // ── get ───────────────────────────────────────────────────────────────────

  describe('get', () => {
    test('returns undefined for unknown executionId', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });

    test('returns entry metadata for a registered executionId', () => {
      const ws = makeWs();
      registry.register('exec-1', META, ws);
      const entry = registry.get('exec-1');

      expect(entry?.tenantId).toBe(META.tenantId);
      expect(entry?.projectId).toBe(META.projectId);
      expect(entry?.connections.has(ws)).toBe(true);
    });
  });
});
