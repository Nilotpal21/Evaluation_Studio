/**
 * Query Log Analysis Worker Tests
 *
 * Unit tests for QueryLogAnalysisService and the BullMQ worker.
 * Mocks ClickHouse client and MongoDB models.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterStopwords } from '@agent-platform/search-ai-internal/canonical';

// ─── Mock Setup ───────────────────────────────────────────────────────────

// vi.mock is hoisted above all variable declarations, so we must use
// vi.hoisted() to create the mock fn that the factory references.
const { mockFindOneAndUpdate } = vi.hoisted(() => ({
  mockFindOneAndUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn(() => ({
    findOneAndUpdate: mockFindOneAndUpdate,
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks are set up
const { QueryLogAnalysisService, tokenize } =
  await import('../../services/query-log-analysis/query-log-analysis.service.js');

// ─── Helpers ──────────────────────────────────────────────────────────────

function createMockClickHouseClient(queryTexts: string[]) {
  return {
    query: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(queryTexts.map((qt) => ({ query_text: qt }))),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function generateQueries(term: string, count: number, extraTerms: string[] = []): string[] {
  return Array.from({ length: count }, (_, i) => {
    const extra = extraTerms.length > 0 ? ` ${extraTerms[i % extraTerms.length]}` : '';
    return `${term}${extra} query${i}`;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes punctuation but preserves hyphens', () => {
    expect(tokenize('self-service API!')).toEqual(['self-service', 'api']);
  });

  it('handles multiple spaces', () => {
    expect(tokenize('  foo   bar  ')).toEqual(['foo', 'bar']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles mixed case and numbers', () => {
    expect(tokenize('Error 404 Not Found')).toEqual(['error', '404', 'not', 'found']);
  });
});

describe('filterStopwords', () => {
  it('removes common stopwords', () => {
    const tokens = ['the', 'kubernetes', 'is', 'running', 'in', 'production'];
    const result = filterStopwords(tokens);
    expect(result).toContain('kubernetes');
    expect(result).toContain('running');
    expect(result).toContain('production');
    expect(result).not.toContain('the');
    expect(result).not.toContain('is');
    expect(result).not.toContain('in');
  });

  it('removes single-character tokens', () => {
    const tokens = ['a', 'b', 'kubernetes'];
    const result = filterStopwords(tokens);
    expect(result).toEqual(['kubernetes']);
  });

  it('removes purely numeric tokens', () => {
    const tokens = ['123', 'error', '456'];
    const result = filterStopwords(tokens);
    expect(result).toEqual(['error']);
  });

  it('removes search-specific filler words', () => {
    const tokens = ['show', 'kubernetes', 'find', 'errors'];
    const result = filterStopwords(tokens);
    expect(result).toContain('kubernetes');
    expect(result).toContain('errors');
    expect(result).not.toContain('show');
    expect(result).not.toContain('find');
  });

  it('preserves domain terms', () => {
    const tokens = ['kubernetes', 'deployment', 'replica', 'pod'];
    const result = filterStopwords(tokens);
    expect(result).toEqual(['kubernetes', 'deployment', 'replica', 'pod']);
  });
});

describe('QueryLogAnalysisService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('minimum query threshold', () => {
    it('returns empty result when fewer than minQueryCount queries', async () => {
      const client = createMockClickHouseClient(['query one', 'query two']);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 100,
      });

      expect(result.candidates).toEqual([]);
      expect(result.totalQueries).toBe(2);
      expect(result.uniqueTerms).toBe(0);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('proceeds when query count meets threshold', async () => {
      // Generate 10 queries with "kubernetes" appearing 6 times
      const queries = [
        ...generateQueries('kubernetes deployment', 6),
        ...generateQueries('other stuff here', 4),
      ];
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 5, // Override for testing
        minTermFrequency: 5,
      });

      expect(result.totalQueries).toBe(10);
      expect(result.candidates.length).toBeGreaterThan(0);
    });
  });

  describe('term frequency', () => {
    it('extracts terms meeting minimum frequency threshold', async () => {
      // "kubernetes" appears in 6 queries, "deployment" in 6, "pod" in 3
      const queries = [
        ...generateQueries('kubernetes deployment', 6),
        ...generateQueries('pod scaling', 3),
        ...generateQueries('random words here today', 1),
      ];
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 5,
        minTermFrequency: 5,
      });

      const termNames = result.candidates.map((c) => c.term);
      expect(termNames).toContain('kubernetes');
      expect(termNames).toContain('deployment');
      // "pod" only appears 3 times, below threshold of 5
      expect(termNames).not.toContain('pod');
    });

    it('counts frequency correctly (total occurrences)', async () => {
      // "error" appears twice in some queries
      const queries = [
        'error error debug', // error appears 2x
        'error log',
        'error trace',
        'error metric',
        'error alert',
      ];
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 3,
        minTermFrequency: 5,
      });

      const errorCandidate = result.candidates.find((c) => c.term === 'error');
      expect(errorCandidate).toBeDefined();
      // "error" appears: 2 + 1 + 1 + 1 + 1 = 6 total occurrences
      expect(errorCandidate!.frequency).toBe(6);
      // "error" appears in 5 distinct queries
      expect(errorCandidate!.queryCount).toBe(5);
    });
  });

  describe('co-occurrence', () => {
    it('calculates bidirectional co-occurrence for terms in same query', async () => {
      const queries = [
        'kubernetes deployment error',
        'kubernetes deployment success',
        'kubernetes pod restart',
        'deployment rollback failed',
        'kubernetes monitoring alert',
        'deployment scaling issue',
      ];
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 3,
        minTermFrequency: 2,
      });

      const k8sCandidate = result.candidates.find((c) => c.term === 'kubernetes');
      const deployCandidate = result.candidates.find((c) => c.term === 'deployment');

      if (k8sCandidate && deployCandidate) {
        // kubernetes and deployment co-occur in 2 queries
        const k8sDeployCoOccurrence = k8sCandidate.coOccurrences.find(
          (co) => co.term === 'deployment',
        );
        const deployK8sCoOccurrence = deployCandidate.coOccurrences.find(
          (co) => co.term === 'kubernetes',
        );

        // Bidirectional: both should have the same count
        expect(k8sDeployCoOccurrence?.count).toBe(deployK8sCoOccurrence?.count);
      }
    });
  });

  describe('TTL', () => {
    it('sets expiresAt to 7 days from analysis time', async () => {
      const queries = generateQueries('kubernetes deployment', 10);
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const beforeAnalysis = new Date();

      await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 5,
        minTermFrequency: 5,
      });

      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      const updateDoc = mockFindOneAndUpdate.mock.calls[0][1];
      const expiresAt = updateDoc.expiresAt as Date;

      // expiresAt should be approximately 7 days from now
      const expectedExpiry = new Date(beforeAnalysis);
      expectedExpiry.setDate(expectedExpiry.getDate() + 7);

      const diffMs = Math.abs(expiresAt.getTime() - expectedExpiry.getTime());
      // Allow 5 seconds tolerance
      expect(diffMs).toBeLessThan(5000);
    });
  });

  describe('ClickHouse unavailability', () => {
    it('returns empty result and does not throw when ClickHouse is down', async () => {
      const client = {
        query: vi.fn().mockRejectedValue(new Error('Connection refused')),
        close: vi.fn().mockResolvedValue(undefined),
      } as any;
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
      });

      expect(result.candidates).toEqual([]);
      expect(result.totalQueries).toBe(0);
      expect(result.uniqueTerms).toBe(0);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    it('passes tenantId and indexId to ClickHouse query params', async () => {
      const client = createMockClickHouseClient([]);
      const service = new QueryLogAnalysisService(client);

      await service.analyze({
        tenantId: 'tenant-abc',
        indexId: 'index-xyz',
        knowledgeBaseId: 'kb-1',
      });

      expect(client.query).toHaveBeenCalledTimes(1);
      const queryArgs = client.query.mock.calls[0][0];
      expect(queryArgs.query_params.tenantId).toBe('tenant-abc');
      expect(queryArgs.query_params.indexId).toBe('index-xyz');
    });
  });

  describe('upsert behavior', () => {
    it('calls findOneAndUpdate with upsert for same tenant+index', async () => {
      const queries = generateQueries('kubernetes deployment', 10);
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 5,
        minTermFrequency: 5,
      });

      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter, , options] = mockFindOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ tenantId: 'tenant-1', indexId: 'index-1' });
      expect(options).toEqual({ upsert: true, new: true });
    });
  });

  describe('sample queries', () => {
    it('stores up to 5 sample queries per term', async () => {
      const queries = generateQueries('kubernetes', 10);
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 5,
        minTermFrequency: 5,
      });

      const k8sCandidate = result.candidates.find((c) => c.term === 'kubernetes');
      expect(k8sCandidate).toBeDefined();
      expect(k8sCandidate!.sampleQueries.length).toBeLessThanOrEqual(5);
    });
  });

  describe('fieldAffinity', () => {
    it('sets fieldAffinity to null (set by downstream Story 4.2)', async () => {
      const queries = generateQueries('kubernetes deployment', 10);
      const client = createMockClickHouseClient(queries);
      const service = new QueryLogAnalysisService(client);

      const result = await service.analyze({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        knowledgeBaseId: 'kb-1',
        minQueryCount: 5,
        minTermFrequency: 5,
      });

      for (const candidate of result.candidates) {
        expect(candidate.fieldAffinity).toBeNull();
      }
    });
  });
});
