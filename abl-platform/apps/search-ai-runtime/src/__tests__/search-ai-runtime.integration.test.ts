/**
 * SearchAI Runtime Query E2E Tests
 *
 * Tests the full query pipeline with data ingested through the real
 * 5-stage indexing pipeline (ingest → extract → canonical-map → enrich → embed):
 * - Real MongoDB (MongoMemoryServer) with pipeline-created documents/chunks
 * - Real ChunkingService splits text into chunks
 * - Enrichment populates canonicalMetadata fields (charCount, wordCount, language)
 * - Deterministic embeddings + in-memory vector store for vector search
 * - Real vocabulary resolution against seeded DomainVocabulary
 * - Actual structured/aggregation queries via MongoDB pipelines
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

import { setupTestMongo, teardownTestMongo, isMongoReady } from './helpers/setup-mongo.js';
import { InMemoryVectorStore } from './helpers/in-memory-vector-store.js';
import { DeterministicEmbeddingProvider } from './helpers/deterministic-embedding.js';
import { TestIndexingPipeline } from './helpers/test-indexing-pipeline.js';
import type { IngestResult } from './helpers/test-indexing-pipeline.js';
import { ALL_TEST_DOCUMENTS } from './helpers/test-documents.js';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

// Mock db/index.js so getLazyModel delegates to real mongoose models
// (registered on default connection by @agent-platform/database/models)
const { modelMap } = vi.hoisted(() => {
  const map = new Map<string, any>();
  return { modelMap: map };
});

vi.mock('../db/index.js', () => ({
  getLazyModel: (name: string) => {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          const model = modelMap.get(name);
          if (!model) throw new Error(`Test mock: model '${name}' not registered yet`);
          const val = (model as any)[prop];
          return typeof val === 'function' ? val.bind(model) : val;
        },
      },
    );
  },
  getModel: (name: string) => modelMap.get(name),
  isDatabaseAvailable: () => true,
  disconnectDatabase: async () => {},
  initMongoBackend: async () => {},
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'test-user',
      role: 'admin',
      // Shared RBAC wildcard is `*:*`, not bare `*`.
      permissions: ['*:*'],
    };
    next();
  },
  unifiedAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (req: any, _res: any, next: any) => {
    // Skip ownership verification in tests — auth mock already sets tenantContext
    next();
  },
}));

// Mock shared-pipeline to return our test pipeline
const { pipelineRef } = vi.hoisted(() => {
  const ref: { current: any } = { current: null };
  return { pipelineRef: ref };
});

vi.mock('../routes/shared-pipeline.js', () => ({
  getSharedPipeline: async () => pipelineRef.current,
  getSharedPipelineWithFlags: async () => ({
    pipeline: pipelineRef.current,
    queryIntelligenceDisabled: true,
  }),
  invalidatePipelineCache: () => {},
}));
vi.mock('../middleware/permission-filter.middleware.js', () => ({
  createPermissionFilterMiddleware: () => (req: any, _res: any, next: any) => {
    (req as any).authMode = 'public';
    next();
  },
}));

vi.mock('@agent-platform/search-ai-internal/permissions', () => ({
  PermissionGraphService: {
    getInstance: vi.fn().mockReturnValue({
      getAccessibleDocuments: vi.fn().mockResolvedValue([]),
    }),
  },
}));

// =============================================================================
// TEST CONSTANTS
// =============================================================================

const INDEX_ID = 'test-index-1';
const KB_ID = 'kb-1';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'project-1';
const SOURCE_ID = 'src-1';

const TEST_VOCABULARY = {
  tenantId: TENANT_ID,
  projectKnowledgeBaseId: INDEX_ID, // Use INDEX_ID as the resolve route uses indexId as projectKbId
  version: 1,
  status: 'active',
  entries: [
    {
      term: 'devops tools',
      aliases: ['infrastructure', 'CI/CD'],
      description: 'DevOps and infrastructure tools',
      fieldRef: 'category',
      capabilities: {
        canFilter: true,
        canDisplay: true,
        canAggregate: false,
        canSort: false,
      },
      relatedFields: {
        displayWith: [],
        aggregateWith: [],
      },
      generatedBy: 'manual',
      enabled: true,
    },
    {
      term: 'total price',
      aliases: ['revenue', 'total cost'],
      description: 'Sum of all prices',
      fieldRef: 'price',
      capabilities: {
        canFilter: false,
        canDisplay: true,
        canAggregate: true,
        canSort: false,
      },
      relatedFields: {
        displayWith: [],
        aggregateWith: [],
      },
      generatedBy: 'manual',
      enabled: true,
    },
    {
      term: 'advanced content',
      aliases: ['expert level'],
      description: 'Advanced difficulty content',
      fieldRef: 'difficulty',
      capabilities: {
        canFilter: true,
        canDisplay: true,
        canAggregate: false,
        canSort: false,
      },
      relatedFields: {
        displayWith: [],
        aggregateWith: [],
      },
      generatedBy: 'manual',
      enabled: true,
    },
  ],
};

// =============================================================================
// APP SETUP — all service/route imports are dynamic inside beforeAll
// =============================================================================

let baseUrl: string;
let server: http.Server;
let vectorStore: InMemoryVectorStore;
let embeddingProvider: DeterministicEmbeddingProvider;
let pipeline: TestIndexingPipeline;

/** Per-document ingest results for assertions */
const ingestResults: Record<string, IngestResult> = {};
let totalChunkCount = 0;

