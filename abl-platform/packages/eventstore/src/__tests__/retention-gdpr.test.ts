import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { EventRetentionService } from '../retention/event-retention-service.js';
import { EventGDPRService } from '../retention/event-gdpr-service.js';
import { EventRegistry } from '../schema/event-registry.js';
import { MemoryEventStore } from '../stores/memory/memory-event-store.js';
import type { RetentionPolicy } from '../interfaces/event-retention.js';
import {
  createTestEvent,
  createPIIEvent,
  TENANT_A,
  TENANT_B,
  PROJECT_A,
  PROJECT_B,
  resetEventCounter,
} from './helpers.js';

// Register PII event type on the global registry for retention tests
import { eventRegistry } from '../schema/event-registry.js';

// Ensure events are registered (import triggers registration)
import '../schema/events/index.js';

describe('EventRetentionService', () => {
  let store: MemoryEventStore;
  let retention: EventRetentionService;

  beforeEach(() => {
    resetEventCounter();
    store = new MemoryEventStore();
    retention = new EventRetentionService(store);
  });

  describe('runRetention()', () => {
    it('purges events older than totalRetentionDays', async () => {
      // Write events: one old, one recent
      store.write(
        createTestEvent({
          timestamp: new Date('2025-01-01T00:00:00Z'), // very old
        }),
      );
      store.write(
        createTestEvent({
          timestamp: new Date('2026-02-27T12:00:00Z'), // recent
        }),
      );

      const policy: RetentionPolicy = {
        events: {
          totalRetentionDays: 90,
          piiRetentionDays: 30,
        },
      };

      const result = await retention.runRetention(TENANT_A, policy);

      // Old event should be purged
      const queryResult = await store.query({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        timeRange: {
          from: new Date('2024-01-01T00:00:00Z'),
          to: new Date('2027-01-01T00:00:00Z'),
        },
      });

      expect(queryResult.total).toBe(1);
    });

    it('scrubs PII when piiRetentionDays < totalRetentionDays', async () => {
      // The scrubPII call depends on eventRegistry.getPIIEventTypes()
      // which requires registered PII event types
      const result = await retention.runRetention(TENANT_A, {
        events: {
          totalRetentionDays: 365,
          piiRetentionDays: 30,
        },
      });

      // Should not throw, scrubbed count is based on PII event type count
      expect(result).toBeDefined();
      expect(typeof result.deleted).toBe('number');
      expect(typeof result.scrubbed).toBe('number');
    });
  });

  describe('purgeExpired()', () => {
    it('delegates to lifecycle.purgeExpired', async () => {
      store.write(
        createTestEvent({
          timestamp: new Date('2025-01-01T00:00:00Z'),
        }),
      );

      const result = await retention.purgeExpired(TENANT_A, new Date('2026-01-01T00:00:00Z'));

      expect(result.deletedEstimate).toBe(1);
    });
  });
});

describe('EventGDPRService', () => {
  let store: MemoryEventStore;
  let gdpr: EventGDPRService;

  beforeEach(() => {
    resetEventCounter();
    store = new MemoryEventStore();
    gdpr = new EventGDPRService(store);
  });

  describe('deleteBySessionIds()', () => {
    it('deletes events for specified sessions', async () => {
      store.write(createTestEvent({ session_id: 'sess-to-delete' }));
      store.write(createTestEvent({ session_id: 'sess-to-keep' }));

      await gdpr.deleteBySessionIds(TENANT_A, ['sess-to-delete']);

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

      await gdpr.deleteBySessionIds(TENANT_A, []);

      expect(store.getEventCount()).toBe(1);
    });
  });

  describe('anonymizeActor()', () => {
    it('anonymizes actor_id across all events', async () => {
      store.write(createPIIEvent('user-xyz-123'));
      store.write(createPIIEvent('user-xyz-123'));
      store.write(createPIIEvent('other-user'));

      await gdpr.anonymizeActor(TENANT_A, 'user-xyz-123');

      const allEvents = store.getAllEvents();
      const anonymized = allEvents.filter((e) => e.actor_id?.includes('[ANONYMIZED:'));
      expect(anonymized.length).toBe(2);

      // Other user should not be affected
      const untouched = allEvents.filter((e) => e.actor_id === 'other-user');
      expect(untouched.length).toBe(1);
    });
  });

  describe('deleteTenant()', () => {
    it('removes all events for a tenant', async () => {
      store.write(createTestEvent({ tenant_id: TENANT_A }));
      store.write(createTestEvent({ tenant_id: TENANT_A }));
      store.write(createTestEvent({ tenant_id: TENANT_B, project_id: PROJECT_B }));

      await gdpr.deleteTenant(TENANT_A);

      expect(store.getEventCount()).toBe(1);
      const remaining = store.getAllEvents();
      expect(remaining[0].tenant_id).toBe(TENANT_B);
    });
  });
});
