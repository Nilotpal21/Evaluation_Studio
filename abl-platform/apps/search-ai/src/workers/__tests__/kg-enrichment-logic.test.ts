/**
 * KG Enrichment Worker Logic Tests
 *
 * Tests the key logic patterns in kg-enrichment-worker.ts:
 * 1. Summary field selection (metadata.documentSummary only — LLM required for KG)
 * 2. Chunk extraction input selection (progressiveSummary vs content)
 * 3. MongoDB query filter construction ($and for summary + kgState)
 * 4. OpenSearch metadata deep-merge (canonical.custom.kg nesting)
 *
 * These test the LOGIC, not the full worker (which requires LLM + Neo4j + MongoDB).
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// 1. Summary selection logic (mirrors kg-enrichment-worker.ts)
// KG classification uses ONLY the LLM summary — no fallback to raw text.
// =============================================================================

function selectDocumentSummary(document: {
  metadata?: { documentSummary?: string | null; [key: string]: any } | null;
}): string {
  return (document.metadata?.documentSummary as string) || '';
}

describe('selectDocumentSummary', () => {
  it('reads metadata.documentSummary', () => {
    const doc = {
      metadata: { documentSummary: 'Progressive summary from Docling' },
    };
    expect(selectDocumentSummary(doc)).toBe('Progressive summary from Docling');
  });

  it('returns empty string when metadata.documentSummary is null', () => {
    const doc = { metadata: { documentSummary: null } };
    expect(selectDocumentSummary(doc)).toBe('');
  });

  it('returns empty string when metadata.documentSummary is missing', () => {
    const doc = { metadata: {} };
    expect(selectDocumentSummary(doc)).toBe('');
  });

  it('returns empty string when metadata is null', () => {
    const doc = { metadata: null };
    expect(selectDocumentSummary(doc)).toBe('');
  });

  it('returns empty string when metadata is undefined', () => {
    const doc = {};
    expect(selectDocumentSummary(doc)).toBe('');
  });

  it('returns empty string when metadata.documentSummary is empty string', () => {
    const doc = { metadata: { documentSummary: '' } };
    expect(selectDocumentSummary(doc)).toBe('');
  });
});

// =============================================================================
// 2. Chunk extraction input logic (mirrors kg-enrichment-worker.ts line 385)
// =============================================================================

function selectExtractionInput(chunk: {
  metadata?: { progressiveSummary?: string | null; [key: string]: any } | null;
  content: string;
}): string {
  return (chunk.metadata?.progressiveSummary as string) || chunk.content;
}

describe('selectExtractionInput', () => {
  it('prefers progressiveSummary over raw content', () => {
    const chunk = {
      metadata: { progressiveSummary: 'Condensed summary' },
      content: 'Raw chunk text...',
    };
    expect(selectExtractionInput(chunk)).toBe('Condensed summary');
  });

  it('falls back to content when progressiveSummary is null', () => {
    const chunk = {
      metadata: { progressiveSummary: null },
      content: 'Raw chunk text...',
    };
    expect(selectExtractionInput(chunk)).toBe('Raw chunk text...');
  });

  it('falls back to content when progressiveSummary is missing', () => {
    const chunk = {
      metadata: {},
      content: 'Raw chunk text...',
    };
    expect(selectExtractionInput(chunk)).toBe('Raw chunk text...');
  });

  it('falls back to content when metadata is null', () => {
    const chunk = {
      metadata: null,
      content: 'Raw chunk text...',
    };
    expect(selectExtractionInput(chunk)).toBe('Raw chunk text...');
  });

  it('falls back to content when progressiveSummary is empty string', () => {
    const chunk = {
      metadata: { progressiveSummary: '' },
      content: 'Raw chunk text...',
    };
    expect(selectExtractionInput(chunk)).toBe('Raw chunk text...');
  });
});

// =============================================================================
// 3. MongoDB query construction (mirrors kg-enrichment-worker.ts query filter)
// KG classification requires LLM summary — only metadata.documentSummary.
// =============================================================================

interface QueryOptions {
  forceReclassify?: boolean;
  retrySkipped?: boolean;
  uploadedAfter?: string;
}

function buildDocQuery(
  tenantId: string,
  indexId: string,
  options?: QueryOptions,
  uploadedAfter?: string,
): Record<string, any> {
  const docQuery: any = { tenantId, indexId };

  const summaryFilter = { 'metadata.documentSummary': { $ne: null } };

  if (!options?.forceReclassify) {
    const statusFilter: string[] = ['NOT_ENRICHED'];
    if (options?.retrySkipped) {
      statusFilter.push('SKIPPED');
    }

    docQuery.$and = [
      summaryFilter,
      {
        $or: [
          { 'metadata.kgState.status': { $in: statusFilter } },
          { 'metadata.kgState': { $exists: false } },
        ],
      },
    ];
  } else {
    docQuery.$and = [summaryFilter];
  }

  if (uploadedAfter) {
    docQuery.createdAt = { $gte: new Date(uploadedAfter) };
  }

  return docQuery;
}

describe('buildDocQuery', () => {
  it('builds default query with summary and kgState filters', () => {
    const query = buildDocQuery('tenant-1', 'index-1');

    expect(query.tenantId).toBe('tenant-1');
    expect(query.indexId).toBe('index-1');
    expect(query.$and).toHaveLength(2);

    // Summary filter — only metadata.documentSummary (LLM summary required for KG)
    expect(query.$and[0]).toEqual({ 'metadata.documentSummary': { $ne: null } });

    // kgState filter (default: NOT_ENRICHED only)
    const kgStateOr = query.$and[1].$or;
    expect(kgStateOr).toHaveLength(2);
    expect(kgStateOr[0]).toEqual({ 'metadata.kgState.status': { $in: ['NOT_ENRICHED'] } });
    expect(kgStateOr[1]).toEqual({ 'metadata.kgState': { $exists: false } });
  });

  it('includes SKIPPED status when retrySkipped is true', () => {
    const query = buildDocQuery('tenant-1', 'index-1', { retrySkipped: true });

    const kgStateOr = query.$and[1].$or;
    expect(kgStateOr[0]).toEqual({
      'metadata.kgState.status': { $in: ['NOT_ENRICHED', 'SKIPPED'] },
    });
  });

  it('uses only summary filter when forceReclassify is true', () => {
    const query = buildDocQuery('tenant-1', 'index-1', { forceReclassify: true });

    expect(query.$and).toHaveLength(1);
    expect(query.$and[0]).toEqual({ 'metadata.documentSummary': { $ne: null } });
  });

  it('adds createdAt filter when uploadedAfter is provided', () => {
    const query = buildDocQuery('tenant-1', 'index-1', undefined, '2026-01-01T00:00:00Z');

    expect(query.createdAt).toEqual({ $gte: new Date('2026-01-01T00:00:00Z') });
    expect(query.$and).toHaveLength(2); // Summary + kgState still present
  });

  it('does not have conflicting $or at top level', () => {
    const query = buildDocQuery('tenant-1', 'index-1');

    // No top-level $or — kgState $or is inside $and
    expect(query.$or).toBeUndefined();
    expect(query.$and).toBeDefined();
  });
});

// =============================================================================
// 4. OpenSearch metadata deep-merge (mirrors kg-enrichment-worker.ts lines 425-452)
// =============================================================================

interface KGClassification {
  primaryProduct: string;
  secondaryProducts: string[];
  confidence: number;
  department: string;
  category: string;
}

function buildMergedMetadata(
  existingMetadata: Record<string, any> | undefined,
  classification: KGClassification,
): Record<string, any> {
  const existingMeta = (existingMetadata || {}) as Record<string, any>;
  const existingCanonical = (existingMeta.canonical || {}) as Record<string, any>;
  const existingCustom = (existingCanonical.custom || {}) as Record<string, any>;

  return {
    ...existingMeta,
    canonical: {
      ...existingCanonical,
      custom: {
        ...existingCustom,
        kg: {
          primaryProduct: classification.primaryProduct,
          secondaryProducts: classification.secondaryProducts,
          confidence: classification.confidence,
          department: classification.department,
          category: classification.category,
          kgEnriched: true,
          kgEnrichedAt: new Date().toISOString(),
        },
      },
    },
  };
}

describe('buildMergedMetadata', () => {
  const classification: KGClassification = {
    primaryProduct: 'credit_card',
    secondaryProducts: ['personal_loan'],
    confidence: 0.95,
    department: 'Card Services',
    category: 'Cards',
  };

  it('preserves existing sys and doc metadata', () => {
    const existing = {
      sys: { tenantId: 't-1', appId: 'idx-1', documentId: 'doc-1', chunkId: 'chk-1' },
      doc: { name: 'test.pdf', contentType: 'application/pdf' },
      canonical: { title: 'Test Document' },
    };

    const result = buildMergedMetadata(existing, classification);

    expect(result.sys).toEqual(existing.sys);
    expect(result.doc).toEqual(existing.doc);
    expect(result.canonical.title).toBe('Test Document');
    expect(result.canonical.custom.kg.primaryProduct).toBe('credit_card');
  });

  it('does NOT write flat tenantId/indexId/documentId', () => {
    const existing = {
      sys: { tenantId: 't-1', appId: 'idx-1' },
      doc: {},
      canonical: {},
    };

    const result = buildMergedMetadata(existing, classification);

    // No flat fields at root level
    expect(result.tenantId).toBeUndefined();
    expect(result.indexId).toBeUndefined();
    expect(result.documentId).toBeUndefined();
    expect(result.primaryProduct).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  it('handles undefined existing metadata', () => {
    const result = buildMergedMetadata(undefined, classification);

    expect(result.canonical.custom.kg.primaryProduct).toBe('credit_card');
    expect(result.canonical.custom.kg.confidence).toBe(0.95);
    expect(result.canonical.custom.kg.kgEnriched).toBe(true);
  });

  it('handles empty existing metadata', () => {
    const result = buildMergedMetadata({}, classification);

    expect(result.canonical.custom.kg.primaryProduct).toBe('credit_card');
  });

  it('handles existing metadata without canonical', () => {
    const existing = { sys: { tenantId: 't-1' }, doc: { name: 'test.pdf' } };
    const result = buildMergedMetadata(existing, classification);

    expect(result.sys.tenantId).toBe('t-1');
    expect(result.doc.name).toBe('test.pdf');
    expect(result.canonical.custom.kg.primaryProduct).toBe('credit_card');
  });

  it('preserves existing canonical.custom fields', () => {
    const existing = {
      canonical: {
        title: 'Test',
        custom: { otherData: { foo: 'bar' } },
      },
    };

    const result = buildMergedMetadata(existing, classification);

    expect(result.canonical.title).toBe('Test');
    expect(result.canonical.custom.otherData).toEqual({ foo: 'bar' });
    expect(result.canonical.custom.kg.primaryProduct).toBe('credit_card');
  });

  it('overwrites previous KG data on re-enrichment', () => {
    const existing = {
      canonical: {
        custom: {
          kg: {
            primaryProduct: 'mortgage',
            confidence: 0.6,
            kgEnriched: true,
            kgEnrichedAt: '2026-01-01T00:00:00Z',
          },
        },
      },
    };

    const result = buildMergedMetadata(existing, classification);

    expect(result.canonical.custom.kg.primaryProduct).toBe('credit_card');
    expect(result.canonical.custom.kg.confidence).toBe(0.95);
    expect(result.canonical.custom.kg.kgEnrichedAt).not.toBe('2026-01-01T00:00:00Z');
  });

  it('includes all classification fields', () => {
    const result = buildMergedMetadata({}, classification);
    const kg = result.canonical.custom.kg;

    expect(kg.primaryProduct).toBe('credit_card');
    expect(kg.secondaryProducts).toEqual(['personal_loan']);
    expect(kg.confidence).toBe(0.95);
    expect(kg.department).toBe('Card Services');
    expect(kg.category).toBe('Cards');
    expect(kg.kgEnriched).toBe(true);
    expect(kg.kgEnrichedAt).toBeDefined();
  });
});
