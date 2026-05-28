/**
 * Tests for TraceStore session cap (M-4).
 *
 * Verifies that the in-memory TraceStore evicts oldest sessions
 * when maxSessions limit is reached.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TraceStore } from '../../services/trace-store.js';

describe('TraceStore session limits (M-4)', () => {
  let store: TraceStore;

  afterEach(() => {
    store?.stop();
  });

  it('evicts oldest session when max cap is reached', () => {
    store = new TraceStore({ maxSessions: 5 });

    // Add 5 sessions
    for (let i = 0; i < 5; i++) {
      store.addEvent(`session-${i}`, {
        id: `evt-${i}`,
        sessionId: `session-${i}`,
        type: 'test',
        timestamp: new Date(),
        data: {},
      });
    }
    expect(store.getActiveSessions().length).toBe(5);

    // Add 6th session — should evict session-0
    store.addEvent('session-5', {
      id: 'evt-5',
      sessionId: 'session-5',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    expect(store.getActiveSessions().length).toBe(5);
    expect(store.getEvents('session-0')).toHaveLength(0); // evicted
    expect(store.getEvents('session-5').length).toBeGreaterThan(0); // new session exists
  });

  it('evicted session is the one with oldest insertion', () => {
    store = new TraceStore({ maxSessions: 3 });

    store.addEvent('first', {
      id: 'e1',
      sessionId: 'first',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });
    store.addEvent('second', {
      id: 'e2',
      sessionId: 'second',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });
    store.addEvent('third', {
      id: 'e3',
      sessionId: 'third',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    // Adding 4th should evict 'first'
    store.addEvent('fourth', {
      id: 'e4',
      sessionId: 'fourth',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    expect(store.getEvents('first')).toHaveLength(0);
    expect(store.getEvents('second').length).toBeGreaterThan(0);
    expect(store.getEvents('fourth').length).toBeGreaterThan(0);
  });

  it('new session is successfully added after eviction', () => {
    store = new TraceStore({ maxSessions: 2 });

    store.addEvent('a', {
      id: 'e1',
      sessionId: 'a',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });
    store.addEvent('b', {
      id: 'e2',
      sessionId: 'b',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    // Add new session after eviction
    store.addEvent('c', {
      id: 'e3',
      sessionId: 'c',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    const sessions = store.getActiveSessions();
    expect(sessions).toContain('c');
    expect(sessions.length).toBe(2);
  });

  it('default maxSessions is 50000', () => {
    store = new TraceStore();
    const stats = store.getStats();
    expect(stats.config.maxSessions).toBe(50000);
  });

  it('readSince returns only events that occurred after the last seen event id', () => {
    store = new TraceStore({ cleanupIntervalSeconds: 999 });
    const now = Date.now();

    store.addEvent('resume-session', {
      id: 'evt-1',
      sessionId: 'resume-session',
      type: 'test',
      timestamp: new Date(now),
      data: {},
    });
    store.addEvent('resume-session', {
      id: 'evt-2',
      sessionId: 'resume-session',
      type: 'test',
      timestamp: new Date(now + 1_000),
      data: {},
    });

    expect(store.readSince('resume-session', 'evt-1')).toEqual({
      events: [
        expect.objectContaining({
          id: 'evt-2',
          sessionId: 'resume-session',
        }),
      ],
      totalBuffered: 2,
      afterEventId: 'evt-1',
      snapshotRequired: false,
    });
  });

  it('readSince marks snapshotRequired when the last seen event id is missing from the buffer', () => {
    store = new TraceStore({ cleanupIntervalSeconds: 999 });
    const now = Date.now();

    store.addEvent('resume-session', {
      id: 'evt-2',
      sessionId: 'resume-session',
      type: 'test',
      timestamp: new Date(now),
      data: {},
    });

    expect(store.readSince('resume-session', 'evt-missing')).toEqual({
      events: [],
      totalBuffered: 1,
      afterEventId: 'evt-missing',
      snapshotRequired: true,
    });
  });

  it('cleanup still works after eviction', () => {
    store = new TraceStore({
      maxSessions: 3,
      sessionTimeoutMinutes: 0, // immediate timeout
      cleanupIntervalSeconds: 999, // don't auto-run
    });

    // Add and evict
    for (let i = 0; i < 5; i++) {
      store.addEvent(`s-${i}`, {
        id: `e-${i}`,
        sessionId: `s-${i}`,
        type: 'test',
        timestamp: new Date(Date.now() - 120_000), // old timestamp
        data: {},
      });
    }

    // Trigger manual cleanup by stopping and verifying no errors
    expect(() => store.stop()).not.toThrow();
  });

  it('finalizeSession preserves buffered events but removes the session from active listings', () => {
    store = new TraceStore({ cleanupIntervalSeconds: 999 });

    store.addEvent('finished-session', {
      id: 'evt-1',
      sessionId: 'finished-session',
      type: 'test',
      timestamp: new Date(),
      data: {},
    });

    expect(store.getActiveSessions()).toContain('finished-session');

    store.finalizeSession('finished-session');

    expect(store.getEvents('finished-session')).toHaveLength(1);
    expect(store.getActiveSessions()).not.toContain('finished-session');
  });
});