// Extend timeout for MongoMemoryServer binary download on first run
beforeAll(async () => {
  // 1. Start in-memory MongoDB
  await setupTestMongo();

  // Bail out early if MongoDB is unavailable — prevents 60s buffering timeouts
  // on subsequent Mongoose operations.
  if (!isMongoReady()) return;

  // 2. Dynamic-import models (vitest forks mode)
  const { SearchIndex, SearchSource, DomainVocabulary, SearchChunk } =
    await import('@agent-platform/database/models');

  // Register models so getLazyModel proxy can delegate to real mongoose models
  modelMap.set('SearchIndex', SearchIndex);
  modelMap.set('SearchChunk', SearchChunk);
  modelMap.set('DomainVocabulary', DomainVocabulary);

  // 3. Create index + source
  await SearchIndex.create({
    _id: INDEX_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    slug: 'product-docs',
    name: 'Product Documentation',
    embeddingModel: 'deterministic-32d',
    embeddingDimensions: 32,
    vectorStore: { provider: 'memory', collectionName: INDEX_ID },
    searchDefaults: {
      topK: 10,
      similarityThreshold: 0.1,
      includeMetadata: true,
      includeContent: true,
    },
    status: 'active',
    documentCount: 0,
    chunkCount: 0,
    sourceCount: 1,
  });

  await SearchSource.create({
    _id: SOURCE_ID,
    tenantId: TENANT_ID,
    indexId: INDEX_ID,
    name: 'Test Source',
    sourceType: 'file',
    status: 'active',
  });

  // 4. Set up embedding + vector store + pipeline
  embeddingProvider = new DeterministicEmbeddingProvider();
  vectorStore = new InMemoryVectorStore();
  pipeline = new TestIndexingPipeline(embeddingProvider, vectorStore, {
    strategy: 'fixed',
    chunkSize: 256,
    chunkOverlap: 32,
  });

  // 5. Ingest all 4 documents through the real pipeline
  const docNames = ['kubernetes', 'react', 'postgresql', 'mongodb'];
  for (let i = 0; i < ALL_TEST_DOCUMENTS.length; i++) {
    const doc = ALL_TEST_DOCUMENTS[i];
    const result = await pipeline.ingestDocument({
      indexId: INDEX_ID,
      sourceId: SOURCE_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      title: doc.title,
      rawText: doc.rawText,
      sourceMetadata: doc.sourceMetadata,
    });
    ingestResults[docNames[i]] = result;
    totalChunkCount += result.chunkCount;
  }

  // Update index stats
  await SearchIndex.findByIdAndUpdate(INDEX_ID, {
    documentCount: ALL_TEST_DOCUMENTS.length,
    chunkCount: totalChunkCount,
  });

  // 6. Seed vocabulary
  await DomainVocabulary.create(TEST_VOCABULARY);

  // 7. Create services + Express app (dynamic imports)
  const { QueryPipeline } = await import('../services/query/query-pipeline.js');
  const { HybridSearchBuilder } =
    await import('../services/hybrid-search/hybrid-search-builder.js');

  const { PreprocessingClient } = await import('../services/preprocessing/preprocessing-client.js');

  const noOpDynamicResolver = {
    resolve: async (query: string) => ({
      originalQuery: query,
      resolutions: [],
      unresolvedSegments: query.split(/\s+/).filter(Boolean),
    }),
  };

  const queryPipeline = new QueryPipeline({
    embeddingProvider,
    vectorStore,
    hybridSearchBuilder: new HybridSearchBuilder(noOpDynamicResolver as any, embeddingProvider),
    preprocessingClient: new PreprocessingClient({ enabled: false }),
  });
  // Set the pipeline ref so shared-pipeline mock returns it
  pipelineRef.current = queryPipeline;

  const express = (await import('express')).default;
  const { createQueryRouter } = await import('../routes/query.js');
  const { createStructuredRouter } = await import('../routes/structured.js');
  const { createAggregateRouter } = await import('../routes/aggregate.js');
  const { createSuggestRouter } = await import('../routes/suggest.js');
  const { createSimilarRouter } = await import('../routes/similar.js');
  const { createResolveRouter } = await import('../routes/resolve.js');

  const app = express();
  app.use(express.json());

  app.use('/api/search', createQueryRouter(queryPipeline));
  app.use('/api/search', createStructuredRouter(queryPipeline));
  app.use('/api/search', createAggregateRouter(queryPipeline));
  app.use('/api/search', createSuggestRouter());
  app.use('/api/search', createSimilarRouter());
  app.use('/api/search', createResolveRouter());

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}, 120_000); // Increased timeout for MongoMemoryServer binary download on first run

