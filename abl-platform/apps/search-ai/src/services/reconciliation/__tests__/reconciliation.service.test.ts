import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAttributeRegistry } from '@agent-platform/database/models';
import type { EmbeddingProvider } from '@agent-platform/search-ai-internal/embedding';

// Mock the database models (lazy-imported inside reconciliation service)
const mockFind = vi.fn();
const mockDistinct = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AttributeRegistry: {
    find: (...args: unknown[]) => ({
      lean: () => mockFind(...args),
    }),
    distinct: (...args: unknown[]) => mockDistinct(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  AttributeMergeEvent: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

// Suppress logger output in tests
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ReconciliationService } from '../reconciliation.service.js';

/**
 * Create a minimal IAttributeRegistry stub.
 */
function makeAttr(overrides: Partial<IAttributeRegistry>): IAttributeRegistry {
  return {
    _id: overrides._id ?? 'attr-' + Math.random().toString(36).slice(2, 8),
    tenantId: 'tenant-1',
    indexId: 'index-1',
    attributeId: overrides.attributeId ?? 'test_attr',
    productScope: overrides.productScope ?? 'credit_card',
    tier: overrides.tier ?? 'novel',
    displayName: overrides.displayName ?? 'Test',
    dataType: overrides.dataType ?? 'string',
    aliases: overrides.aliases ?? [],
    extractionPatterns: overrides.extractionPatterns ?? [],
    documentCount: overrides.documentCount ?? 10,
    confidence: overrides.confidence ?? 0.7,
    definition: overrides.definition ?? 'A test attribute',
    firstSeenAt: overrides.firstSeenAt,
  } as IAttributeRegistry;
}

/**
 * Build a mock EmbeddingProvider that returns fixed-dimension embeddings.
 */
function makeMockEmbeddingProvider(embedFn?: (texts: string[]) => number[][]): EmbeddingProvider {
  return {
    name: 'mock',
    modelId: 'mock-model',
    dimensions: 3,
    maxBatchSize: 100,
    embed: vi.fn(async () => [1, 0, 0]),
    embedBatch: vi.fn(async (texts: string[]) => ({
      embeddings: embedFn ? embedFn(texts) : texts.map(() => [1, 0, 0]),
      totalTokens: texts.length * 10,
      model: 'mock-model',
      dimensions: 3,
    })),
    estimateTokens: vi.fn(() => 10),
    healthCheck: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
  };
}

describe('ReconciliationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockCreate.mockResolvedValue({});
  });

  it('returns zero-result for empty novel list', async () => {
    const provider = makeMockEmbeddingProvider();
    const service = new ReconciliationService(provider);

    mockFind.mockResolvedValue([]);
    mockDistinct.mockResolvedValue(['credit_card']);

    const results = await service.reconcileIndex('tenant-1', 'index-1');
    expect(results).toHaveLength(1);
    expect(results[0].mergedIntoExisting).toBe(0);
    expect(results[0].clustered).toBe(0);
    expect(results[0].promoted).toBe(0);
    expect(results[0].discarded).toBe(0);
  });

  it('merges novel matching existing canonical (cosine above threshold)', async () => {
    const novel = makeAttr({
      _id: 'novel-1',
      attributeId: 'annual_rate',
      tier: 'novel',
      documentCount: 10,
    });
    const existing = makeAttr({
      _id: 'existing-1',
      attributeId: 'interest_rate',
      tier: 'approved',
      documentCount: 100,
    });

    // Embeddings: novel and existing are identical => cosine = 1.0 > 0.85 threshold
    const provider = makeMockEmbeddingProvider((texts: string[]) => texts.map(() => [1, 0, 0]));
    const service = new ReconciliationService(provider);

    // First find call: novels, second: existing, third: remaining novels (post-merge)
    mockFind
      .mockResolvedValueOnce([novel]) // novels
      .mockResolvedValueOnce([existing]) // existing canonical
      .mockResolvedValueOnce([]); // remaining novels after merge

    const result = await service.reconcile('tenant-1', 'index-1', 'credit_card');
    expect(result.mergedIntoExisting).toBe(1);
    // Should have called updateOne to add alias and discard novel
    expect(mockUpdateOne).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });

  it('clusters multiple novels together and elects canonical', async () => {
    const novel1 = makeAttr({
      _id: 'n1',
      attributeId: 'contactless_pay',
      tier: 'novel',
      documentCount: 30,
    });
    const novel2 = makeAttr({
      _id: 'n2',
      attributeId: 'tap_payment',
      tier: 'novel',
      documentCount: 50,
    });

    // Embeddings: both novels identical, no existing to match
    const provider = makeMockEmbeddingProvider((texts: string[]) => texts.map(() => [1, 0, 0]));
    const service = new ReconciliationService(provider);

    mockFind
      .mockResolvedValueOnce([novel1, novel2]) // novels
      .mockResolvedValueOnce([]) // no existing
      .mockResolvedValueOnce([]); // remaining (all clustered away)

    const result = await service.reconcile('tenant-1', 'index-1', 'credit_card');
    expect(result.clustered).toBe(2);
  });

  it('promotes standalone novel above promotion thresholds', async () => {
    const novel = makeAttr({
      _id: 'n1',
      attributeId: 'annual_fee',
      tier: 'novel',
      documentCount: 60,
      confidence: 0.9,
    });

    // Embeddings unique so no match with existing
    const provider = makeMockEmbeddingProvider();
    const service = new ReconciliationService(provider);

    mockFind
      .mockResolvedValueOnce([novel]) // novels
      .mockResolvedValueOnce([]) // no existing
      .mockResolvedValueOnce([novel]); // remaining: the standalone novel

    const result = await service.reconcile('tenant-1', 'index-1', 'credit_card');
    expect(result.promoted).toBe(1);
  });

  it('discards standalone novel below discard threshold (when old enough)', async () => {
    const novel = makeAttr({
      _id: 'n1',
      attributeId: 'rare_attr',
      tier: 'novel',
      documentCount: 2, // below discardDocCountMax=5
      confidence: 0.3,
      firstSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago — past age gate
    });

    const provider = makeMockEmbeddingProvider();
    const service = new ReconciliationService(provider);

    mockFind
      .mockResolvedValueOnce([novel]) // novels
      .mockResolvedValueOnce([]) // no existing
      .mockResolvedValueOnce([novel]); // remaining

    const result = await service.reconcile('tenant-1', 'index-1', 'credit_card');
    expect(result.discarded).toBe(1);
  });

  it('fails open when embedding provider throws', async () => {
    const novel = makeAttr({ _id: 'n1', attributeId: 'test_attr', tier: 'novel' });

    const provider = makeMockEmbeddingProvider();
    (provider.embedBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('API timeout'),
    );

    const service = new ReconciliationService(provider);

    mockFind
      .mockResolvedValueOnce([novel]) // novels
      .mockResolvedValueOnce([]); // existing

    const result = await service.reconcile('tenant-1', 'index-1', 'credit_card');
    // Should return early with zero results (fail-open)
    expect(result.mergedIntoExisting).toBe(0);
    expect(result.clustered).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.discarded).toBe(0);
  });
});
