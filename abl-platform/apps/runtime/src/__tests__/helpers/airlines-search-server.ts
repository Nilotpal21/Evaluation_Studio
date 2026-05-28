/**
 * Airlines Domain Search Server Helper
 *
 * Encapsulates the SearchAI Runtime Express server setup for airline
 * integration testing. Starts a real Express server with MongoDB
 * (MongoMemoryServer), real chunking/embedding pipeline, and all
 * search query routes on an ephemeral port — using airline-specific
 * documents and vocabulary.
 *
 * Follows the same pattern as search-server.ts.
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
import { ALL_AIRLINE_DOCUMENTS } from '../../../../../examples/airlines/search-ai/documents.js';
import { AIRLINE_VOCABULARY } from '../../../../../examples/airlines/search-ai/vocabulary.js';

// =============================================================================
// CONSTANTS
// =============================================================================

export const AIRLINE_INDEX_ID = 'airline-index-1';
export const AIRLINE_KB_ID = 'airline-kb-1';
export const AIRLINE_TENANT_ID = 'airline-tenant-1';
export const AIRLINE_PROJECT_ID = 'airline-project-1';
const AIRLINE_SOURCE_ID = 'airline-src-1';

const AIRLINE_VOCABULARY_ENTRY_CONFIG = {
  'domestic flights': {
    fieldRef: 'route_type',
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: false,
      canSort: false,
    },
    relatedFields: {
      displayWith: ['title'],
      aggregateWith: [],
    },
  },
  'international flights': {
    fieldRef: 'route_type',
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: false,
      canSort: false,
    },
    relatedFields: {
      displayWith: ['title'],
      aggregateWith: [],
    },
  },
  'first class': {
    fieldRef: 'cabin_class',
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: false,
      canSort: false,
    },
    relatedFields: {
      displayWith: ['title'],
      aggregateWith: [],
    },
  },
  'business class': {
    fieldRef: 'cabin_class',
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: false,
      canSort: false,
    },
    relatedFields: {
      displayWith: ['title'],
      aggregateWith: [],
    },
  },
  'economy class': {
    fieldRef: 'cabin_class',
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: false,
      canSort: false,
    },
    relatedFields: {
      displayWith: ['title'],
      aggregateWith: [],
    },
  },
  'total revenue': {
    fieldRef: 'base_fare',
    capabilities: {
      canFilter: false,
      canDisplay: true,
      canAggregate: true,
      canSort: true,
    },
    relatedFields: {
      displayWith: [],
      aggregateWith: ['route_type', 'cabin_class'],
    },
  },
  'average fare': {
    fieldRef: 'base_fare',
    capabilities: {
      canFilter: false,
      canDisplay: true,
      canAggregate: true,
      canSort: true,
    },
    relatedFields: {
      displayWith: [],
      aggregateWith: ['route_type', 'cabin_class'],
    },
  },
} as const;

const AIRLINE_TEST_VOCABULARY = {
  tenantId: AIRLINE_VOCABULARY.tenantId,
  projectKnowledgeBaseId: AIRLINE_VOCABULARY.projectKnowledgeBaseId,
  version: AIRLINE_VOCABULARY.version,
  status: AIRLINE_VOCABULARY.status,
  entries: AIRLINE_VOCABULARY.entries.map((entry) => {
    const config =
      AIRLINE_VOCABULARY_ENTRY_CONFIG[entry.term as keyof typeof AIRLINE_VOCABULARY_ENTRY_CONFIG];

    if (!config) {
      throw new Error(`Unsupported airline vocabulary entry: ${entry.term}`);
    }

    return {
      term: entry.term,
      aliases: entry.aliases,
      description: entry.description,
      fieldRef: config.fieldRef,
      capabilities: config.capabilities,
      relatedFields: config.relatedFields,
      enabled: entry.enabled,
      generatedBy: 'manual' as const,
    };
  }),
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
    appName: 'airlines-search-server-test',
  };
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

export async function startAirlineSearchServer(): Promise<TestSearchServer> {
  // 1. Start in-memory MongoDB
  const mongoUri = await setupTestMongo({ syncIndexes: false });
  if (!mongoUri) {
    throw new Error('MongoMemoryServer unavailable for airline SearchAI test server');
  }

  // 2. Dynamic-import models (vitest forks mode — mongoose singleton per process)
  const { SearchIndex, SearchSource, SearchChunk, DomainVocabulary } =
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
    _id: AIRLINE_INDEX_ID,
    tenantId: AIRLINE_TENANT_ID,
    projectId: AIRLINE_PROJECT_ID,
    slug: 'airline-docs',
    name: 'Airline Documentation',
    embeddingModel: 'deterministic-32d',
    embeddingDimensions: 32,
    vectorStore: { provider: 'memory', collectionName: AIRLINE_INDEX_ID },
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
    _id: AIRLINE_SOURCE_ID,
    tenantId: AIRLINE_TENANT_ID,
    indexId: AIRLINE_INDEX_ID,
    name: 'Airline Source',
    sourceType: 'file',
    status: 'active',
  });

  // 3b. Create a KB-keyed index alias so verifyIndexOwnership passes for vocab resolve
  await SearchIndex.create({
    _id: AIRLINE_KB_ID,
    tenantId: AIRLINE_TENANT_ID,
    projectId: AIRLINE_PROJECT_ID,
    slug: 'airline-kb-alias',
    name: 'Airline KB Alias',
    embeddingModel: 'deterministic-32d',
    embeddingDimensions: 32,
    vectorStore: { provider: 'memory', collectionName: AIRLINE_KB_ID },
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

  // 5. Ingest all 4 airline documents through the real pipeline
  const ingestResults: Record<string, IngestResult> = {};
  let totalChunkCount = 0;
  const docNames = ['operations', 'policy', 'loyalty', 'services'];

  for (let i = 0; i < ALL_AIRLINE_DOCUMENTS.length; i++) {
    const doc = ALL_AIRLINE_DOCUMENTS[i];
    const result = await pipeline.ingestDocument({
      indexId: AIRLINE_INDEX_ID,
      sourceId: AIRLINE_SOURCE_ID,
      tenantId: AIRLINE_TENANT_ID,
      projectId: AIRLINE_PROJECT_ID,
      title: doc.title,
      rawText: doc.rawText,
      sourceMetadata: doc.sourceMetadata,
    });
    ingestResults[docNames[i]] = result;
    totalChunkCount += result.chunkCount;
  }

  // Update index stats
  await SearchIndex.findByIdAndUpdate(AIRLINE_INDEX_ID, {
    documentCount: ALL_AIRLINE_DOCUMENTS.length,
    chunkCount: totalChunkCount,
  });

  // 6. Seed vocabulary for both KB alias routes and direct index query routes.
  await DomainVocabulary.create([
    AIRLINE_TEST_VOCABULARY,
    {
      ...AIRLINE_TEST_VOCABULARY,
      projectKnowledgeBaseId: AIRLINE_INDEX_ID,
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
    // Mirror the production unified search shape closely enough for runtime
    // integration tests without standing up an LLM-backed dynamic resolver.
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

  const app = express();
  app.use(express.json());

  // Inject auth + tenantContext for authMiddleware and verifyIndexOwnership
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 'test-user', email: 'test@test.local', name: 'Test User' };
    req.tenantContext = {
      tenantId: AIRLINE_TENANT_ID,
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

  // 8. Start server on ephemeral port
  const server = await new Promise<http.Server>((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return { baseUrl, server, vectorStore, embeddingProvider, ingestResults, totalChunkCount };
}

export async function stopAirlineSearchServer(ctx?: TestSearchServer): Promise<void> {
  const { disconnectDatabase } = await import('../../../../search-ai-runtime/src/db/index.js');
  ctx?.server?.close();
  await ctx?.vectorStore?.close();
  await disconnectDatabase();
  await teardownTestMongo();
}
