/**
 * Test Search Server Helper
 *
 * Encapsulates the SearchAI Runtime Express server setup for integration testing.
 * Starts a real Express server with MongoDB (MongoMemoryServer), real chunking/embedding
 * pipeline, and all search query routes (including unified /query and /discover) on an
 * ephemeral port.
 *
 * Reuses test helpers from search-ai-runtime for data setup.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import mongoose from 'mongoose';
import type { MongoDBConfig } from '@agent-platform/database';

import {
  setupTestMongo,
  teardownTestMongo,
} from '../../../../search-ai-runtime/src/__tests__/helpers/setup-mongo.js';
import { InMemoryVectorStore } from '../../../../search-ai-runtime/src/__tests__/helpers/in-memory-vector-store.js';
import { DeterministicEmbeddingProvider } from '../../../../search-ai-runtime/src/__tests__/helpers/deterministic-embedding.js';
import { TestIndexingPipeline } from '../../../../search-ai-runtime/src/__tests__/helpers/test-indexing-pipeline.js';
import type { IngestResult } from '../../../../search-ai-runtime/src/__tests__/helpers/test-indexing-pipeline.js';
import { ALL_TEST_DOCUMENTS } from '../../../../search-ai-runtime/src/__tests__/helpers/test-documents.js';

// =============================================================================
// CONSTANTS
// =============================================================================

export const INDEX_ID = 'test-index-1';
export const KB_ID = 'kb-1';
export const TENANT_ID = 'tenant-1';
export const PROJECT_ID = 'project-1';
const SOURCE_ID = 'src-1';

/**
 * Vocabulary using the new schema (fieldRef + capabilities).
 * Matches the DomainVocabulary IVocabularyEntry interface.
 */
const TEST_VOCABULARY = {
  tenantId: TENANT_ID,
  projectKnowledgeBaseId: KB_ID,
  version: 1,
  status: 'active',
  entries: [
    {
      id: 'entry_1',
      term: 'devops tools',
      aliases: ['infrastructure', 'CI/CD'],
      description: 'DevOps and infrastructure tools',
      fieldRef: 'category',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
      relatedFields: { displayWith: ['title'], aggregateWith: [] },
      enabled: true,
      generatedBy: 'manual' as const,
    },
    {
      id: 'entry_2',
      term: 'total price',
      aliases: ['revenue', 'total cost'],
      description: 'Sum of all prices',
      fieldRef: 'price',
      capabilities: { canFilter: false, canDisplay: true, canAggregate: true, canSort: true },
      relatedFields: { displayWith: [], aggregateWith: ['category'] },
      enabled: true,
      generatedBy: 'manual' as const,
    },
    {
      id: 'entry_3',
      term: 'advanced content',
      aliases: ['expert level'],
      description: 'Advanced difficulty content',
      fieldRef: 'difficulty',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
      relatedFields: { displayWith: ['title'], aggregateWith: [] },
      enabled: true,
      generatedBy: 'manual' as const,
    },
    {
      id: 'entry_4',
      term: 'disabled term',
      aliases: [],
      description: 'Should not appear in discovery',
      fieldRef: 'hidden_field',
      capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
      relatedFields: { displayWith: [], aggregateWith: [] },
      enabled: false,
      generatedBy: 'auto' as const,
    },
  ],
};

/**
 * Canonical schema for filter field discovery.
 */
