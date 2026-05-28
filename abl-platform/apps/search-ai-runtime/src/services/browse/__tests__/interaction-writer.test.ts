import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock Dependencies ──────────────────────────────────────────────────

const { mockInsert, mockFlush, mockClose } = vi.hoisted(() => {
  const mockInsert = vi.fn();
  const mockFlush = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  return { mockInsert, mockFlush, mockClose };
});

vi.mock('@agent-platform/database/clickhouse', () => {
  return {
    getClickHouseClient: vi.fn(() => ({})),
    BufferedClickHouseWriter: vi.fn().mockImplementation(function () {
      return {
        insert: mockInsert,
        flush: mockFlush,
        close: mockClose,
      };
    }),
    toClickHouseDateTime: (input: Date | string) => {
      const d = typeof input === 'string' ? new Date(input) : input;
      return d.toISOString().replace('T', ' ').replace('Z', '');
    },
    toClickHouseDateTimeSec: (input: Date | string) => {
      const d = typeof input === 'string' ? new Date(input) : input;
      return d
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, '');
    },
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import AFTER mocks are set up
import { InteractionWriter } from '../interaction-writer.js';
import type { FacetInteractionEvent } from '../interaction-writer.js';

// ─── Tests ──────────────────────────────────────────────────────────────

describe('InteractionWriter', () => {
  let writer: InteractionWriter;

  beforeEach(() => {
    vi.clearAllMocks();
    writer = new InteractionWriter();
  });

  describe('writeEvents', () => {
    it('maps FacetInteractionEvent to correct FacetInteractionRow with created_at', () => {
      const events: FacetInteractionEvent[] = [
        {
          tenantId: 'tenant-1',
          indexId: 'index-1',
          userId: 'user-1',
          sessionId: 'session-1',
          attributeType: 'category',
          productType: 'software',
          facetValue: 'IDE',
          interactionType: 'click',
        },
      ];

      writer.writeEvents(events);

      expect(mockInsert).toHaveBeenCalledTimes(1);
      const row = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({
        tenant_id: 'tenant-1',
        index_id: 'index-1',
        user_id: 'user-1',
        session_id: 'session-1',
        attribute_type: 'category',
        product_type: 'software',
        facet_value: 'IDE',
        interaction_type: 'click',
      });
      // created_at should be a ClickHouse-compatible DateTime64 string (no T, no Z)
      expect(row.created_at).toBeDefined();
      expect(typeof row.created_at).toBe('string');
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('maps optional fields to empty strings when undefined', () => {
      const events: FacetInteractionEvent[] = [
        {
          tenantId: 'tenant-1',
          indexId: 'index-1',
          userId: 'user-1',
          sessionId: 'session-1',
          interactionType: 'search',
        },
      ];

      writer.writeEvents(events);

      expect(mockInsert).toHaveBeenCalledTimes(1);
      const row = mockInsert.mock.calls[0][0];
      expect(row.attribute_type).toBe('');
      expect(row.product_type).toBe('');
      expect(row.facet_value).toBe('');
      expect(row.interaction_type).toBe('search');
    });

    it('inserts multiple events in a batch', () => {
      const events: FacetInteractionEvent[] = [
        {
          tenantId: 't1',
          indexId: 'i1',
          userId: 'u1',
          sessionId: 's1',
          attributeType: 'priority',
          productType: 'jira',
          facetValue: 'high',
          interactionType: 'impression',
        },
        {
          tenantId: 't1',
          indexId: 'i1',
          userId: 'u1',
          sessionId: 's1',
          attributeType: 'status',
          productType: 'jira',
          facetValue: 'open',
          interactionType: 'filter',
        },
      ];

      writer.writeEvents(events);

      expect(mockInsert).toHaveBeenCalledTimes(2);
      expect(mockInsert.mock.calls[0][0].interaction_type).toBe('impression');
      expect(mockInsert.mock.calls[1][0].interaction_type).toBe('filter');
    });
  });

  describe('writeEvents when writer is null (fail-open)', () => {
    it('is a no-op when ClickHouse is unavailable', () => {
      const failWriter = new InteractionWriter();
      // Force writer to null to simulate ClickHouse init failure
      (failWriter as any).writer = null;

      // Clear mocks from constructor calls
      mockInsert.mockClear();

      const events: FacetInteractionEvent[] = [
        {
          tenantId: 't1',
          indexId: 'i1',
          userId: 'u1',
          sessionId: 's1',
          attributeType: 'category',
          productType: 'software',
          facetValue: 'IDE',
          interactionType: 'click',
        },
      ];

      // Should not throw
      expect(() => failWriter.writeEvents(events)).not.toThrow();
      // insert should not have been called since writer is null
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('delegates to writer.flush()', async () => {
      await writer.flush();
      expect(mockFlush).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when writer is null', async () => {
      (writer as any).writer = null;
      await expect(writer.flush()).resolves.toBeUndefined();
    });
  });

  describe('close', () => {
    it('delegates to writer.close()', async () => {
      await writer.close();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when writer is null', async () => {
      (writer as any).writer = null;
      await expect(writer.close()).resolves.toBeUndefined();
    });
  });
});