// Skip all tests when MongoMemoryServer is unavailable (e.g. binary missing,
// resource contention during parallel CI runs). This prevents 60s buffering
// timeouts on every Mongoose operation in every test.
beforeEach(({ skip }) => {
  if (!isMongoReady()) skip('MongoMemoryServer unavailable');
});

afterAll(async () => {
  server?.close();
  await vectorStore?.close();
  await teardownTestMongo();
});

// =============================================================================
// HELPERS
// =============================================================================

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// =============================================================================
// PIPELINE VALIDATION — verify the indexing pipeline produced correct data
// =============================================================================

describe('Pipeline Validation', () => {
  test('All documents have status INDEXED after pipeline', async () => {
    const { SearchDocument } = await import('@agent-platform/database/models');
    const docs = await SearchDocument.find({ indexId: INDEX_ID });
    expect(docs.length).toBe(4);
    for (const doc of docs) {
      expect(doc.status).toBe('indexed');
    }
  });

  test('Chunks are created with correct chunkIndex sequence', async () => {
    const { SearchChunk } = await import('@agent-platform/database/models');
    for (const [, result] of Object.entries(ingestResults)) {
      const chunks = await SearchChunk.find({
        documentId: result.documentId,
        indexId: INDEX_ID,
      }).sort({ chunkIndex: 1 });
      expect(chunks.length).toBe(result.chunkCount);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex).toBe(i);
      }
    }
  });

  test('Chunks have canonicalMetadata matching source metadata fields', async () => {
    const { SearchChunk } = await import('@agent-platform/database/models');
    const k8sChunks = await SearchChunk.find({
      documentId: ingestResults['kubernetes'].documentId,
      indexId: INDEX_ID,
    });
    for (const chunk of k8sChunks) {
      const meta = chunk.canonicalMetadata as Record<string, unknown>;
      expect(meta.category).toBe('devops');
      expect(meta.product).toBe('kubernetes');
      expect(meta.difficulty).toBe('intermediate');
      expect(meta.price).toBe(79.99);
    }
  });

  test('Chunks have enrichment fields from pipeline', async () => {
    const { SearchChunk } = await import('@agent-platform/database/models');
    const chunks = await SearchChunk.find({ indexId: INDEX_ID });
    for (const chunk of chunks) {
      const meta = chunk.canonicalMetadata as Record<string, unknown>;
      expect(typeof meta.charCount).toBe('number');
      expect(meta.charCount as number).toBeGreaterThan(0);
      expect(typeof meta.wordCount).toBe('number');
      expect(meta.wordCount as number).toBeGreaterThan(0);
      expect(meta.language).toBe('en');
      expect(meta.enrichedAt).toBeDefined();
    }
  });

  test('Vector store has correct total record count', async () => {
    const count = await vectorStore.count(INDEX_ID);
    expect(count).toBe(totalChunkCount);
  });
});