const TEST_SCHEMA = {
  tenantId: TENANT_ID,
  knowledgeBaseId: KB_ID,
  version: 1,
  status: 'active',
  fields: [
    {
      name: 'category',
      label: 'Category',
      type: 'string',
      storageField: 'category',
      filterable: true,
      aggregatable: true,
      sortable: false,
      indexed: true,
      enumValues: {
        devops: 'devops',
        frontend: 'frontend',
        backend: 'backend',
        database: 'database',
      },
    },
    {
      name: 'difficulty',
      label: 'Difficulty',
      type: 'string',
      storageField: 'custom_string_1',
      filterable: true,
      aggregatable: false,
      sortable: true,
      indexed: true,
      enumValues: { beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' },
    },
    {
      name: 'price',
      label: 'Price',
      type: 'number',
      storageField: 'custom_number_1',
      filterable: true,
      aggregatable: true,
      sortable: true,
      indexed: true,
    },
    {
      name: 'title',
      label: 'Title',
      type: 'string',
      storageField: 'title',
      filterable: false,
      aggregatable: false,
      indexed: true,
    },
  ],
};

// =============================================================================
// TYPES
// =============================================================================

export interface TestSearchServer {
  baseUrl: string;
  server: http.Server;
  vectorStore: InMemoryVectorStore;
  embeddingProvider: DeterministicEmbeddingProvider;
  ingestResults: Record<string, IngestResult>;
  totalChunkCount: number;
}

function createSearchAiTestMongoConfig(uri: string, database: string): MongoDBConfig {
  return {
    enabled: true,
    url: uri,
    database,
    minPoolSize: 1,
    maxPoolSize: 5,
    maxIdleTimeMs: 5_000,
    connectTimeoutMs: 5_000,
    socketTimeoutMs: 5_000,
    serverSelectionTimeoutMs: 5_000,
    heartbeatFrequencyMs: 5_000,
    tls: false,
    tlsAllowInvalidCertificates: false,
    authSource: 'admin',
    writeConcern: 'majority',
    readPreference: 'primary',
    retryWrites: true,
    retryReads: true,
    directConnection: true,
    autoIndex: true,
    slowQueryThresholdMs: 1_000,
    appName: 'search-server-test',
  };
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

export async function startTestSearchServer(): Promise<TestSearchServer> {
  // 1. Start in-memory MongoDB
  const mongoUri = await setupTestMongo({ syncIndexes: false });
  if (!mongoUri) {
    throw new Error('MongoMemoryServer unavailable for SearchAI test server');
  }

  // 2. Dynamic-import models (vitest forks mode — mongoose singleton per process)
  const { SearchIndex, SearchSource, SearchChunk, DomainVocabulary, CanonicalSchema } =
    await import('@agent-platform/database/models');
  const { initMongoBackend, disconnectDatabase } =
    await import('../../../../search-ai-runtime/src/db/index.js');
  const databaseName = mongoose.connection.db?.databaseName ?? 'test';

  await disconnectDatabase();
  await initMongoBackend({
    platformDb: createSearchAiTestMongoConfig(mongoUri, databaseName),
    contentDb: createSearchAiTestMongoConfig(mongoUri, databaseName),
  });

  // Ensure the SearchChunk model file is loaded so its SearchAI model definition is registered.
  void SearchChunk;

  // 3. Create search index + source
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

  // 3b. Create a KB-keyed index alias so verifyIndexOwnership passes for vocab resolve
  // and discovery endpoints (they use kbId/indexId as URL path param)
  await SearchIndex.create({
    _id: KB_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    slug: 'kb-alias',
    name: 'KB Alias',
    embeddingModel: 'deterministic-32d',
    embeddingDimensions: 32,
    vectorStore: { provider: 'memory', collectionName: KB_ID },
    searchDefaults: {
      topK: 10,
      similarityThreshold: 0.1,
      includeMetadata: true,
      includeContent: true,
    },
    status: 'active',
    documentCount: 0,
    chunkCount: 0,
    sourceCount: 0,
  });

  // 4. Set up embedding + vector store + pipeline
  const embeddingProvider = new DeterministicEmbeddingProvider();
  const vectorStore = new InMemoryVectorStore();
  const pipeline = new TestIndexingPipeline(embeddingProvider, vectorStore, {
    strategy: 'fixed',
    chunkSize: 256,
    chunkOverlap: 32,
  });

  // 5. Ingest all 4 documents through the real pipeline
  const ingestResults: Record<string, IngestResult> = {};
  let totalChunkCount = 0;
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

  // 6. Seed vocabulary for both KB alias routes and direct index query routes.
  await DomainVocabulary.create([
    TEST_VOCABULARY,
    {
      ...TEST_VOCABULARY,
      projectKnowledgeBaseId: INDEX_ID,
    },
  ]);

  // 6b. Seed canonical schema (for discovery API filter fields)
  await CanonicalSchema.create([
    TEST_SCHEMA,
    {
      ...TEST_SCHEMA,
      knowledgeBaseId: INDEX_ID,
    },
  ]);

  // 7. Create services + Express app (all dynamic imports)
  const { QueryPipeline } =
    await import('../../../../search-ai-runtime/src/services/query/query-pipeline.js');
  const { HybridSearchBuilder } =
    await import('../../../../search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.js');
  const { PreprocessingClient } =
    await import('../../../../search-ai-runtime/src/services/preprocessing/preprocessing-client.js');

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
    // Unified search routes now require a HybridSearchBuilder. For these test
    // servers we only need embedding + DSL generation; static vocab resolution
    // still comes from the seeded DomainVocabulary in Mongo.
    hybridSearchBuilder: new HybridSearchBuilder(noOpDynamicResolver as any, embeddingProvider),
    preprocessingClient: new PreprocessingClient({ enabled: false }),
  });

  const express = (await import('express')).default;
  const { createQueryRouter } = await import('../../../../search-ai-runtime/src/routes/query.js');
  const { createStructuredRouter } =
    await import('../../../../search-ai-runtime/src/routes/structured.js');
  const { createAggregateRouter } =
    await import('../../../../search-ai-runtime/src/routes/aggregate.js');
  const { createSuggestRouter } =
    await import('../../../../search-ai-runtime/src/routes/suggest.js');
  const { createSimilarRouter } =
    await import('../../../../search-ai-runtime/src/routes/similar.js');
  const { createResolveRouter } =
    await import('../../../../search-ai-runtime/src/routes/resolve.js');
  const { createDiscoverRouter } =
    await import('../../../../search-ai-runtime/src/routes/discover.js');

  const app = express();
  app.use(express.json());

  // Inject auth + tenantContext for authMiddleware and verifyIndexOwnership
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 'test-user', email: 'test@test.local', name: 'Test User' };
    req.tenantContext = {
      tenantId: TENANT_ID,
      userId: 'test-user',
      role: 'admin',
      // Shared RBAC wildcard is `*:*`, not bare `*`.
      permissions: ['*:*'],
    };
    next();
  });

  app.use('/api/search', createQueryRouter(queryPipeline));
  app.use('/api/search', createStructuredRouter(queryPipeline));
  app.use('/api/search', createAggregateRouter(queryPipeline));
  app.use('/api/search', createSuggestRouter());
  app.use('/api/search', createSimilarRouter(queryPipeline));
  app.use('/api/search', createResolveRouter());
  app.use('/api/search', createDiscoverRouter());

  // 8. Start server on ephemeral port
  const server = await new Promise<http.Server>((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return { baseUrl, server, vectorStore, embeddingProvider, ingestResults, totalChunkCount };
}

export async function stopTestSearchServer(ctx?: TestSearchServer): Promise<void> {
  const { disconnectDatabase } = await import('../../../../search-ai-runtime/src/db/index.js');
  ctx?.server?.close();
  await ctx?.vectorStore?.close();
  await disconnectDatabase();
  await teardownTestMongo();
}
