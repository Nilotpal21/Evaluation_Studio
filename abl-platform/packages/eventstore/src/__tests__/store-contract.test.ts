/**
 * Shared store contract tests.
 * Runs against every IEventStore implementation to guarantee behavioral equivalence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IEventStore } from '../interfaces/event-store.js';
import { MemoryEventStore } from '../stores/memory/memory-event-store.js';
import {
  createTestEvent,
  createSessionEndedEvent,
  createErrorEvent,
  createPIIEvent,
  TENANT_A,
  TENANT_B,
  PROJECT_A,
  PROJECT_B,
  resetEventCounter,
} from './helpers.js';

function runStoreContractTests(name: string, createStore: () => IEventStore) {
  describe(`IEventStore contract: ${name}`, () => {
    let store: IEventStore;

    beforeEach(() => {
      resetEventCounter();
      store = createStore();
    });

    // ─── Write + Query roundtrip ──────────────────────────────────────────────

    describe('write + query roundtrip', () => {
      it('writes and reads back an event', async () => {
        const event = createTestEvent();
        store.write(event);

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(result.events.length).toBe(1);
        expect(result.total).toBe(1);
      });

      it('writeBatch writes multiple events', async () => {
        const events = [createTestEvent(), createTestEvent(), createTestEvent()];
        store.writeBatch(events);

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(result.events.length).toBe(3);
        expect(result.total).toBe(3);
      });
    });

    // ─── Tenant isolation ─────────────────────────────────────────────────────

    describe('tenant isolation', () => {
      it('query() filters by tenantId', async () => {
        store.write(createTestEvent({ tenant_id: TENANT_A }));
        store.write(createTestEvent({ tenant_id: TENANT_B }));

        const resultA = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(resultA.events.length).toBe(1);
      });

      it('query() filters by projectId', async () => {
        store.write(createTestEvent({ project_id: PROJECT_A }));
        store.write(createTestEvent({ project_id: PROJECT_B }));

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(result.events.length).toBe(1);
      });
    });

    // ─── Query filters ────────────────────────────────────────────────────────

    describe('query filters', () => {
      it('filters by timeRange', async () => {
        store.write(createTestEvent({ timestamp: new Date('2026-02-26T12:00:00Z') }));
        store.write(createTestEvent({ timestamp: new Date('2026-02-27T12:00:00Z') }));
        store.write(createTestEvent({ timestamp: new Date('2026-02-28T12:00:00Z') }));

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-27T23:59:59Z'),
          },
        });

        expect(result.events.length).toBe(1);
      });

      it('filters by category', async () => {
        store.write(createTestEvent({ category: 'session' }));
        store.write(createTestEvent({ category: 'llm', event_type: 'llm.call.completed' }));

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          category: 'session',
        });

        expect(result.events.length).toBe(1);
      });

      it('filters by eventTypes', async () => {
        store.write(createTestEvent({ event_type: 'session.started' }));
        store.write(createTestEvent({ event_type: 'session.ended' }));
        store.write(createTestEvent({ event_type: 'llm.call.completed', category: 'llm' }));

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          eventTypes: ['session.started', 'session.ended'],
        });

        expect(result.events.length).toBe(2);
      });

      it('filters by sessionId', async () => {
        store.write(createTestEvent({ session_id: 'sess-100' }));
        store.write(createTestEvent({ session_id: 'sess-200' }));

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          sessionId: 'sess-100',
        });

        expect(result.events.length).toBe(1);
      });

      it('filters by hasError', async () => {
        store.write(createTestEvent({ has_error: false }));
        store.write(createErrorEvent());

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          hasError: true,
        });

        expect(result.events.length).toBe(1);
      });
    });

    // ─── Pagination ───────────────────────────────────────────────────────────

    describe('pagination', () => {
      it('limits results with limit parameter', async () => {
        for (let i = 0; i < 10; i++) {
          store.write(createTestEvent());
        }

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          limit: 3,
        });

        expect(result.events.length).toBe(3);
        expect(result.total).toBe(10);
        expect(result.hasMore).toBe(true);
      });

      it('supports offset for pagination', async () => {
        for (let i = 0; i < 5; i++) {
          store.write(createTestEvent());
        }

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          limit: 3,
          offset: 3,
        });

        expect(result.events.length).toBe(2);
        expect(result.hasMore).toBe(false);
      });
    });

    // ─── Aggregate ────────────────────────────────────────────────────────────

    describe('aggregate()', () => {
      it('groups by category with count metric', async () => {
        store.write(createTestEvent({ category: 'session' }));
        store.write(createTestEvent({ category: 'session' }));
        store.write(createTestEvent({ category: 'llm', event_type: 'llm.call.completed' }));

        const result = await store.aggregate({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          groupBy: ['category'],
          metrics: ['count'],
        });

        expect(result.buckets.length).toBe(2);
        const sessionBucket = result.buckets.find((b) => b.category === 'session');
        expect(sessionBucket).toBeDefined();
        expect(Number(sessionBucket!.count)).toBe(2);
      });

      it('computes error_rate metric', async () => {
        store.write(createTestEvent({ has_error: false }));
        store.write(createTestEvent({ has_error: false }));
        store.write(createErrorEvent());

        const result = await store.aggregate({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          groupBy: ['category'],
          metrics: ['count', 'error_rate'],
        });

        expect(result.buckets.length).toBeGreaterThanOrEqual(1);
      });
    });

    // ─── Count ────────────────────────────────────────────────────────────────

    describe('count()', () => {
      it('counts events grouped by event_type', async () => {
        store.write(createTestEvent({ event_type: 'session.started' }));
        store.write(createTestEvent({ event_type: 'session.started' }));
        store.write(createSessionEndedEvent());

        const result = await store.count({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
          groupBy: 'event_type',
        });

        expect(result.counts.length).toBe(2);
        const startedCount = result.counts.find((c) => c.key === 'session.started');
        expect(startedCount?.count).toBe(2);
      });
    });

    // ─── Lifecycle: purgeExpired ───────────────────────────────────────────────

    describe('purgeExpired()', () => {
      it('removes events older than cutoff for a tenant', async () => {
        store.write(createTestEvent({ timestamp: new Date('2026-01-01T00:00:00Z') }));
        store.write(createTestEvent({ timestamp: new Date('2026-02-27T12:00:00Z') }));

        const purgeResult = await store.purgeExpired(TENANT_A, new Date('2026-02-01T00:00:00Z'));

        // Verify old event is gone
        const queryResult = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2025-01-01T00:00:00Z'),
            to: new Date('2027-01-01T00:00:00Z'),
          },
        });

        expect(queryResult.total).toBe(1);
      });

      it('does not affect other tenants', async () => {
        store.write(
          createTestEvent({
            tenant_id: TENANT_A,
            timestamp: new Date('2026-01-01T00:00:00Z'),
          }),
        );
        store.write(
          createTestEvent({
            tenant_id: TENANT_B,
            project_id: PROJECT_B,
            timestamp: new Date('2026-01-01T00:00:00Z'),
          }),
        );

        await store.purgeExpired(TENANT_A, new Date('2026-02-01T00:00:00Z'));

        // Tenant B's events should be untouched
        const result = await store.query({
          tenantId: TENANT_B,
          projectId: PROJECT_B,
          timeRange: {
            from: new Date('2025-01-01T00:00:00Z'),
            to: new Date('2027-01-01T00:00:00Z'),
          },
        });

        expect(result.total).toBe(1);
      });
    });

    // ─── Lifecycle: deleteBySessionIds ─────────────────────────────────────────

    describe('deleteBySessionIds()', () => {
      it('removes matching events', async () => {
        store.write(createTestEvent({ session_id: 'sess-A' }));
        store.write(createTestEvent({ session_id: 'sess-B' }));
        store.write(createTestEvent({ session_id: 'sess-C' }));

        await store.deleteBySessionIds(TENANT_A, ['sess-A', 'sess-B']);

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(result.total).toBe(1);
      });

      it('no-ops on empty sessionIds array', async () => {
        store.write(createTestEvent());

        await store.deleteBySessionIds(TENANT_A, []);

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(result.total).toBe(1);
      });
    });

    // ─── Lifecycle: anonymizeActor ────────────────────────────────────────────

    describe('anonymizeActor()', () => {
      it('replaces actor_id with anonymized hash', async () => {
        const event = createPIIEvent('user-12345');
        store.write(event);

        await store.anonymizeActor(TENANT_A, 'user-12345');

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2026-02-27T00:00:00Z'),
            to: new Date('2026-02-28T00:00:00Z'),
          },
        });

        expect(result.total).toBe(1);
        const storedEvent = result.events[0] as Record<string, unknown>;
        expect(storedEvent.actor_id).toContain('[ANONYMIZED:');
      });
    });

    // ─── Lifecycle: deleteTenant ──────────────────────────────────────────────

    describe('deleteTenant()', () => {
      it('removes all events for a tenant', async () => {
        store.write(createTestEvent({ tenant_id: TENANT_A }));
        store.write(createTestEvent({ tenant_id: TENANT_A }));
        store.write(createTestEvent({ tenant_id: TENANT_B, project_id: PROJECT_B }));

        await store.deleteTenant(TENANT_A);

        const resultA = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2025-01-01T00:00:00Z'),
            to: new Date('2027-01-01T00:00:00Z'),
          },
        });

        expect(resultA.total).toBe(0);

        // Tenant B untouched
        const resultB = await store.query({
          tenantId: TENANT_B,
          projectId: PROJECT_B,
          timeRange: {
            from: new Date('2025-01-01T00:00:00Z'),
            to: new Date('2027-01-01T00:00:00Z'),
          },
        });

        expect(resultB.total).toBe(1);
      });
    });

    // ─── Lifecycle: scrubPII ──────────────────────────────────────────────────

    describe('scrubPII()', () => {
      it('anonymizes data for PII event types', async () => {
        store.write(
          createPIIEvent('user-1', {
            event_type: 'channel.message.received',
            timestamp: new Date('2026-01-01T00:00:00Z'),
            has_error: true,
            error_message: 'Callback failed for alice@example.com',
            error_type: 'callback_error',
            metadata: { custom_dimensions: { customer_email: 'alice@example.com' } },
          }),
        );
        store.write(
          createTestEvent({
            event_type: 'session.started',
            timestamp: new Date('2026-01-01T00:00:00Z'),
          }),
        );

        await store.scrubPII(TENANT_A, new Date('2026-02-01T00:00:00Z'), [
          'channel.message.received',
        ]);

        const result = await store.query({
          tenantId: TENANT_A,
          projectId: PROJECT_A,
          timeRange: {
            from: new Date('2025-01-01T00:00:00Z'),
            to: new Date('2027-01-01T00:00:00Z'),
          },
        });

        expect(result.total).toBe(2);
        // The PII event's data should be anonymized
        const piiEvent = result.events.find(
          (e) => (e as Record<string, unknown>).event_type === 'channel.message.received',
        ) as Record<string, unknown>;
        expect(piiEvent.data).toEqual({ anonymized: true });
        expect(piiEvent.error_message).toBeUndefined();
        expect(piiEvent.error_type).toBeUndefined();
        expect(piiEvent.metadata).toBeUndefined();

        // The session event's data should be untouched
        const sessionEvent = result.events.find(
          (e) => (e as Record<string, unknown>).event_type === 'session.started',
        ) as Record<string, unknown>;
        expect(sessionEvent.data).not.toEqual({ anonymized: true });
      });
    });
  });
}

// Run contract tests against MemoryEventStore
runStoreContractTests('MemoryEventStore', () => new MemoryEventStore());