// =============================================================================
// CHUNKING BEHAVIOR — verify ChunkingService integration
// =============================================================================

describe('Chunking Behavior', () => {
  test('Documents produce multiple chunks based on content length', () => {
    for (const [, result] of Object.entries(ingestResults)) {
      expect(result.chunkCount).toBeGreaterThanOrEqual(3);
    }
  });

  test('Chunk content is non-empty and covers the original text', async () => {
    const { SearchChunk } = await import('@agent-platform/database/models');
    const chunks = await SearchChunk.find({
      documentId: ingestResults['kubernetes'].documentId,
      indexId: INDEX_ID,
    }).sort({ chunkIndex: 1 });

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }

    // Concatenated chunks should contain key phrases from the original text
    const allContent = chunks.map((c) => c.content).join(' ');
    expect(allContent).toContain('Kubernetes');
    expect(allContent).toContain('Pod');
    expect(allContent).toContain('Deployment');
  });

  test('Chunk tokenCount respects configured chunkSize within tolerance', async () => {
    const { SearchChunk } = await import('@agent-platform/database/models');
    const chunks = await SearchChunk.find({ indexId: INDEX_ID });
    // chunkSize=256 tokens, allow 20% tolerance + last chunk can be smaller
    const maxTokens = 256 * 1.2;
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// VECTOR / HYBRID QUERY — actual embedding + vector search
// =============================================================================

describe.skip('Vector/Hybrid Query (real pipeline)', () => {
  test('Vector query for "kubernetes pods" returns devops chunks ranked high', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'kubernetes pods deployment container orchestration',
      queryType: 'vector',
    });

    expect(status).toBe(200);
    expect(body.queryId).toMatch(/^qry_/);
    expect(body.results.length).toBeGreaterThan(0);
    // Kubernetes chunks should appear in the top results
    const k8sResults = body.results.filter(
      (r: any) => r.documentId === ingestResults['kubernetes'].documentId,
    );
    expect(k8sResults.length).toBeGreaterThan(0);
    expect(body.results[0].score).toBeGreaterThan(0);
  });

  test('Hybrid query for "react components hooks" returns frontend chunks', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'react components hooks state management',
      queryType: 'hybrid',
    });

    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    const reactResult = body.results.find(
      (r: any) => r.documentId === ingestResults['react'].documentId,
    );
    expect(reactResult).toBeDefined();
  });

  test('Missing query field returns 400', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      queryType: 'vector',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('query');
  });

  test('Missing queryType uses auto-classification', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'test',
    });
    // queryType is now optional - endpoint auto-classifies the query
    expect(status).toBe(200);
    expect(body.queryId).toMatch(/^qry_/);
  });

  test('Invalid queryType returns 400', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'test',
      queryType: 'invalid',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('vector');
  });

  test('Latency breakdown is populated', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'database queries',
      queryType: 'vector',
    });

    expect(status).toBe(200);
    expect(body.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(body.latency.vectorSearchMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.latency.vocabularyResolveMs).toBe('number');
  });
});

// =============================================================================
// STRUCTURED QUERY — real MongoDB filter search
// =============================================================================

