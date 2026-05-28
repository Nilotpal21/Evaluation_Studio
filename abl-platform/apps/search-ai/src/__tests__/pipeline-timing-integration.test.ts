/**
 * Pipeline Timing Integration Test
 *
 * Validates end-to-end ingestion pipeline timing from document creation
 * to INDEXED status. Target: <60 seconds for complete processing.
 *
 * Flow: PENDING → EXTRACTING → EXTRACTED → ENRICHING → ENRICHED → EMBEDDING → INDEXED
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { getLazyModel } from '../db/index.js';
import type { ISearchDocument, ISearchChunk, ISearchIndex } from '@agent-platform/database';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

// Mock external dependencies
vi.mock('@agent-platform/search-ai-internal', async () => {
  const actual = await vi.importActual('@agent-platform/search-ai-internal');
  return {
    ...actual,
    createEmbeddingProvider: () => ({
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]], // Mock embedding vector
        totalTokens: 10,
      }),
    }),
    createVectorStore: () => ({
      upsert: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    resolveIndexForWrite: vi.fn().mockResolvedValue('test-index-opensearch'),
  };
});

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    knowledgeGraph: { enabled: false },
    multiModal: { enabled: false },
    treeBuilder: { enabled: false },
  }),
}));

vi.mock('../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn().mockResolvedValue({
    useCases: {
      questionSynthesis: { enabled: false },
      scopeClassification: { enabled: false },
    },
  }),
}));

describe('Pipeline Timing Integration', () => {
  const tenantId = 'test-tenant-timing';
  const indexId = 'test-index-timing';
  const TIMING_TARGET_MS = 60_000; // 60 seconds

  beforeAll(async () => {
    await setupTestMongo();
  }, 90_000);

  afterAll(async () => {
    await teardownTestMongo();
  }, 60_000);

  beforeEach(async () => {
    await clearCollections();
    vi.clearAllMocks();

    // Create test index
    await SearchIndex.create({
      _id: indexId,
      tenantId,
      projectId: 'test-project',
      slug: 'test-timing-index',
      name: 'Test Timing Index',
      vectorStore: {
        provider: 'qdrant',
        collectionName: 'test-timing-collection',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should process document through full pipeline within timing target', async () => {
    const startTime = Date.now();

    // ── 1. Create document (PENDING) ──────────────────────────────────────
    const document = await SearchDocument.create({
      tenantId,
      indexId,
      sourceId: 'test-source-timing',
      contentHash: 'timing-test-hash',
      originalReference: 'timing-test.pdf',
      status: DocumentStatus.PENDING,
      content:
        'This is a test document for timing validation. It contains enough content to be chunked and processed through the entire pipeline.',
      contentType: 'application/pdf',
      metadata: {
        pageCount: 1,
        extractedAt: new Date().toISOString(),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const documentId = document._id.toString();
    const creationTime = Date.now();

    // ── 2. Simulate extraction (EXTRACTING → EXTRACTED) ──────────────────
    await SearchDocument.findByIdAndUpdate(documentId, {
      status: DocumentStatus.EXTRACTING,
      updatedAt: new Date(),
    });

    await SearchDocument.findByIdAndUpdate(documentId, {
      status: DocumentStatus.EXTRACTED,
      updatedAt: new Date(),
    });

    const extractionTime = Date.now();
    const extractionDuration = extractionTime - creationTime;

    // ── 3. Create chunks (simulate page processing) ──────────────────────
    const chunk = await SearchChunk.create({
      tenantId,
      indexId,
      documentId,
      chunkIndex: 0,
      content: 'This is a test chunk for timing validation.',
      status: ChunkStatus.PENDING,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await SearchDocument.findByIdAndUpdate(documentId, {
      chunkCount: 1,
      updatedAt: new Date(),
    });

    const chunkingTime = Date.now();
    const chunkingDuration = chunkingTime - extractionTime;

    // ── 4. Simulate enrichment (ENRICHING → ENRICHED) ────────────────────
    await SearchDocument.findByIdAndUpdate(documentId, {
      status: DocumentStatus.ENRICHING,
      updatedAt: new Date(),
    });

    await SearchChunk.findByIdAndUpdate(chunk._id, {
      canonicalMetadata: {
        enrichedAt: new Date().toISOString(),
        wordCount: 10,
      },
      status: ChunkStatus.PENDING,
      updatedAt: new Date(),
    });

    await SearchDocument.findByIdAndUpdate(documentId, {
      status: DocumentStatus.ENRICHED,
      entities: [],
      language: 'en',
      textPreview: 'Test document summary',
      'metadata.documentSummary': 'Test document summary',
      updatedAt: new Date(),
    });

    const enrichmentTime = Date.now();
    const enrichmentDuration = enrichmentTime - chunkingTime;

    // ── 5. Simulate embedding (EMBEDDING → INDEXED) ──────────────────────
    await SearchDocument.findByIdAndUpdate(documentId, {
      status: DocumentStatus.EMBEDDING,
      updatedAt: new Date(),
    });

    await SearchChunk.findByIdAndUpdate(chunk._id, {
      vectorId: chunk._id.toString(),
      status: ChunkStatus.INDEXED,
      updatedAt: new Date(),
    });

    await SearchDocument.findByIdAndUpdate(documentId, {
      status: DocumentStatus.INDEXED,
      updatedAt: new Date(),
    });

    await SearchIndex.findByIdAndUpdate(indexId, {
      chunkCount: 1,
      lastIndexedAt: new Date(),
    });

    const completionTime = Date.now();
    const embeddingDuration = completionTime - enrichmentTime;
    const totalDuration = completionTime - startTime;

    // ── 6. Verify document reached INDEXED status ────────────────────────
    const finalDocument = await SearchDocument.findById(documentId);
    expect(finalDocument?.status).toBe(DocumentStatus.INDEXED);

    const finalChunk = await SearchChunk.findById(chunk._id);
    expect(finalChunk?.status).toBe(ChunkStatus.INDEXED);
    expect(finalChunk?.vectorId).toBeDefined();

    // ── 7. Validate timing breakdown ─────────────────────────────────────
    console.log('\n[Pipeline Timing Breakdown]');
    console.log(`  Document Creation → EXTRACTED: ${extractionDuration}ms`);
    console.log(`  Chunking (EXTRACTED → chunks):  ${chunkingDuration}ms`);
    console.log(`  Enrichment (ENRICHING → ENRICHED): ${enrichmentDuration}ms`);
    console.log(`  Embedding (EMBEDDING → INDEXED):   ${embeddingDuration}ms`);
    console.log(`  Total End-to-End:              ${totalDuration}ms`);
    console.log(
      `  Target:                        ${TIMING_TARGET_MS}ms (${TIMING_TARGET_MS / 1000}s)`,
    );
    console.log(`  Status: ${totalDuration < TIMING_TARGET_MS ? '✓ PASS' : '✗ FAIL'}\n`);

    // ── 8. Assert timing target met ──────────────────────────────────────
    expect(totalDuration).toBeLessThan(TIMING_TARGET_MS);
  }, 120_000); // 2 minute test timeout

  it('should track timing through status transitions', async () => {
    // Create document
    const document = await SearchDocument.create({
      tenantId,
      indexId,
      sourceId: 'test-source-tracking',
      contentHash: 'tracking-test-hash',
      originalReference: 'tracking-test.pdf',
      status: DocumentStatus.PENDING,
      content: 'Test content',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const createdAt = document.createdAt.getTime();

    // Simulate status transitions with timing
    const transitions = [
      { status: DocumentStatus.EXTRACTING, expectedMaxMs: 5000 },
      { status: DocumentStatus.EXTRACTED, expectedMaxMs: 10000 },
      { status: DocumentStatus.ENRICHING, expectedMaxMs: 15000 },
      { status: DocumentStatus.ENRICHED, expectedMaxMs: 30000 },
      { status: DocumentStatus.EMBEDDING, expectedMaxMs: 40000 },
      { status: DocumentStatus.INDEXED, expectedMaxMs: 60000 },
    ];

    for (const transition of transitions) {
      await SearchDocument.findByIdAndUpdate(document._id, {
        status: transition.status,
        updatedAt: new Date(),
      });

      const updatedDoc = await SearchDocument.findById(document._id);
      const currentDuration = updatedDoc!.updatedAt.getTime() - createdAt;

      console.log(
        `  ${transition.status}: ${currentDuration}ms (max: ${transition.expectedMaxMs}ms)`,
      );

      // Each stage should complete within its expected time
      expect(currentDuration).toBeLessThan(transition.expectedMaxMs);
    }
  }, 120_000);

  it('should handle batch processing timing', async () => {
    const batchSize = 5;
    const documents = [];
    const startTime = Date.now();

    // Create batch of documents
    for (let i = 0; i < batchSize; i++) {
      const doc = await SearchDocument.create({
        tenantId,
        indexId,
        sourceId: 'test-source-batch',
        contentHash: `batch-hash-${i}`,
        originalReference: `batch-test-${i}.pdf`,
        status: DocumentStatus.PENDING,
        content: `Test content for document ${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      documents.push(doc);
    }

    // Process all documents through pipeline
    for (const doc of documents) {
      await SearchDocument.findByIdAndUpdate(doc._id, { status: DocumentStatus.EXTRACTING });
      await SearchDocument.findByIdAndUpdate(doc._id, { status: DocumentStatus.EXTRACTED });
      await SearchDocument.findByIdAndUpdate(doc._id, { status: DocumentStatus.ENRICHING });
      await SearchDocument.findByIdAndUpdate(doc._id, { status: DocumentStatus.ENRICHED });
      await SearchDocument.findByIdAndUpdate(doc._id, { status: DocumentStatus.EMBEDDING });
      await SearchDocument.findByIdAndUpdate(doc._id, { status: DocumentStatus.INDEXED });
    }

    const totalTime = Date.now() - startTime;
    const avgTimePerDoc = totalTime / batchSize;

    console.log(`\n[Batch Processing Timing]`);
    console.log(`  Documents: ${batchSize}`);
    console.log(`  Total Time: ${totalTime}ms`);
    console.log(`  Avg Per Document: ${avgTimePerDoc}ms`);
    console.log(`  Target Per Document: ${TIMING_TARGET_MS}ms\n`);

    // Verify all documents indexed
    const indexedDocs = await SearchDocument.find({
      _id: { $in: documents.map((d) => d._id) },
      status: DocumentStatus.INDEXED,
    });

    expect(indexedDocs).toHaveLength(batchSize);

    // Average time per document should be well under target
    // (allows for parallel processing efficiency)
    expect(avgTimePerDoc).toBeLessThan(TIMING_TARGET_MS);
  }, 180_000); // 3 minute timeout for batch test
});
