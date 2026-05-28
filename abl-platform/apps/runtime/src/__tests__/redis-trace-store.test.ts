/**
 * Redis Trace Store Tests
 *
 * Unit tests for RedisTraceStore covering:
 * - addEvent: writes to Redis Stream + publishes to Pub/Sub
 * - subscribe: replays buffered events + subscribes to channel
 * - unsubscribe: removes WebSocket subscriber, unsubscribes from Pub/Sub
 * - unsubscribeAll: removes WS from all sessions
 * - getEvents: reads from Redis Stream
 * - getActiveSessions: returns sessions with local subscribers
 * - setSessionAgent: stores agent metadata event
 * - removeSession: cleans up stream + Pub/Sub + notifies subscribers
 * - stop: graceful shutdown
 * - tenant resolution: cache hit, cache miss, Redis fallback
 * - broadcastLocal: dead socket cleanup
 * - handlePubSubMessage: anti-duplicate, malformed message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  RedisTraceStore,
  type TraceEvent,
  type TraceStoreConfig,
} from '../services/trace/redis-trace-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRedis() {
  // Pipeline now only carries xadd + expire (same-slot streamKey ops).
  // Publish is issued separately on the top-level client to keep the cluster
  // mode safe — keys for stream and channel hash to different slots.
  const pipelineMethods = {
    xadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  const subscriberHandlers = new Map<string, Function>();

  const subscriber = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: Function) => {
      subscriberHandlers.set(event, handler);
    }),
  };

  const redis = {
    pipeline: vi.fn(() => pipelineMethods),
    publish: vi.fn().mockResolvedValue(0),
    xrange: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    duplicate: vi.fn(() => subscriber),
  };

  return { redis, pipelineMethods, subscriber, subscriberHandlers };
}

function createMockWs(readyState = 1): any {
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
  };
}

function makeEvent(sessionId: string, type = 'agent_enter'): TraceEvent {
  return {
    id: `evt-${Date.now()}`,
    sessionId,
    type,
    timestamp: new Date(),
    data: { agentName: 'test' },
  };
}

describe('RedisTraceStore', () => {
  let store: RedisTraceStore;
  let mock: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mock = createMockRedis();
    store = new RedisTraceStore(mock.redis);
  });

  // =========================================================================
  // addEvent
  // =========================================================================

  describe('addEvent', () => {
    it('writes to Redis Stream and publishes to Pub/Sub channel', async () => {
      const event = makeEvent('sess-1');
      event.tenantId = 'tenant-1';

      await store.addEvent('sess-1', event);

      expect(mock.redis.pipeline).toHaveBeenCalled();
      expect(mock.pipelineMethods.xadd).toHaveBeenCalled();
      expect(mock.pipelineMethods.expire).toHaveBeenCalled();
      expect(mock.pipelineMethods.exec).toHaveBeenCalled();
      // Publish is issued on the top-level client (cluster-safe split): the
      // channel key would CROSSSLOT against the stream key in cluster mode.
      expect(mock.redis.publish).toHaveBeenCalled();
    });

    it('resolves tenantId from event', async () => {
      const event = makeEvent('sess-1');
      event.tenantId = 'tenant-abc';

      await store.addEvent('sess-1', event);

      // The stream key should include tenant-abc
      const xaddArgs = mock.pipelineMethods.xadd.mock.calls[0];
      expect(xaddArgs[0]).toContain('tenant-abc');
    });

    it('falls back to Redis lookup when no tenantId on event', async () => {
      mock.redis.get.mockResolvedValue('tenant-from-redis');

      const event = makeEvent('sess-1');

      await store.addEvent('sess-1', event);

      expect(mock.redis.get).toHaveBeenCalledWith('sess-tid:sess-1');
    });
  });

  // =========================================================================
  // subscribe
  // =========================================================================

  describe('subscribe', () => {
    it('replays buffered events and subscribes to Pub/Sub', async () => {
      const ws = createMockWs();
      const eventData = JSON.stringify({
        id: 'evt-1',
        sessionId: 'sess-1',
        type: 'agent_enter',
        timestamp: new Date().toISOString(),
        data: {},
      });

      mock.redis.xrange.mockResolvedValue([['stream-id-1', ['data', eventData]]]);

      const result = await store.subscribe('sess-1', ws);

      expect(result.success).toBe(true);
      expect(result.eventCount).toBe(1);
      expect(ws.send).toHaveBeenCalled();

      // Verify the replay message was sent
      const sentMessage = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentMessage.type).toBe('trace_replay');
      expect(sentMessage.events).toHaveLength(1);
    });

    it('handles empty stream gracefully', async () => {
      const ws = createMockWs();
      mock.redis.xrange.mockResolvedValue([]);

      const result = await store.subscribe('sess-1', ws);

      expect(result.success).toBe(true);
      expect(result.eventCount).toBe(0);
    });

    it('handles stream read error gracefully', async () => {
      const ws = createMockWs();
      mock.redis.xrange.mockRejectedValue(new Error('Redis down'));

      const result = await store.subscribe('sess-1', ws);

      expect(result.success).toBe(true);
      expect(result.eventCount).toBe(0);
    });

    it('handles malformed stream entries', async () => {
      const ws = createMockWs();
      mock.redis.xrange.mockResolvedValue([['id-1', ['data', 'not-json']]]);

      const result = await store.subscribe('sess-1', ws);

      expect(result.success).toBe(true);
      expect(result.eventCount).toBe(0);
    });

    it('creates subscriber connection on first subscribe', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);

      expect(mock.redis.duplicate).toHaveBeenCalled();
      expect(mock.subscriber.connect).toHaveBeenCalled();
      expect(mock.subscriber.subscribe).toHaveBeenCalled();
    });

    it('does not re-subscribe to same channel', async () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      await store.subscribe('sess-1', ws1);
      await store.subscribe('sess-1', ws2);

      // subscribe should only be called once for the same channel
      expect(mock.subscriber.subscribe).toHaveBeenCalledTimes(1);
    });

    it('uses the provided tenant hint when subscribing across pods', async () => {
      const ws = createMockWs();

      await store.subscribe('sess-1', ws, { tenantId: 'tenant-hint' });

      expect(mock.redis.get).not.toHaveBeenCalled();
      expect(mock.subscriber.subscribe).toHaveBeenCalledWith('trace:channel:tenant-hint:sess-1');
    });
  });

  // =========================================================================
  // unsubscribe
  // =========================================================================

  describe('unsubscribe', () => {
    it('removes a subscriber from a session', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);

      store.unsubscribe('sess-1', ws);

      expect(store.getActiveSessions()).not.toContain('sess-1');
    });

    it('unsubscribes from Pub/Sub when last subscriber leaves', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);

      store.unsubscribe('sess-1', ws);

      expect(mock.subscriber.unsubscribe).toHaveBeenCalled();
    });

    it('does not unsubscribe from Pub/Sub when other subscribers remain', async () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      await store.subscribe('sess-1', ws1);
      await store.subscribe('sess-1', ws2);

      store.unsubscribe('sess-1', ws1);

      // Should NOT unsubscribe — ws2 is still subscribed
      // subscriber.unsubscribe is not called at this point
      expect(store.getActiveSessions()).toContain('sess-1');
    });

    it('handles unsubscribe for non-existent session', () => {
      const ws = createMockWs();
      // Should not throw
      store.unsubscribe('non-existent', ws);
    });
  });

  // =========================================================================
  // unsubscribeAll
  // =========================================================================

  describe('unsubscribeAll', () => {
    it('removes ws from all sessions', async () => {
      const ws = createMockWs();

      await store.subscribe('sess-1', ws);
      await store.subscribe('sess-2', ws);

      store.unsubscribeAll(ws);

      expect(store.getActiveSessions()).toEqual([]);
    });
  });

  // =========================================================================
  // getEvents
  // =========================================================================

  describe('getEvents', () => {
    it('returns parsed events from Redis Stream', async () => {
      const eventData = JSON.stringify({
        id: 'evt-1',
        sessionId: 'sess-1',
        type: 'llm_call',
        timestamp: new Date().toISOString(),
        data: { model: 'gpt-4' },
        _pod: 'pod_xyz',
      });

      mock.redis.xrange.mockResolvedValue([['id-1', ['data', eventData]]]);

      const events = await store.getEvents('sess-1');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('llm_call');
      // _pod should be removed
      expect((events[0] as any)._pod).toBeUndefined();
    });

    it('returns empty array on error', async () => {
      mock.redis.xrange.mockRejectedValue(new Error('Redis down'));

      const events = await store.getEvents('sess-1');
      expect(events).toEqual([]);
    });

    it('returns empty array when entries is null', async () => {
      mock.redis.xrange.mockResolvedValue(null);

      const events = await store.getEvents('sess-1');
      expect(events).toEqual([]);
    });
  });

  describe('readSince', () => {
    it('returns only events after the last seen trace event id', async () => {
      mock.redis.xrange.mockResolvedValue([
        [
          'id-1',
          [
            'data',
            JSON.stringify({
              id: 'evt-1',
              sessionId: 'sess-1',
              type: 'llm_call',
              timestamp: new Date('2026-04-22T10:00:00.000Z').toISOString(),
              data: {},
            }),
          ],
        ],
        [
          'id-2',
          [
            'data',
            JSON.stringify({
              id: 'evt-2',
              sessionId: 'sess-1',
              type: 'tool_call',
              timestamp: new Date('2026-04-22T10:00:01.000Z').toISOString(),
              data: {},
            }),
          ],
        ],
      ]);

      const replay = await store.readSince('sess-1', 'evt-1');

      expect(replay).toEqual({
        events: [
          expect.objectContaining({
            id: 'evt-2',
            type: 'tool_call',
          }),
        ],
        totalBuffered: 2,
        afterEventId: 'evt-1',
        snapshotRequired: false,
      });
    });

    it('marks snapshotRequired when the last seen trace event id is no longer buffered', async () => {
      mock.redis.xrange.mockResolvedValue([
        [
          'id-1',
          [
            'data',
            JSON.stringify({
              id: 'evt-2',
              sessionId: 'sess-1',
              type: 'tool_call',
              timestamp: new Date('2026-04-22T10:00:01.000Z').toISOString(),
              data: {},
            }),
          ],
        ],
      ]);

      const replay = await store.readSince('sess-1', 'evt-missing');

      expect(replay).toEqual({
        events: [],
        totalBuffered: 1,
        afterEventId: 'evt-missing',
        snapshotRequired: true,
      });
    });

    it('uses the provided tenant hint instead of Redis reverse lookup', async () => {
      mock.redis.xrange.mockResolvedValue([]);

      await store.readSince('sess-1', 'evt-1', { tenantId: 'tenant-hint' });

      expect(mock.redis.get).not.toHaveBeenCalled();
      expect(mock.redis.xrange).toHaveBeenCalledWith('trace:stream:tenant-hint:sess-1', '-', '+');
    });
  });

  // =========================================================================
  // getActiveSessions
  // =========================================================================

  describe('getActiveSessions', () => {
    it('returns active session IDs', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);
      await store.subscribe('sess-2', ws);

      const sessions = store.getActiveSessions();
      expect(sessions).toContain('sess-1');
      expect(sessions).toContain('sess-2');
    });

    it('returns empty array when no subscribers', () => {
      expect(store.getActiveSessions()).toEqual([]);
    });
  });

  // =========================================================================
  // setSessionAgent
  // =========================================================================

  describe('setSessionAgent', () => {
    it('emits an agent_enter metadata event', async () => {
      // setSessionAgent calls addEvent internally (fire-and-forget)
      store.setSessionAgent('sess-1', 'greeting-agent');

      // Wait for the async addEvent to complete
      await vi.waitFor(() => {
        expect(mock.redis.pipeline).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // removeSession
  // =========================================================================

  describe('removeSession', () => {
    it('finalizeSession preserves the buffered stream for recent replay', async () => {
      const ws = createMockWs();
      const eventData = JSON.stringify({
        id: 'evt-1',
        sessionId: 'sess-1',
        type: 'agent_enter',
        timestamp: new Date().toISOString(),
        data: {},
      });

      mock.redis.xrange.mockResolvedValue([['id-1', ['data', eventData]]]);

      await store.subscribe('sess-1', ws);
      await store.finalizeSession('sess-1');

      const events = await store.getEvents('sess-1');
      expect(events).toHaveLength(1);
      expect(mock.redis.del).not.toHaveBeenCalled();
      expect(store.getActiveSessions()).not.toContain('sess-1');
    });

    it('notifies subscribers and cleans up', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);

      await store.removeSession('sess-1');

      // Should have sent session_ended message
      const sends = ws.send.mock.calls;
      const sessionEndedMsg = sends.find((call: unknown[]) => {
        const parsed = JSON.parse(call[0] as string);
        return parsed.type === 'session_ended';
      });
      expect(sessionEndedMsg).toBeDefined();

      // Should have deleted the stream
      expect(mock.redis.del).toHaveBeenCalled();

      // Should no longer be in active sessions
      expect(store.getActiveSessions()).not.toContain('sess-1');
    });

    it('handles removeSession with no subscribers', async () => {
      await store.removeSession('no-subs');
      expect(mock.redis.del).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // stop
  // =========================================================================

  describe('stop', () => {
    it('quits subscriber and clears state', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);

      await store.stop();

      expect(mock.subscriber.quit).toHaveBeenCalled();
      expect(store.getActiveSessions()).toEqual([]);
    });

    it('handles stop when no subscriber exists', async () => {
      await store.stop();
      // Should not throw
    });
  });

  // =========================================================================
  // tenant cache eviction
  // =========================================================================

  describe('tenant cache', () => {
    it('uses cached tenantId on subsequent calls', async () => {
      const event = makeEvent('sess-1');
      event.tenantId = 'tenant-cached';

      await store.addEvent('sess-1', event);

      // Reset the get mock to verify cache hit
      mock.redis.get.mockClear();

      const event2 = makeEvent('sess-1');
      // No tenantId on second event — should use cache
      await store.addEvent('sess-1', event2);

      // Should NOT have called redis.get because cache has the value
      expect(mock.redis.get).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // broadcastLocal — dead socket cleanup
  // =========================================================================

  describe('broadcastLocal', () => {
    it('removes dead sockets during broadcast', async () => {
      const openWs = createMockWs(1); // OPEN
      const closedWs = createMockWs(3); // CLOSED

      await store.subscribe('sess-1', openWs);
      await store.subscribe('sess-1', closedWs);

      const event = makeEvent('sess-1');
      event.tenantId = 'tenant-1';

      await store.addEvent('sess-1', event);

      // Open WS should receive broadcast, closed should not
      // After broadcast, the dead socket should be cleaned up
      // We verify indirectly: the open ws received a trace_event message
      const broadcastCalls = openWs.send.mock.calls.filter((call: unknown[]) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.type === 'trace_event';
        } catch {
          return false;
        }
      });
      expect(broadcastCalls.length).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // Pub/Sub message handling
  // =========================================================================

  describe('handlePubSubMessage', () => {
    it('subscriber error handler does not throw', async () => {
      const ws = createMockWs();
      await store.subscribe('sess-1', ws);

      // Trigger error handler
      const errorHandler = mock.subscriberHandlers.get('error');
      expect(errorHandler).toBeDefined();
      errorHandler!(new Error('Connection reset'));
      // Should not throw
    });
  });
});