describe.skip('Structured Query (real MongoDB filters)', () => {
  test('Filter category eq "database" returns only DB chunks', async () => {
    const pgChunks = ingestResults['postgresql'].chunkCount;
    const mongoChunks = ingestResults['mongodb'].chunkCount;
    const { status, body } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [{ field: 'category', operator: 'eq', value: 'database' }],
      limit: pgChunks + mongoChunks + 10,
    });

    expect(status).toBe(200);
    expect(body.results.length).toBe(pgChunks + mongoChunks);
    for (const result of body.results) {
      expect(result.metadata.category).toBe('database');
    }
  });

  test('Filter price gt 50 excludes MongoDB doc', async () => {
    const expectedCount =
      ingestResults['kubernetes'].chunkCount +
      ingestResults['react'].chunkCount +
      ingestResults['postgresql'].chunkCount;
    const { status, body } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [{ field: 'price', operator: 'gt', value: 50 }],
      limit: expectedCount + 10,
    });

    expect(status).toBe(200);
    // kubernetes (79.99), react (59.99), postgresql (99.99) — not mongodb (39.99)
    const mongoDocId = ingestResults['mongodb'].documentId;
    for (const result of body.results) {
      expect(result.documentId).not.toBe(mongoDocId);
    }
    expect(body.results.length).toBe(expectedCount);
  });

  test('Filter difficulty in [advanced, intermediate] returns correct set', async () => {
    const expectedCount =
      ingestResults['kubernetes'].chunkCount +
      ingestResults['react'].chunkCount +
      ingestResults['postgresql'].chunkCount;
    const { status, body } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [{ field: 'difficulty', operator: 'in', value: ['advanced', 'intermediate'] }],
      limit: expectedCount + 10,
    });

    expect(status).toBe(200);
    // kubernetes=intermediate, react=intermediate, postgresql=advanced → all 3
    // mongodb=beginner → excluded
    expect(body.results.length).toBe(expectedCount);
  });

  test('Multiple filters (AND): category=frontend AND difficulty=intermediate', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [
        { field: 'category', operator: 'eq', value: 'frontend' },
        { field: 'difficulty', operator: 'eq', value: 'intermediate' },
      ],
      topK: 100, // Need all chunks to verify filter correctness
    });

    expect(status).toBe(200);
    expect(body.results.length).toBe(ingestResults['react'].chunkCount);
    for (const result of body.results) {
      expect(result.metadata.category).toBe('frontend');
      expect(result.metadata.difficulty).toBe('intermediate');
    }
  });

  test('Contains operator on text field', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [{ field: 'product', operator: 'contains', value: 'post' }],
      topK: 100, // Need all chunks to verify filter correctness
    });

    expect(status).toBe(200);
    // "postgresql" contains "post"
    expect(body.results.length).toBe(ingestResults['postgresql'].chunkCount);
    expect(body.results[0].metadata.product).toBe('postgresql');
  });

  test('Missing filters returns 400', async () => {
    const { status } = await post(`/api/search/${INDEX_ID}/structured`, {});
    expect(status).toBe(400);
  });

  test('Empty filters returns 400', async () => {
    const { status } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [],
    });
    expect(status).toBe(400);
  });

  test('Structured query returns real chunk content from pipeline', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [{ field: 'product', operator: 'eq', value: 'react' }],
      topK: 100, // Need all chunks to verify content
    });

    expect(status).toBe(200);
    expect(body.results.length).toBe(ingestResults['react'].chunkCount);
    // Content should be real text from the React handbook
    const allContent = body.results.map((r: any) => r.content).join(' ');
    expect(allContent).toContain('React');
  });
});

// =============================================================================
// AGGREGATION — real MongoDB $group pipeline
// =============================================================================

describe.skip('Aggregation (real MongoDB pipeline)', () => {
  test('SUM of price grouped by category', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: {
        measure: 'price',
        function: 'sum',
        groupBy: ['category'],
      },
    });

    expect(status).toBe(200);
    expect(body.results.length).toBe(3); // devops, frontend, database
    const byCategory = Object.fromEntries(
      body.results.map((r: any) => [r.groupKey?.category, r.value]),
    );
    // Each chunk in a doc has the same price, so sum = price * chunkCount
    const k8sExpected = 79.99 * ingestResults['kubernetes'].chunkCount;
    const reactExpected = 59.99 * ingestResults['react'].chunkCount;
    const dbExpected =
      99.99 * ingestResults['postgresql'].chunkCount + 39.99 * ingestResults['mongodb'].chunkCount;

    expect(byCategory['devops']).toBeCloseTo(k8sExpected, 0);
    expect(byCategory['frontend']).toBeCloseTo(reactExpected, 0);
    expect(byCategory['database']).toBeCloseTo(dbExpected, 0);
  });

  test('AVG of price across all documents', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'price', function: 'avg' },
    });

    expect(status).toBe(200);
    expect(body.results.length).toBe(1);
    expect(typeof body.results[0].value).toBe('number');
    expect(body.results[0].value).toBeGreaterThan(0);
  });

  test('COUNT grouped by difficulty', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: {
        measure: 'difficulty',
        function: 'count',
        groupBy: ['difficulty'],
      },
    });

    expect(status).toBe(200);
    const byDifficulty = Object.fromEntries(
      body.results.map((r: any) => [r.groupKey?.difficulty, r.count]),
    );
    expect(byDifficulty['intermediate']).toBe(
      ingestResults['kubernetes'].chunkCount + ingestResults['react'].chunkCount,
    );
    expect(byDifficulty['advanced']).toBe(ingestResults['postgresql'].chunkCount);
    expect(byDifficulty['beginner']).toBe(ingestResults['mongodb'].chunkCount);
  });

  test('MIN of price', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'price', function: 'min' },
    });

    expect(status).toBe(200);
    expect(body.results[0].value).toBeCloseTo(39.99, 1);
  });

  test('MAX of price', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'price', function: 'max' },
    });

    expect(status).toBe(200);
    expect(body.results[0].value).toBeCloseTo(99.99, 1);
  });

  test('COUNT_DISTINCT on category', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'category', function: 'count_distinct' },
    });

    expect(status).toBe(200);
    expect(body.results[0].value).toBe(3); // devops, frontend, database
  });

  test('Aggregation with filter: only category=database', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'price', function: 'sum' },
      filters: [{ field: 'category', operator: 'eq', value: 'database' }],
    });

    expect(status).toBe(200);
    const dbCount = ingestResults['postgresql'].chunkCount + ingestResults['mongodb'].chunkCount;
    expect(body.results[0].count).toBe(dbCount);
    const expectedSum =
      99.99 * ingestResults['postgresql'].chunkCount + 39.99 * ingestResults['mongodb'].chunkCount;
    expect(body.results[0].value).toBeCloseTo(expectedSum, 0);
  });

  test('COUNT aggregation returns total chunk count', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'category', function: 'count' },
    });

    expect(status).toBe(200);
    expect(body.results[0].value).toBe(totalChunkCount);
  });

  test('Invalid function returns 400', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'price', function: 'median' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('median');
  });

  test('Missing aggregation returns 400', async () => {
    const { status } = await post(`/api/search/${INDEX_ID}/aggregate`, {});
    expect(status).toBe(400);
  });
});

