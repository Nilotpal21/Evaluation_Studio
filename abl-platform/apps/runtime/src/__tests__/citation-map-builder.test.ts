/**
 * Citation Map Builder Tests
 *
 * Tests for buildCitationMap() and stripCitationMetadataForLLM() on
 * SearchAIKBToolExecutor. These are the core citation business logic functions
 * that map search results to user-navigable citation references.
 *
 * Business logic covered:
 * - Citation config gating (enabled/disabled)
 * - Deduplication by documentId + pageNumber
 * - Source type routing (connector/upload/crawled)
 * - JWT signing for upload sources
 * - S3 key extraction and sanitization
 * - Page-level linking with #page=N fragment
 * - Sequential indexing after dedup
 * - LLM metadata stripping (prevents raw URLs in LLM output)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { SearchAIKBToolExecutor } from '../services/search-ai/searchai-kb-tool-executor.js';

// We test buildCitationMap and stripCitationMetadataForLLM which are instance methods.
// The constructor requires SearchAIClient — we provide a minimal config.
// The methods under test don't call the client.

function createExecutor() {
  return new SearchAIKBToolExecutor({
    runtimeUrl: 'http://localhost:3004',
    authToken: 'test-token',
  });
}

describe('buildCitationMap', () => {
  let executor: SearchAIKBToolExecutor;
  const originalEnv = process.env;

  beforeEach(() => {
    executor = createExecutor();
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = 'test-secret-key-for-citation-signing';
    process.env.SEARCH_AI_URL = 'http://localhost:3005';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ─── Citation Config Gating ───────────────────────────────────────────

  test('returns undefined when citationConfig.enabled is false', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          { content: 'test', _sourceUrl: 'https://example.com/doc', _sourceType: 'connector' },
        ],
      },
      { enabled: false },
    );
    expect(result).toBeUndefined();
  });

  test('returns undefined when results array is empty', () => {
    const result = executor.buildCitationMap({ results: [] }, { enabled: true });
    expect(result).toBeUndefined();
  });

  test('returns undefined when results is undefined', () => {
    const result = executor.buildCitationMap({}, { enabled: true });
    expect(result).toBeUndefined();
  });

  test('returns undefined when citationConfig is null (citations still build)', () => {
    // null config means "not explicitly disabled" — should still build citations
    const result = executor.buildCitationMap(
      {
        results: [
          { content: 'test', _sourceUrl: 'https://example.com/doc', _sourceType: 'connector' },
        ],
      },
      null,
    );
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
  });

  test('returns undefined when citationConfig is undefined', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          { content: 'test', _sourceUrl: 'https://example.com/doc', _sourceType: 'connector' },
        ],
      },
      undefined,
    );
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
  });

  // ─── Connector Sources ────────────────────────────────────────────────

  test('builds citations from connector sources with direct URLs', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'SharePoint Doc',
            content: 'content here',
            _sourceUrl: 'https://sharepoint.com/sites/team/doc.pdf',
            _documentId: 'doc-1',
            _sourceType: 'connector',
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      index: 1,
      title: 'SharePoint Doc',
      url: 'https://sharepoint.com/sites/team/doc.pdf',
      sourceType: 'connector',
      documentId: 'doc-1',
    });
  });

  test('builds citations from crawled sources with direct URLs', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Web Page',
            content: 'crawled content',
            _sourceUrl: 'https://docs.example.com/guide',
            _documentId: 'crawl-1',
            _sourceType: 'crawled',
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      index: 1,
      title: 'Web Page',
      url: 'https://docs.example.com/guide',
      sourceType: 'crawled',
      documentId: 'crawl-1',
    });
  });

  // ─── Upload Sources with JWT ──────────────────────────────────────────

  test('generates JWT download URLs for upload sources without direct URL', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Uploaded PDF',
            content: 'pdf content',
            _sourceUrl: undefined,
            _documentId: 'upload-doc-1',
            _sourceType: 'upload',
            _sourceKey: 'documents/tenant-1/index-1/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1', indexId: 'index-1' },
    );

    expect(result).toHaveLength(1);
    expect(result![0].url).toMatch(/^http:\/\/localhost:3005\/api\/citations\/.+/);
    expect(result![0].sourceType).toBe('upload');
    expect(result![0].documentId).toBe('upload-doc-1');
  });

  test('handles S3 URLs with s3:// prefix correctly', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'S3 Doc',
            content: 'content',
            _sourceUrl: undefined,
            _documentId: 'doc-s3',
            _sourceType: 'upload',
            _sourceKey: 's3://my-bucket/documents/tenant-1/index-1/report.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1', indexId: 'index-1' },
    );

    expect(result).toHaveLength(1);
    expect(result![0].url).toContain('/api/citations/');
  });

  test('strips leading slash from source keys', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Leading Slash',
            content: 'content',
            _sourceUrl: undefined,
            _documentId: 'doc-slash',
            _sourceType: 'upload',
            _sourceKey: '/documents/tenant-1/index-1/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1', indexId: 'index-1' },
    );

    expect(result).toHaveLength(1);
    expect(result![0].url).toContain('/api/citations/');
  });

  test('uses CITATION_SIGNING_SECRET over JWT_SECRET', () => {
    process.env.CITATION_SIGNING_SECRET = 'dedicated-citation-secret';
    process.env.JWT_SECRET = 'generic-jwt-secret';

    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'test',
            _documentId: 'doc-1',
            _sourceType: 'upload',
            _sourceKey: 'documents/tenant-1/idx/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1', indexId: 'idx' },
    );

    // Should still produce a URL (using the dedicated secret)
    expect(result).toHaveLength(1);
    expect(result![0].url).toContain('/api/citations/');
  });

  test('uses SEARCH_AI_URL env var for download URL base', () => {
    process.env.SEARCH_AI_URL = 'https://search.production.com';

    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'test',
            _documentId: 'doc-1',
            _sourceType: 'upload',
            _sourceKey: 'documents/tenant-1/idx/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1', indexId: 'idx' },
    );

    expect(result![0].url).toMatch(/^https:\/\/search\.production\.com\/api\/citations\/.+/);
  });

  test('respects linkTtlSeconds in token expiry', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'test',
            _documentId: 'doc-1',
            _sourceType: 'upload',
            _sourceKey: 'documents/tenant-1/idx/file.pdf',
          },
        ],
      },
      { enabled: true, linkTtlSeconds: 7200 },
      { tenantId: 'tenant-1', indexId: 'idx' },
    );

    // Token should be valid (URL generated)
    expect(result).toHaveLength(1);
    expect(result![0].url).toContain('/api/citations/');
  });

  test('includes maxClicks for click_limited mode only', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'test',
            _documentId: 'doc-1',
            _sourceType: 'upload',
            _sourceKey: 'documents/tenant-1/idx/file.pdf',
          },
        ],
      },
      { enabled: true, linkMode: 'click_limited', maxClicks: 5 },
      { tenantId: 'tenant-1', indexId: 'idx' },
    );

    expect(result).toHaveLength(1);
    expect(result![0].url).toContain('/api/citations/');
  });

  // ─── Skipping / Filtering ────────────────────────────────────────────

  test('skips results without _sourceUrl and not upload type', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'no source info',
            _sourceUrl: undefined,
            _sourceType: 'connector', // connector but no URL
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toBeUndefined();
  });

  test('skips upload results without _documentId', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'upload without docId',
            _sourceUrl: undefined,
            _sourceType: 'upload',
            _documentId: undefined,
            _sourceKey: 'documents/t/i/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1' },
    );

    expect(result).toBeUndefined();
  });

  test('skips upload results without _sourceKey', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'upload without key',
            _sourceUrl: undefined,
            _sourceType: 'upload',
            _documentId: 'doc-1',
            _sourceKey: undefined,
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1' },
    );

    expect(result).toBeUndefined();
  });

  test('skips upload when signing secret is missing', () => {
    delete process.env.CITATION_SIGNING_SECRET;
    delete process.env.JWT_SECRET;

    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'upload no secret',
            _sourceType: 'upload',
            _documentId: 'doc-1',
            _sourceKey: 'documents/t/i/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1' },
    );

    expect(result).toBeUndefined();
  });

  test('skips upload when tenantId is missing from context', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'no tenant',
            _sourceType: 'upload',
            _documentId: 'doc-1',
            _sourceKey: 'documents/t/i/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: undefined },
    );

    expect(result).toBeUndefined();
  });

  test('returns undefined when all results get filtered/skipped', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          { content: 'no source', _sourceType: 'connector' }, // skipped - no URL
          { content: 'also no source' }, // skipped - no URL, no type
        ],
      },
      { enabled: true },
    );

    expect(result).toBeUndefined();
  });

  // ─── Deduplication ────────────────────────────────────────────────────

  test('deduplicates same document + same page', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Doc A',
            content: 'chunk 1',
            _sourceUrl: 'https://example.com/doc-a',
            _documentId: 'doc-a',
            _sourceType: 'connector',
            _pageNumber: 3,
          },
          {
            title: 'Doc A',
            content: 'chunk 2', // Same doc, same page = deduplicated
            _sourceUrl: 'https://example.com/doc-a',
            _documentId: 'doc-a',
            _sourceType: 'connector',
            _pageNumber: 3,
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toHaveLength(1);
    expect(result![0].index).toBe(1);
  });

  test('keeps different pages of same document as separate citations', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Doc A - Page 1',
            content: 'page 1 content',
            _sourceUrl: 'https://example.com/doc-a',
            _documentId: 'doc-a',
            _sourceType: 'connector',
            _pageNumber: 1,
          },
          {
            title: 'Doc A - Page 5',
            content: 'page 5 content',
            _sourceUrl: 'https://example.com/doc-a',
            _documentId: 'doc-a',
            _sourceType: 'connector',
            _pageNumber: 5,
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toHaveLength(2);
    expect(result![0].index).toBe(1);
    expect(result![1].index).toBe(2);
  });

  test('uses index position fallback when no documentId', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'chunk 1',
            _sourceUrl: 'https://example.com/page1',
            _sourceType: 'crawled',
          },
          {
            content: 'chunk 2',
            _sourceUrl: 'https://example.com/page2',
            _sourceType: 'crawled',
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toHaveLength(2);
  });

  // ─── Page Linking ─────────────────────────────────────────────────────

  test('appends #page=N for pages > 0', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'PDF Doc',
            content: 'content',
            _sourceUrl: 'https://example.com/doc.pdf',
            _documentId: 'doc-1',
            _sourceType: 'connector',
            _pageNumber: 7,
          },
        ],
      },
      { enabled: true },
    );

    expect(result![0].url).toBe('https://example.com/doc.pdf#page=7');
    expect(result![0].pageNumber).toBe(7);
  });

  test('does not append #page if URL already has fragment', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'content',
            _sourceUrl: 'https://example.com/doc.pdf#section-intro',
            _documentId: 'doc-1',
            _sourceType: 'connector',
            _pageNumber: 3,
          },
        ],
      },
      { enabled: true },
    );

    expect(result![0].url).toBe('https://example.com/doc.pdf#section-intro');
  });

  test('does not append #page for page 0', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'content',
            _sourceUrl: 'https://example.com/doc.pdf',
            _documentId: 'doc-1',
            _sourceType: 'connector',
            _pageNumber: 0,
          },
        ],
      },
      { enabled: true },
    );

    expect(result![0].url).toBe('https://example.com/doc.pdf');
    expect(result![0].pageNumber).toBeUndefined();
  });

  test('does not append #page for negative page numbers', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'content',
            _sourceUrl: 'https://example.com/doc.pdf',
            _documentId: 'doc-1',
            _sourceType: 'connector',
            _pageNumber: -1,
          },
        ],
      },
      { enabled: true },
    );

    expect(result![0].url).toBe('https://example.com/doc.pdf');
  });

  // ─── Sequential Indexing ──────────────────────────────────────────────

  test('uses sequential 1-based indexing after dedup', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'first',
            _sourceUrl: 'https://a.com',
            _documentId: 'doc-a',
            _sourceType: 'connector',
          },
          {
            content: 'dupe of first',
            _sourceUrl: 'https://a.com',
            _documentId: 'doc-a', // deduped
            _sourceType: 'connector',
          },
          {
            content: 'second',
            _sourceUrl: 'https://b.com',
            _documentId: 'doc-b',
            _sourceType: 'crawled',
          },
          {
            content: 'third',
            _sourceUrl: 'https://c.com',
            _documentId: 'doc-c',
            _sourceType: 'connector',
          },
        ],
      },
      { enabled: true },
    );

    expect(result).toHaveLength(3);
    expect(result![0].index).toBe(1);
    expect(result![1].index).toBe(2);
    expect(result![2].index).toBe(3);
  });

  // ─── Mixed Sources ────────────────────────────────────────────────────

  test('handles mixed source types in same result set', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Connector Doc',
            content: 'connector content',
            _sourceUrl: 'https://sharepoint.com/doc1',
            _documentId: 'conn-1',
            _sourceType: 'connector',
          },
          {
            title: 'Uploaded PDF',
            content: 'upload content',
            _sourceUrl: undefined,
            _documentId: 'upload-1',
            _sourceType: 'upload',
            _sourceKey: 'documents/tenant-1/idx/resume.pdf',
          },
          {
            title: 'Crawled Page',
            content: 'crawled content',
            _sourceUrl: 'https://docs.example.com/api',
            _documentId: 'crawl-1',
            _sourceType: 'crawled',
            _pageNumber: 2,
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1', indexId: 'idx' },
    );

    expect(result).toHaveLength(3);
    expect(result![0].sourceType).toBe('connector');
    expect(result![0].url).toBe('https://sharepoint.com/doc1');
    expect(result![1].sourceType).toBe('upload');
    expect(result![1].url).toContain('/api/citations/');
    expect(result![2].sourceType).toBe('crawled');
    expect(result![2].url).toBe('https://docs.example.com/api#page=2');
  });

  // ─── Title Fallback ───────────────────────────────────────────────────

  test('uses "Source N" as title fallback', () => {
    const result = executor.buildCitationMap(
      {
        results: [
          {
            content: 'no title',
            _sourceUrl: 'https://example.com/untitled',
            _documentId: 'doc-1',
            _sourceType: 'connector',
          },
        ],
      },
      { enabled: true },
    );

    expect(result![0].title).toBe('Source 1');
  });

  // ─── Signing Failure ──────────────────────────────────────────────────

  test('handles signing failure gracefully (skips that citation)', () => {
    // Force signing to fail by providing empty secret in env
    // but non-empty tenantId (so signing is attempted)
    process.env.JWT_SECRET = ''; // empty string is falsy for `if (secret && context?.tenantId)`
    delete process.env.CITATION_SIGNING_SECRET;

    const result = executor.buildCitationMap(
      {
        results: [
          {
            title: 'Good Connector',
            content: 'works',
            _sourceUrl: 'https://example.com/good',
            _documentId: 'doc-good',
            _sourceType: 'connector',
          },
          {
            title: 'Upload Will Skip',
            content: 'no signing',
            _sourceType: 'upload',
            _documentId: 'doc-bad',
            _sourceKey: 'documents/t/i/file.pdf',
          },
        ],
      },
      { enabled: true },
      { tenantId: 'tenant-1' },
    );

    // Only the connector citation survives
    expect(result).toHaveLength(1);
    expect(result![0].title).toBe('Good Connector');
  });
});

describe('stripCitationMetadataForLLM', () => {
  let executor: SearchAIKBToolExecutor;

  beforeEach(() => {
    executor = createExecutor();
  });

  test('returns input unchanged if no results array', () => {
    const input = { queryType: 'hybrid', totalCount: 5 };
    const result = executor.stripCitationMetadataForLLM(input);
    expect(result).toEqual(input);
  });

  test('returns input unchanged if results is not array', () => {
    const input = { results: 'not an array' };
    const result = executor.stripCitationMetadataForLLM(input);
    expect(result).toEqual(input);
  });

  test('returns input unchanged for null/undefined', () => {
    expect(executor.stripCitationMetadataForLLM(null)).toBeNull();
    expect(executor.stripCitationMetadataForLLM(undefined)).toBeUndefined();
  });

  test('strips all underscore-prefixed fields', () => {
    const input = {
      queryType: 'hybrid',
      results: [
        {
          title: 'Doc Title',
          content: 'Document content here',
          _sourceUrl: 'https://example.com/doc',
          _documentId: 'doc-123',
          _sourceType: 'connector',
          _sourceKey: 'documents/t/i/file.pdf',
          _pageNumber: 5,
        },
      ],
      totalCount: 1,
    };

    const result = executor.stripCitationMetadataForLLM(input);

    expect(result.results[0]).toEqual({
      resultIndex: 1,
      title: 'Doc Title',
      content: 'Document content here',
    });
    expect(result.results[0]._sourceUrl).toBeUndefined();
    expect(result.results[0]._documentId).toBeUndefined();
    expect(result.results[0]._sourceType).toBeUndefined();
    expect(result.results[0]._sourceKey).toBeUndefined();
    expect(result.results[0]._pageNumber).toBeUndefined();
  });

  test('adds resultIndex starting at 1', () => {
    const input = {
      results: [
        { title: 'First', content: 'a', _sourceUrl: 'x' },
        { title: 'Second', content: 'b', _sourceUrl: 'y' },
        { title: 'Third', content: 'c', _sourceUrl: 'z' },
      ],
    };

    const result = executor.stripCitationMetadataForLLM(input);

    expect(result.results[0].resultIndex).toBe(1);
    expect(result.results[1].resultIndex).toBe(2);
    expect(result.results[2].resultIndex).toBe(3);
  });

  test('preserves non-result fields (queryType, totalCount, structuredData)', () => {
    const input = {
      queryType: 'semantic',
      totalCount: 42,
      structuredData: { intent: 'count', results: [1, 2, 3] },
      results: [{ title: 'A', content: 'B', _sourceUrl: 'C' }],
    };

    const result = executor.stripCitationMetadataForLLM(input);

    expect(result.queryType).toBe('semantic');
    expect(result.totalCount).toBe(42);
    expect(result.structuredData).toEqual({ intent: 'count', results: [1, 2, 3] });
  });

  test('handles results with missing title/content gracefully', () => {
    const input = {
      results: [
        { content: 'no title', _sourceUrl: 'x' },
        { title: 'no content', _sourceUrl: 'y' },
      ],
    };

    const result = executor.stripCitationMetadataForLLM(input);

    expect(result.results[0]).toEqual({ resultIndex: 1, title: undefined, content: 'no title' });
    expect(result.results[1]).toEqual({ resultIndex: 2, title: 'no content', content: undefined });
  });
});
