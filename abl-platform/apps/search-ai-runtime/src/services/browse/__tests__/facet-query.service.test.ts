import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DOC_ID_THRESHOLD } from '../types.js';

// ─── Mock Dependencies ──────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: mockQuery,
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import AFTER mocks are set up
import { FacetQueryService } from '../facet-query.service.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Create a mock ClickHouse result set */
function mockResult<T>(rows: T[]) {
  return { json: vi.fn().mockResolvedValue(rows) };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('FacetQueryService', () => {
  let service: FacetQueryService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set env so constructor creates the client
    process.env.CLICKHOUSE_URL = 'http://localhost:8123';
    service = new FacetQueryService();
  });

  describe('getFacetValues', () => {
    it('returns grouped values with counts', async () => {
      // First call: values query
      mockQuery.mockResolvedValueOnce(
        mockResult([
          {
            attribute_type: 'priority',
            product_type: 'jira_issue',
            data_type: 'string',
            value: 'High',
            count: '42',
          },
          {
            attribute_type: 'priority',
            product_type: 'jira_issue',
            data_type: 'string',
            value: 'Medium',
            count: '28',
          },
        ]),
      );
      // Second call: count query
      mockQuery.mockResolvedValueOnce(mockResult([{ total: '2' }]));

      const result = await service.getFacetValues('t1', 'idx1', 'priority', 'jira_issue');

      expect(result.attributeType).toBe('priority');
      expect(result.productType).toBe('jira_issue');
      expect(result.dataType).toBe('string');
      expect(result.values).toEqual([
        { value: 'High', count: 42 },
        { value: 'Medium', count: 28 },
      ]);
      expect(result.total).toBe(2);
    });

    it('includes tenant_id and index_id in query params', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await service.getFacetValues('tenant_abc', 'idx_xyz', 'status');

      expect(mockQuery).toHaveBeenCalledOnce();
      const call = mockQuery.mock.calls[0][0];
      expect(call.query_params.tenantId).toBe('tenant_abc');
      expect(call.query_params.indexId).toBe('idx_xyz');
    });

    it('uses FINAL modifier in query', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await service.getFacetValues('t1', 'idx1', 'priority');

      const call = mockQuery.mock.calls[0][0];
      expect(call.query).toContain('FINAL');
    });

    it('returns empty result when no rows returned', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      const result = await service.getFacetValues('t1', 'idx1', 'priority');

      expect(result.values).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('returns empty result on ClickHouse error (fail-open)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await service.getFacetValues('t1', 'idx1', 'priority');

      expect(result.values).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('adds productType clause when provided', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await service.getFacetValues('t1', 'idx1', 'priority', 'jira_issue');

      const call = mockQuery.mock.calls[0][0];
      expect(call.query).toContain('product_type');
      expect(call.query_params.productType).toBe('jira_issue');
    });
  });

  describe('getDocumentsByFacet', () => {
    it('returns document IDs with truncation flag', async () => {
      // Two parallel queries: doc IDs + count
      mockQuery
        .mockResolvedValueOnce(mockResult([{ document_id: 'doc1' }, { document_id: 'doc2' }]))
        .mockResolvedValueOnce(mockResult([{ total: '2' }]));

      const result = await service.getDocumentsByFacet('t1', 'idx1', 'priority', 'High');

      expect(result.documentIds).toEqual(['doc1', 'doc2']);
      expect(result.total).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it('sets truncated: true when total > DOC_ID_THRESHOLD', async () => {
      const bigTotal = DOC_ID_THRESHOLD + 1;
      mockQuery
        .mockResolvedValueOnce(mockResult([{ document_id: 'doc1' }]))
        .mockResolvedValueOnce(mockResult([{ total: String(bigTotal) }]));

      const result = await service.getDocumentsByFacet('t1', 'idx1', 'priority', 'High');

      expect(result.truncated).toBe(true);
      expect(result.total).toBe(bigTotal);
    });

    it('sets truncated: false when total <= DOC_ID_THRESHOLD', async () => {
      mockQuery
        .mockResolvedValueOnce(mockResult([{ document_id: 'doc1' }]))
        .mockResolvedValueOnce(mockResult([{ total: String(DOC_ID_THRESHOLD) }]));

      const result = await service.getDocumentsByFacet('t1', 'idx1', 'priority', 'High');

      expect(result.truncated).toBe(false);
    });

    it('includes tenant_id and index_id in query params', async () => {
      mockQuery
        .mockResolvedValueOnce(mockResult([]))
        .mockResolvedValueOnce(mockResult([{ total: '0' }]));

      await service.getDocumentsByFacet('tenant_abc', 'idx_xyz', 'status', 'Open');

      // Both doc query and count query should have tenant/index params
      expect(mockQuery).toHaveBeenCalledTimes(2);
      for (const call of mockQuery.mock.calls) {
        expect(call[0].query_params.tenantId).toBe('tenant_abc');
        expect(call[0].query_params.indexId).toBe('idx_xyz');
      }
    });

    it('uses FINAL modifier in both queries', async () => {
      mockQuery
        .mockResolvedValueOnce(mockResult([]))
        .mockResolvedValueOnce(mockResult([{ total: '0' }]));

      await service.getDocumentsByFacet('t1', 'idx1', 'priority', 'High');

      for (const call of mockQuery.mock.calls) {
        expect(call[0].query).toContain('FINAL');
      }
    });

    it('returns empty result on ClickHouse error (fail-open)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Timeout'));

      const result = await service.getDocumentsByFacet('t1', 'idx1', 'priority', 'High');

      expect(result.documentIds).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.truncated).toBe(false);
    });
  });

  describe('getFacetCountsForDocuments', () => {
    it('returns facet counts for document IDs', async () => {
      mockQuery.mockResolvedValueOnce(
        mockResult([
          { attribute_type: 'priority', product_type: 'jira_issue', count: '15' },
          { attribute_type: 'status', product_type: 'jira_issue', count: '10' },
        ]),
      );

      const result = await service.getFacetCountsForDocuments('t1', 'idx1', ['doc1', 'doc2']);

      expect(result).toEqual([
        { attributeType: 'priority', productType: 'jira_issue', count: 15 },
        { attributeType: 'status', productType: 'jira_issue', count: 10 },
      ]);
    });

    it('includes tenant_id and index_id in query params', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await service.getFacetCountsForDocuments('tenant_abc', 'idx_xyz', ['doc1']);

      const call = mockQuery.mock.calls[0][0];
      expect(call.query_params.tenantId).toBe('tenant_abc');
      expect(call.query_params.indexId).toBe('idx_xyz');
    });

    it('passes document IDs as array parameter', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await service.getFacetCountsForDocuments('t1', 'idx1', ['doc1', 'doc2', 'doc3']);

      const call = mockQuery.mock.calls[0][0];
      expect(call.query_params.documentIds).toEqual(['doc1', 'doc2', 'doc3']);
    });

    it('uses FINAL modifier in query', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await service.getFacetCountsForDocuments('t1', 'idx1', ['doc1']);

      const call = mockQuery.mock.calls[0][0];
      expect(call.query).toContain('FINAL');
    });

    it('returns empty array for empty documentIds', async () => {
      const result = await service.getFacetCountsForDocuments('t1', 'idx1', []);

      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns empty array on ClickHouse error (fail-open)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection reset'));

      const result = await service.getFacetCountsForDocuments('t1', 'idx1', ['doc1']);

      expect(result).toEqual([]);
    });
  });

  describe('missing ClickHouse client', () => {
    it('returns empty results when ClickHouse is not configured', async () => {
      // Remove env vars and create a new service
      delete process.env.CLICKHOUSE_URL;
      delete process.env.CLICKHOUSE_HOST;
      const noChService = new FacetQueryService();

      const facetValues = await noChService.getFacetValues('t1', 'idx1', 'priority');
      expect(facetValues.values).toEqual([]);

      const docs = await noChService.getDocumentsByFacet('t1', 'idx1', 'priority', 'High');
      expect(docs.documentIds).toEqual([]);

      const counts = await noChService.getFacetCountsForDocuments('t1', 'idx1', ['doc1']);
      expect(counts).toEqual([]);

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