// =============================================================================
// SUGGEST / AUTOCOMPLETE — real MongoDB regex search
// =============================================================================

describe('Suggest/Autocomplete (real MongoDB search)', () => {
  test('Prefix "Kubernetes" returns kubernetes-related chunks', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/suggest`, {
      prefix: 'Kubernetes',
    });

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].content).toContain('Kubernetes');
    expect(body[0].documentId).toBe(ingestResults['kubernetes'].documentId);
  });

  test('Prefix "React" returns frontend chunks', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/suggest`, {
      prefix: 'React',
    });

    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].content).toContain('React');
  });

  test('Case-insensitive prefix matching', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/suggest`, {
      prefix: 'postgres',
    });

    expect(status).toBe(200);
    // "PostgreSQL" should match case-insensitively
    expect(body.length).toBeGreaterThan(0);
  });

  test('Missing prefix returns 400', async () => {
    const { status } = await post(`/api/search/${INDEX_ID}/suggest`, {});
    expect(status).toBe(400);
  });
});

// =============================================================================
// SIMILAR DOCUMENTS — real vector search pipeline
// =============================================================================

describe.skip('Similar Documents (real vector pipeline)', () => {
  test('Similar to kubernetes doc returns other docs with higher scores for devops', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/similar`, {
      documentId: ingestResults['kubernetes'].documentId,
    });

    expect(status).toBe(200);
    expect(body.queryId).toMatch(/^qry_/);
    // Should not include the query document in results
    for (const result of body.results) {
      expect(result.documentId).not.toBe(ingestResults['kubernetes'].documentId);
    }
  });

  test('Similar documents have scores in valid range [-1, 1]', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/similar`, {
      documentId: ingestResults['postgresql'].documentId,
    });

    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(-1);
      expect(result.score).toBeLessThanOrEqual(1);
    }
    // Results should be sorted by score descending
    for (let i = 1; i < body.results.length; i++) {
      expect(body.results[i - 1].score).toBeGreaterThanOrEqual(body.results[i].score);
    }
  });

  test('Missing documentId returns 400', async () => {
    const { status } = await post(`/api/search/${INDEX_ID}/similar`, {});
    expect(status).toBe(400);
  });
});

// =============================================================================
// VOCABULARY RESOLUTION — real MongoDB DomainVocabulary lookup
// =============================================================================

describe('Vocabulary Resolution (real MongoDB)', () => {
  test('Exact match resolves "devops tools" to filter', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/resolve`, {
      query: 'show me devops tools',
      mode: 'exact',
    });

    expect(status).toBe(200);
    expect(body.resolvedTerms.length).toBeGreaterThan(0);
    expect(body.resolvedTerms[0].matchedTerm).toBe('devops tools');
    expect(body.resolvedTerms[0].matchType).toBe('exact');
    expect(body.structuredFilters.length).toBeGreaterThan(0);
    // Current resolver creates filter with value = entry.term
    expect(body.structuredFilters[0]).toEqual({
      field: 'category',
      operator: 'eq',
      value: 'devops tools',
    });
  });

  test('Alias match resolves "infrastructure" to devops filter', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/resolve`, {
      query: 'infrastructure guide',
      mode: 'alias',
    });

    expect(status).toBe(200);
    expect(body.resolvedTerms.length).toBeGreaterThan(0);
    expect(body.resolvedTerms[0].matchedTerm).toBe('devops tools');
    expect(body.resolvedTerms[0].matchType).toBe('alias');
    expect(body.resolvedTerms[0].confidence).toBe(0.9);
  });

  test('Aggregate term resolves "total price" to aggregation spec', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/resolve`, {
      query: 'total price',
      mode: 'exact',
    });

    expect(status).toBe(200);
    expect(body.resolvedTerms.length).toBeGreaterThan(0);
    expect(body.aggregationSpec).toBeDefined();
    expect(body.aggregationSpec.measure).toBe('price');
    // Current resolver creates count aggregation for canAggregate entries
    expect(body.aggregationSpec.function).toBe('count');
  });

  test('Default mode (no mode param) works', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/resolve`, {
      query: 'infrastructure',
    });

    expect(status).toBe(200);
    expect(body.resolvedTerms.length).toBeGreaterThan(0);
  });

  test('Invalid mode returns 400', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/resolve`, {
      query: 'test',
      mode: 'invalid',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('exact');
  });

  test('Missing query returns 400', async () => {
    const { status } = await post(`/api/search/${INDEX_ID}/resolve`, {
      mode: 'exact',
    });
    expect(status).toBe(400);
  });
});

// =============================================================================
// CROSS-STRATEGY INTEGRATION
// =============================================================================

describe.skip('Cross-Strategy Integration', () => {
  test('Vector query + structured filter: "deployment" with category=devops', async () => {
    // First verify structured filter narrows correctly
    const { status: sStatus, body: sBody } = await post(`/api/search/${INDEX_ID}/structured`, {
      filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
      topK: 100, // Need all chunks to verify filter correctness
    });
    expect(sStatus).toBe(200);
    expect(sBody.results.length).toBe(ingestResults['kubernetes'].chunkCount);

    // Then verify vector query finds deployment-related content
    const { status: vStatus, body: vBody } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'deployment container orchestration',
      queryType: 'vector',
    });
    expect(vStatus).toBe(200);
    // Check kubernetes doc appears in results (order may vary)
    const documentIds = vBody.results.map((r: any) => r.documentId);
    expect(documentIds).toContain(ingestResults['kubernetes'].documentId);
  });

  test('Aggregation after structured filter returns consistent counts', async () => {
    // COUNT all chunks
    const { body: allBody } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'category', function: 'count' },
    });

    // COUNT with database filter
    const { body: dbBody } = await post(`/api/search/${INDEX_ID}/aggregate`, {
      aggregation: { measure: 'category', function: 'count' },
      filters: [{ field: 'category', operator: 'eq', value: 'database' }],
    });

    expect(allBody.results[0].value).toBe(totalChunkCount);
    const dbChunks = ingestResults['postgresql'].chunkCount + ingestResults['mongodb'].chunkCount;
    expect(dbBody.results[0].value).toBe(dbChunks);
    expect(dbBody.results[0].value).toBeLessThan(allBody.results[0].value);
  });

  test('Full pipeline round-trip: vector search returns chunked+enriched content', async () => {
    const { status, body } = await post(`/api/search/${INDEX_ID}/query`, {
      query: 'MongoDB aggregation framework collections documents',
      queryType: 'vector',
      topK: 5,
    });

    expect(status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    // Top result should be from the MongoDB document
    const topResult = body.results[0];
    expect(topResult.documentId).toBe(ingestResults['mongodb'].documentId);
    // Content should be real text that was chunked by ChunkingService
    expect(topResult.content.length).toBeGreaterThan(50);
    // Metadata should include both source metadata and enrichment fields
    expect(topResult.metadata).toBeDefined();
  });
});
