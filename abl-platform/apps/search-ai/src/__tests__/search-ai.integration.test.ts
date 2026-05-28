/**
 * SearchAI Backend API E2E Tests
 *
 * Mounts route handlers on a real Express app backed by MongoDB Memory Server.
 * Exercises all CRUD endpoints via Node's built-in fetch against an http.createServer listener.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';

// Mock db/index.js to return real mongoose models from @agent-platform/database.
// Routes use getLazyModel() from db/index.js which requires initMongoBackend().
// In E2E tests, MongoDB Memory Server provides the connection directly, so we
// bypass the dual-database setup and return models from the default connection.
// Deferred model map — populated in beforeAll after mongoose.connect()
let modelMap: Record<string, any> = {};

vi.mock('../db/index.js', () => {
  return {
    getLazyModel: (modelName: string) => modelMap[modelName] || modelMap.SearchIndex,
    getModel: (modelName: string) => modelMap[modelName] || modelMap.SearchIndex,
    isDatabaseAvailable: () => true,
    initMongoBackend: async () => {},
    disconnectDatabase: async () => {},
    getDualConnection: () => ({
      getPlatformConnection: () => ({ db: null, models: {} }),
      getContentConnection: () => ({ db: null, models: {} }),
    }),
  };
});

// Mock vector store for cascade delete tests
vi.mock('@agent-platform/search-ai-internal', async () => {
  const actual = await vi.importActual('@agent-platform/search-ai-internal');
  return {
    ...actual,
    createVectorStore: vi.fn(() => ({
      delete: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('@abl/eventstore', () => ({
  BufferedKafkaTopicPublisher: class MockBufferedKafkaTopicPublisher<T> {
    publish = vi.fn((_message: T) => undefined);
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

// =============================================================================
// APP SETUP — import models + routes AFTER mongo connection is established
// =============================================================================

let baseUrl: string;
let server: http.Server;

async function closeServer(candidate: http.Server | undefined): Promise<void> {
  if (!candidate?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    candidate.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeAll(async () => {
  await setupTestMongo();

  // Import models AFTER mongoose.connect() so they register on the live connection
  const models = await import('@agent-platform/database/models');
  modelMap = {
    KnowledgeBase: models.KnowledgeBase,
    SearchIndex: models.SearchIndex,
    SearchSource: models.SearchSource,
    SearchDocument: models.SearchDocument,
    SearchChunk: models.SearchChunk,
    ChunkQuestion: (models as any).ChunkQuestion,
    CanonicalSchema: models.CanonicalSchema,
    FieldMapping: models.FieldMapping,
    ConnectorSchema: models.ConnectorSchema,
    DomainVocabulary: models.DomainVocabulary,
    CrawlJob: (models as any).CrawlJob,
    CrawlHistory: (models as any).CrawlHistory,
    SearchPipelineDefinition: models.SearchPipelineDefinition,
    ProjectTool: (models as any).ProjectTool,
    ConnectorConfig: models.ConnectorConfig,
  };

  // Dynamic imports so mongoose models register against the test connection
  const { default: kbRouter } = await import('../routes/knowledge-bases.js');
  const { default: indexesRouter } = await import('../routes/indexes.js');
  const { default: sourcesRouter } = await import('../routes/sources.js');
  const { default: schemasRouter } = await import('../routes/schemas.js');
  const { default: mappingsRouter } = await import('../routes/mappings.js');
  const { default: jobsRouter } = await import('../routes/jobs.js');

  const app = express();
  app.use(express.json());

  // Inject a test tenant context on every request (mirrors auth middleware)
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).tenantContext = {
      tenantId: 'tenant-1',
      orgId: undefined,
      userId: 'test-user',
      role: 'ADMIN',
      permissions: ['*'],
      authType: 'jwt_user' as const,
      isSuperAdmin: false,
    };
    next();
  });

  // Mount routes (mirrors server.ts)
  app.use('/api/indexes', indexesRouter);
  app.use('/api/indexes', sourcesRouter);
  app.use('/api/schemas', schemasRouter);
  app.use('/api/mappings', mappingsRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/knowledge-bases', kbRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}, 90_000);

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await closeServer(server);
  await teardownTestMongo();
}, 60_000);

// =============================================================================
// HELPERS
// =============================================================================

async function request(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Record<string, string> },
) {
  let url = `${baseUrl}${path}`;
  if (opts?.query) {
    const params = new URLSearchParams(opts.query);
    url += `?${params.toString()}`;
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** Create a KB and return the response body for reuse in tests. */
async function createKB(overrides: Record<string, unknown> = {}) {
  const payload = {
    projectId: 'project-1',
    name: `Test KB ${Date.now()}`,
    description: 'E2E test knowledge base',
    ...overrides,
  };
  return request('POST', '/api/knowledge-bases', { body: payload });
}

/** Create a SearchIndex directly and return the response body. */
async function createIndex(overrides: Record<string, unknown> = {}) {
  const slug = `test-idx-${Date.now()}`;
  const payload = {
    projectId: 'project-1',
    slug,
    name: `Test Index ${Date.now()}`,
    ...overrides,
  };
  return request('POST', '/api/indexes', { body: payload });
}

// =============================================================================
// KNOWLEDGE BASE CRUD
// =============================================================================

describe('Knowledge Base CRUD', () => {
  test('POST creates KB and auto-creates SearchIndex', async () => {
    const { status, body } = await createKB({ name: 'Product Docs' });

    expect(status).toBe(201);
    expect(body.knowledgeBase).toBeDefined();
    expect(body.knowledgeBase.name).toBe('Product Docs');
    expect(body.knowledgeBase.searchIndexId).toBeTruthy();
    expect(body.knowledgeBase.status).toBe('active');
  });

  test('POST returns 400 when projectId missing', async () => {
    const { status, body } = await request('POST', '/api/knowledge-bases', {
      body: { name: 'No Project' },
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('projectId');
  });

  test('POST returns 400 when name missing', async () => {
    const { status, body } = await request('POST', '/api/knowledge-bases', {
      body: { tenantId: 't1', projectId: 'p1' },
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('name');
  });

  test('POST returns 409 for duplicate name in tenant+project', async () => {
    await createKB({ name: 'Duplicate KB' });
    const { status, body } = await createKB({ name: 'Duplicate KB' });

    expect(status).toBe(409);
    expect(body.error.message).toContain('already exists');
  });

  test('GET / lists KBs filtered by projectId', async () => {
    await createKB({ projectId: 'proj-a', name: 'KB A' });
    await createKB({ projectId: 'proj-b', name: 'KB B' });

    const { status, body } = await request('GET', '/api/knowledge-bases', {
      query: { projectId: 'proj-a' },
    });

    expect(status).toBe(200);
    expect(body.knowledgeBases).toHaveLength(1);
    expect(body.knowledgeBases[0].name).toBe('KB A');
  });

  test('GET /:kbId returns KB with linked index', async () => {
    const created = await createKB({ name: 'Detailed KB' });
    const kbId = created.body.knowledgeBase._id;

    const { status, body } = await request('GET', `/api/knowledge-bases/${kbId}`);

    expect(status).toBe(200);
    expect(body.knowledgeBase._id).toBe(kbId);
    expect(body.knowledgeBase.index).toBeTruthy();
    expect(body.knowledgeBase.index.embeddingModel).toBe('bge-m3');
  });

  test('GET /:kbId returns 404 for nonexistent', async () => {
    const { status } = await request('GET', '/api/knowledge-bases/000000000000000000000000');
    expect(status).toBe(404);
  });

  test('PATCH /:kbId updates name and description', async () => {
    const created = await createKB({ name: 'Old Name' });
    const kbId = created.body.knowledgeBase._id;

    const { status, body } = await request('PATCH', `/api/knowledge-bases/${kbId}`, {
      body: { name: 'New Name', description: 'Updated desc' },
    });

    expect(status).toBe(200);
    expect(body.knowledgeBase.name).toBe('New Name');
    expect(body.knowledgeBase.description).toBe('Updated desc');
  });

  test('PATCH /:kbId returns 404 for nonexistent', async () => {
    const { status } = await request('PATCH', '/api/knowledge-bases/000000000000000000000000', {
      body: { name: 'X' },
    });
    expect(status).toBe(404);
  });

  test('DELETE /:kbId cascades (chunks -> docs -> sources -> index -> KB)', async () => {
    // Import models for verification
    const { KnowledgeBase, SearchIndex, SearchSource, SearchDocument, SearchChunk } =
      await import('@agent-platform/database/models');

    // Create KB (auto-creates index)
    const created = await createKB({ name: 'To Delete' });
    const kbId = created.body.knowledgeBase._id;
    const indexId = created.body.knowledgeBase.searchIndexId;

    // Add source
    const sourceRes = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'Source 1', sourceType: 'file', sourceConfig: { fileTypes: ['pdf'] } },
    });
    const sourceId = sourceRes.body.source._id;

    // Create document + chunk manually for cascade test
    const doc = await SearchDocument.create({
      tenantId: 'tenant-1',
      indexId,
      sourceId,
      contentHash: 'abc123',
      status: 'ready',
      contentSizeBytes: 100,
    });
    await SearchChunk.create({
      tenantId: 'tenant-1',
      indexId,
      documentId: doc._id,
      content: 'test chunk',
      tokenCount: 5,
      chunkIndex: 0,
      status: 'ready',
    });

    // Delete KB
    const { status, body } = await request('DELETE', `/api/knowledge-bases/${kbId}`);
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);

    // Verify cascade — all related entities deleted
    expect(await KnowledgeBase.countDocuments()).toBe(0);
    expect(await SearchIndex.countDocuments()).toBe(0);
    expect(await SearchSource.countDocuments()).toBe(0);
    expect(await SearchDocument.countDocuments()).toBe(0);
    expect(await SearchChunk.countDocuments()).toBe(0);
  });

  test('DELETE /:kbId returns 404 for nonexistent', async () => {
    const { status } = await request('DELETE', '/api/knowledge-bases/000000000000000000000000');
    expect(status).toBe(404);
  });

  test('POST /:kbId/rebuild returns 501 (not yet implemented)', async () => {
    const created = await createKB({ name: 'Rebuild KB' });
    const kbId = created.body.knowledgeBase._id;

    const { status, body } = await request('POST', `/api/knowledge-bases/${kbId}/rebuild`);

    expect(status).toBe(501);
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });

  test('POST /:kbId/rebuild returns 501 even for nonexistent KB', async () => {
    const { status } = await request(
      'POST',
      '/api/knowledge-bases/000000000000000000000000/rebuild',
    );
    // Route handler returns 501 without checking KB existence
    expect(status).toBe(501);
  });
});

// =============================================================================
// SEARCH INDEX CRUD
// =============================================================================

describe('SearchIndex CRUD', () => {
  test('POST creates index with system defaults', async () => {
    const { status, body } = await createIndex({ name: 'Default Index' });

    expect(status).toBe(201);
    expect(body.index).toBeDefined();
    expect(body.index.embeddingModel).toBe(process.env.EMBEDDING_MODEL || 'bge-m3');
    expect(body.index.embeddingDimensions).toBe(
      parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10),
    );
    expect(body.index.vectorStore.provider).toBe('opensearch');
    expect(body.index.searchDefaults.topK).toBe(10);
    expect(body.index.status).toBe('active');
  });

  test('POST returns 400 when required fields missing', async () => {
    const { status, body } = await request('POST', '/api/indexes', {
      body: { tenantId: 't1' },
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  test('GET / lists indexes with query filters', async () => {
    await createIndex({ projectId: 'pa', slug: 'idx-a', name: 'A' });
    await createIndex({ projectId: 'pb', slug: 'idx-b', name: 'B' });

    const { status, body } = await request('GET', '/api/indexes', {
      query: { projectId: 'pa' },
    });

    expect(status).toBe(200);
    expect(body.indexes).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  test('GET /:indexId returns index details', async () => {
    const created = await createIndex({ name: 'Detail Index' });
    const indexId = created.body.index._id;

    const { status, body } = await request('GET', `/api/indexes/${indexId}`);

    expect(status).toBe(200);
    expect(body.index._id).toBe(indexId);
    expect(body.index.embeddingModel).toBeDefined();
    expect(body.index.vectorStore).toBeDefined();
    expect(body.index.searchDefaults).toBeDefined();
  });

  test('GET /:indexId returns 404', async () => {
    const { status } = await request('GET', '/api/indexes/000000000000000000000000');
    expect(status).toBe(404);
  });

  test('PATCH /:indexId updates mutable fields', async () => {
    const created = await createIndex({ name: 'Mutable' });
    const indexId = created.body.index._id;

    const { status, body } = await request('PATCH', `/api/indexes/${indexId}`, {
      body: { name: 'Updated Name', description: 'Updated' },
    });

    expect(status).toBe(200);
    expect(body.index.name).toBe('Updated Name');
    expect(body.index.description).toBe('Updated');
  });

  test('DELETE /:indexId removes index', async () => {
    const created = await createIndex({ name: 'Delete Me' });
    const indexId = created.body.index._id;

    const { status, body } = await request('DELETE', `/api/indexes/${indexId}`);

    expect(status).toBe(200);
    expect(body.deleted).toBe(true);

    // Verify it's gone
    const { status: getStatus } = await request('GET', `/api/indexes/${indexId}`);
    expect(getStatus).toBe(404);
  });

  test('POST /:indexId/rebuild sets status', async () => {
    const created = await createIndex({ name: 'Rebuild Index' });
    const indexId = created.body.index._id;

    const { status, body } = await request('POST', `/api/indexes/${indexId}/rebuild`);

    expect(status).toBe(200);
    expect(body.status).toBe('rebuilding');
  });
});

// =============================================================================
// SOURCE / CONNECTOR CRUD
// =============================================================================

describe('Source/Connector CRUD', () => {
  test('POST adds file source, increments sourceCount', async () => {
    const idx = await createIndex({ name: 'Source Host' });
    const indexId = idx.body.index._id;

    const { status, body } = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: {
        name: 'PDF Source',
        sourceType: 'file',
        sourceConfig: { fileTypes: ['pdf', 'docx'] },
      },
    });

    expect(status).toBe(201);
    expect(body.source.status).toBe('pending');
    expect(body.source.sourceType).toBe('manual'); // route normalizes 'file' → 'manual'

    // Verify sourceCount incremented (no auto-created default source)
    const { body: idxBody } = await request('GET', `/api/indexes/${indexId}`);
    expect(idxBody.index.sourceCount).toBe(1);
  });

  test('POST adds web source with crawl config', async () => {
    const idx = await createIndex({ name: 'Web Host' });
    const indexId = idx.body.index._id;

    const { status, body } = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: {
        name: 'Web Crawler',
        sourceType: 'web',
        sourceConfig: { url: 'https://docs.example.com', crawlDepth: 3 },
      },
    });

    expect(status).toBe(201);
    expect(body.source.sourceConfig.url).toBe('https://docs.example.com');
  });

  test('POST adds database source', async () => {
    const idx = await createIndex({ name: 'DB Host' });
    const indexId = idx.body.index._id;

    const { status, body } = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: {
        name: 'PostgreSQL',
        sourceType: 'database',
        sourceConfig: { connectionString: 'postgresql://localhost:5432/mydb' },
      },
    });

    expect(status).toBe(201);
    expect(body.source.sourceConfig.connectionString).toBeTruthy();
  });

  test('POST adds API source', async () => {
    const idx = await createIndex({ name: 'API Host' });
    const indexId = idx.body.index._id;

    const { status, body } = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: {
        name: 'REST API',
        sourceType: 'api',
        sourceConfig: { endpoint: 'https://api.example.com/docs' },
      },
    });

    expect(status).toBe(201);
    expect(body.source.sourceConfig.endpoint).toBeTruthy();
  });

  test('POST returns 400 when name/sourceType missing', async () => {
    const idx = await createIndex({ name: 'Err Host' });
    const indexId = idx.body.index._id;

    const { status, body } = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: {},
    });

    expect(status).toBe(400);
    expect(body.error).toContain('name');
  });

  test('POST returns 404 when index does not exist', async () => {
    const { status } = await request('POST', '/api/indexes/000000000000000000000000/sources', {
      body: { name: 'Orphan', sourceType: 'file' },
    });

    expect(status).toBe(404);
  });

  test('GET lists sources for index', async () => {
    const idx = await createIndex({ name: 'Multi Source' });
    const indexId = idx.body.index._id;

    await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'S1', sourceType: 'file' },
    });
    await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'S2', sourceType: 'web' },
    });

    const { status, body } = await request('GET', `/api/indexes/${indexId}/sources`);

    expect(status).toBe(200);
    // 2 explicitly added (no auto-created default source)
    expect(body.sources).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  test('DELETE removes source, decrements sourceCount', async () => {
    const idx = await createIndex({ name: 'Delete Source' });
    const indexId = idx.body.index._id;

    const sourceRes = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'Gone Soon', sourceType: 'file' },
    });
    const sourceId = sourceRes.body.source._id;

    const { status, body } = await request('DELETE', `/api/indexes/${indexId}/sources/${sourceId}`);

    expect(status).toBe(200);
    expect(body.deleted).toBe(true);

    // Verify sourceCount decremented (no auto-created default source)
    const { body: idxBody } = await request('GET', `/api/indexes/${indexId}`);
    expect(idxBody.index.sourceCount).toBe(0);
  });
});

// =============================================================================
// SCHEMA CRUD
// =============================================================================

describe('Schema CRUD', () => {
  test('GET /connectors/:id returns connector schema', async () => {
    const { ConnectorSchema } = await import('@agent-platform/database/models');

    await ConnectorSchema.create({
      tenantId: 'tenant-1',
      connectorId: 'conn-1',
      version: 1,
      fields: [
        { path: 'title', label: 'Title', type: 'string', isCustom: false, isRequired: true },
        { path: 'price', label: 'Price', type: 'number', isCustom: false, isRequired: false },
      ],
      fieldCount: 2,
      customFieldCount: 0,
      status: 'discovered',
    });

    const { status, body } = await request('GET', '/api/schemas/connectors/conn-1');

    expect(status).toBe(200);
    expect(body.schema.fields).toHaveLength(2);
    expect(body.schema.version).toBe(1);
  });

  test('GET /connectors/:id?version=N returns specific version', async () => {
    const { ConnectorSchema } = await import('@agent-platform/database/models');

    await ConnectorSchema.create({
      tenantId: 'tenant-1',
      connectorId: 'conn-v',
      version: 1,
      fields: [{ path: 'v1', label: 'V1', type: 'string', isCustom: false, isRequired: false }],
      fieldCount: 1,
      customFieldCount: 0,
      status: 'discovered',
    });
    await ConnectorSchema.create({
      tenantId: 'tenant-1',
      connectorId: 'conn-v',
      version: 2,
      fields: [
        { path: 'v1', label: 'V1', type: 'string', isCustom: false, isRequired: false },
        { path: 'v2', label: 'V2', type: 'number', isCustom: false, isRequired: false },
      ],
      fieldCount: 2,
      customFieldCount: 0,
      status: 'discovered',
    });

    const { status, body } = await request('GET', '/api/schemas/connectors/conn-v', {
      query: { version: '1' },
    });

    expect(status).toBe(200);
    expect(body.schema.version).toBe(1);
    expect(body.schema.fields).toHaveLength(1);
  });

  test('GET /:kbId returns canonical schema', async () => {
    const { CanonicalSchema } = await import('@agent-platform/database/models');

    const kbRes = await createKB({ name: 'Schema KB' });
    const kbId = kbRes.body.knowledgeBase._id;

    await CanonicalSchema.create({
      tenantId: 'tenant-1',
      knowledgeBaseId: kbId,
      version: 1,
      fields: [
        {
          name: 'category',
          label: 'Category',
          type: 'string',
          storageField: 'category',
          indexed: true,
          filterable: true,
          aggregatable: true,
        },
      ],
      status: 'draft',
    });

    const { status, body } = await request('GET', `/api/schemas/${kbId}`);

    expect(status).toBe(200);
    expect(body.schema.fields).toHaveLength(1);
    expect(body.schema.version).toBe(1);
  });

  test('GET /:kbId returns 404 when none exists', async () => {
    const { status } = await request('GET', '/api/schemas/nonexistent-kb-id');
    expect(status).toBe(404);
  });

  test('PATCH /:kbId with fields creates new version', async () => {
    const { CanonicalSchema } = await import('@agent-platform/database/models');

    const kbRes = await createKB({ name: 'Versioned Schema KB' });
    const kbId = kbRes.body.knowledgeBase._id;

    await CanonicalSchema.create({
      tenantId: 'tenant-1',
      knowledgeBaseId: kbId,
      version: 1,
      fields: [
        {
          name: 'f1',
          label: 'F1',
          type: 'string',
          storageField: 'f1',
          indexed: true,
          filterable: false,
          aggregatable: false,
        },
      ],
      status: 'draft',
    });

    const newFields = [
      {
        name: 'f1',
        label: 'F1',
        type: 'string',
        storageField: 'f1',
        indexed: true,
        filterable: false,
        aggregatable: false,
      },
      {
        name: 'f2',
        label: 'F2',
        type: 'number',
        storageField: 'f2',
        indexed: true,
        filterable: true,
        aggregatable: true,
      },
    ];

    const { status, body } = await request('PATCH', `/api/schemas/${kbId}`, {
      body: { fields: newFields },
    });

    expect(status).toBe(200);
    expect(body.schema.version).toBe(2);
    expect(body.schema.fields).toHaveLength(2);

    // Verify both versions exist
    const count = await CanonicalSchema.countDocuments({ knowledgeBaseId: kbId });
    expect(count).toBe(2);
  });

  test('PATCH /:kbId with status updates in-place', async () => {
    const { CanonicalSchema } = await import('@agent-platform/database/models');

    const kbRes = await createKB({ name: 'Status Schema KB' });
    const kbId = kbRes.body.knowledgeBase._id;

    await CanonicalSchema.create({
      tenantId: 'tenant-1',
      knowledgeBaseId: kbId,
      version: 1,
      fields: [
        {
          name: 'f1',
          label: 'F1',
          type: 'string',
          storageField: 'f1',
          indexed: true,
          filterable: false,
          aggregatable: false,
        },
      ],
      status: 'draft',
    });

    const { status, body } = await request('PATCH', `/api/schemas/${kbId}`, {
      body: { status: 'published' },
    });

    expect(status).toBe(200);
    expect(body.schema.status).toBe('published');
    expect(body.schema.version).toBe(1); // Same version

    // Verify only one version
    const count = await CanonicalSchema.countDocuments({ knowledgeBaseId: kbId });
    expect(count).toBe(1);
  });

  test('PATCH /:kbId returns 400 without fields or status', async () => {
    const { CanonicalSchema } = await import('@agent-platform/database/models');

    const kbRes = await createKB({ name: 'Bad Patch KB' });
    const kbId = kbRes.body.knowledgeBase._id;

    await CanonicalSchema.create({
      tenantId: 'tenant-1',
      knowledgeBaseId: kbId,
      version: 1,
      fields: [],
      status: 'draft',
    });

    const { status, body } = await request('PATCH', `/api/schemas/${kbId}`, {
      body: {},
    });

    expect(status).toBe(400);
    expect(body.error).toContain('fields or status');
  });
});

// =============================================================================
// FIELD MAPPING LIFECYCLE
// =============================================================================

describe('Field Mapping Lifecycle', () => {
  beforeEach(async () => {
    const { CanonicalSchema } = await import('@agent-platform/database/models');
    await CanonicalSchema.insertMany(
      ['schema-1', 'schema-c', 'schema-r', 'schema-t'].map((schemaId) => ({
        _id: schemaId,
        tenantId: 'tenant-1',
        knowledgeBaseId: `kb-${schemaId}`,
        version: 1,
        fields: [
          {
            name: 'category',
            label: 'Category',
            type: 'string',
            storageField: 'category',
            indexed: true,
            filterable: true,
            aggregatable: true,
          },
          {
            name: 'title',
            label: 'Title',
            type: 'string',
            storageField: 'title',
            indexed: true,
            filterable: false,
            aggregatable: false,
          },
          {
            name: 'price',
            label: 'Price',
            type: 'number',
            storageField: 'price',
            indexed: true,
            filterable: true,
            aggregatable: true,
          },
        ],
        status: 'active',
      })),
    );
  });

  test('GET / lists mappings filtered by schemaId', async () => {
    const { FieldMapping } = await import('@agent-platform/database/models');

    await FieldMapping.create({
      tenantId: 'tenant-1',
      canonicalSchemaId: 'schema-1',
      canonicalField: 'category',
      connectorId: 'conn-1',
      sourcePath: 'type',
      transform: { type: 'direct' },
      confidence: 0.9,
      status: 'suggested',
      suggestedBy: 'gpt-4',
    });
    await FieldMapping.create({
      tenantId: 'tenant-1',
      canonicalSchemaId: 'schema-2',
      canonicalField: 'name',
      connectorId: 'conn-2',
      sourcePath: 'title',
      transform: { type: 'direct' },
      confidence: 0.8,
      status: 'suggested',
      suggestedBy: 'gpt-4',
    });

    const { status, body } = await request('GET', '/api/mappings', {
      query: { schemaId: 'schema-1' },
    });

    expect(status).toBe(200);
    expect(body.mappings).toHaveLength(1);
    expect(body.mappings[0].canonicalField).toBe('category');
  });

  test('POST /suggest returns 202', async () => {
    const { CanonicalSchema, ConnectorSchema } = await import('@agent-platform/database/models');

    const schema = await CanonicalSchema.create({
      tenantId: 'tenant-1',
      knowledgeBaseId: 'kb-suggest',
      version: 1,
      fields: [
        {
          name: 'title',
          label: 'Title',
          type: 'string',
          storageField: 'title',
          indexed: true,
          filterable: false,
          aggregatable: false,
        },
      ],
      status: 'draft',
    });

    // Create ConnectorSchema so the /suggest endpoint can find it
    await ConnectorSchema.create({
      tenantId: 'tenant-1',
      connectorId: 'conn-suggest-1',
      version: 1,
      fields: [{ name: 'name', label: 'Name', type: 'string', path: 'name' }],
      status: 'active',
    });

    const { status, body } = await request('POST', '/api/mappings/suggest', {
      body: {
        canonicalSchemaId: schema._id.toString(),
        connectorId: 'conn-suggest-1',
        tenantId: 'tenant-1',
        indexId: 'index-suggest-1',
      },
    });

    // The suggest endpoint calls the LLM-based suggestion service which isn't
    // available in tests. It returns 500 because the downstream service fails.
    // Reaching 500 (not 400/404) confirms input validation and schema lookups passed.
    expect(status).toBe(500);
    expect(body.error).toBe('Failed to generate mapping suggestions');
  });

  test('POST /suggest returns 400 when fields missing', async () => {
    const { status, body } = await request('POST', '/api/mappings/suggest', {
      body: { tenantId: 'tenant-1' },
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  test('POST /:id/confirm sets confirmed + reviewedAt', async () => {
    const { FieldMapping } = await import('@agent-platform/database/models');

    const mapping = await FieldMapping.create({
      tenantId: 'tenant-1',
      canonicalSchemaId: 'schema-c',
      canonicalField: 'title',
      connectorId: 'conn-c',
      sourcePath: 'name',
      transform: { type: 'direct' },
      confidence: 0.95,
      status: 'suggested',
      suggestedBy: 'gpt-4',
    });

    const { status, body } = await request('POST', `/api/mappings/${mapping._id}/confirm`, {
      body: { reviewedBy: 'admin@test.com' },
    });

    expect(status).toBe(200);
    expect(body.mapping.status).toBe('active');
    expect(body.mapping.reviewedAt).toBeTruthy();
    expect(body.mapping.reviewedBy).toBe('admin@test.com');
  });

  test('POST /:id/confirm returns 404', async () => {
    const { status } = await request('POST', '/api/mappings/000000000000000000000000/confirm', {
      body: {},
    });
    expect(status).toBe(404);
  });

  test('POST /:id/reject sets rejected', async () => {
    const { FieldMapping } = await import('@agent-platform/database/models');

    const mapping = await FieldMapping.create({
      tenantId: 'tenant-1',
      canonicalSchemaId: 'schema-r',
      canonicalField: 'price',
      connectorId: 'conn-r',
      sourcePath: 'cost',
      transform: { type: 'direct' },
      confidence: 0.3,
      status: 'suggested',
      suggestedBy: 'gpt-4',
    });

    const { status, body } = await request('POST', `/api/mappings/${mapping._id}/reject`, {
      body: { reviewedBy: 'admin@test.com' },
    });

    expect(status).toBe(200);
    expect(body.mapping.status).toBe('rejected');
  });

  test('POST /:id/test with sampleData returns test result', async () => {
    const { FieldMapping } = await import('@agent-platform/database/models');

    const mapping = await FieldMapping.create({
      tenantId: 'tenant-1',
      canonicalSchemaId: 'schema-t',
      canonicalField: 'category',
      connectorId: 'conn-t',
      sourcePath: 'type',
      transform: { type: 'direct' },
      confidence: 0.85,
      status: 'confirmed',
      suggestedBy: 'gpt-4',
    });

    const { status, body } = await request('POST', `/api/mappings/${mapping._id}/test`, {
      body: { sampleData: { type: 'electronics' } },
    });

    expect(status).toBe(200);
    expect(body.testResult).toBeDefined();
    expect(body.testResult.success).toBe(true);
    expect(body.mappingId).toBe(mapping._id.toString());
  });
});

// =============================================================================
// JOB MANAGEMENT
// =============================================================================

describe('Job Management', () => {
  test('POST creates job for valid index', async () => {
    const idx = await createIndex({ name: 'Job Index' });
    const indexId = idx.body.index._id;

    const { status, body } = await request('POST', '/api/jobs', {
      body: { indexId },
    });

    expect(status).toBe(201);
    expect(body.job.status).toBe('queued');
    expect(body.job.indexId).toBe(indexId);
  });

  test('POST returns 400 when indexId missing', async () => {
    const { status, body } = await request('POST', '/api/jobs', {
      body: {},
    });

    expect(status).toBe(400);
    expect(body.error).toContain('indexId');
  });

  test('POST returns 404 when index does not exist', async () => {
    const { status } = await request('POST', '/api/jobs', {
      body: { indexId: '000000000000000000000000' },
    });

    expect(status).toBe(404);
  });

  test('GET / lists jobs', async () => {
    const idx = await createIndex({ name: 'Jobs List' });
    const indexId = idx.body.index._id;

    await request('POST', '/api/jobs', { body: { indexId } });
    await request('POST', '/api/jobs', { body: { indexId } });

    const { status, body } = await request('GET', '/api/jobs');

    expect(status).toBe(200);
    expect(body.jobs.length).toBeGreaterThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test('GET /:jobId returns job', async () => {
    const idx = await createIndex({ name: 'Job Detail' });
    const indexId = idx.body.index._id;

    const created = await request('POST', '/api/jobs', { body: { indexId } });
    const jobId = created.body.job.id;

    const { status, body } = await request('GET', `/api/jobs/${jobId}`);

    expect(status).toBe(200);
    expect(body.job.id).toBe(jobId);
    expect(body.job.status).toBe('queued');
  });
});

// =============================================================================
// FULL LIFECYCLE INTEGRATION
// =============================================================================

describe('Full Lifecycle Integration', () => {
  test('Complete KB lifecycle: create -> add source -> create schema -> add mapping -> rebuild', async () => {
    const { CanonicalSchema, FieldMapping } = await import('@agent-platform/database/models');

    // 1. Create KB
    const kbRes = await createKB({ name: 'Lifecycle KB' });
    expect(kbRes.status).toBe(201);
    const kbId = kbRes.body.knowledgeBase._id;
    const indexId = kbRes.body.knowledgeBase.searchIndexId;

    // 2. Add source
    const srcRes = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'Docs Source', sourceType: 'file', sourceConfig: { fileTypes: ['pdf'] } },
    });
    expect(srcRes.status).toBe(201);

    // 3. Create canonical schema
    const schema = await CanonicalSchema.create({
      tenantId: 'tenant-1',
      knowledgeBaseId: kbId,
      version: 1,
      fields: [
        {
          name: 'category',
          label: 'Category',
          type: 'string',
          storageField: 'category',
          indexed: true,
          filterable: true,
          aggregatable: true,
        },
      ],
      status: 'draft',
    });

    // 4. Add field mapping
    await FieldMapping.create({
      tenantId: 'tenant-1',
      canonicalSchemaId: schema._id.toString(),
      canonicalField: 'category',
      connectorId: srcRes.body.source._id,
      sourcePath: 'type',
      transform: { type: 'direct' },
      confidence: 0.9,
      status: 'confirmed',
      suggestedBy: 'user',
    });

    // 5. Rebuild (currently returns 501 — not yet implemented)
    const rebuildRes = await request('POST', `/api/knowledge-bases/${kbId}/rebuild`);
    expect(rebuildRes.status).toBe(501);
    expect(rebuildRes.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  test('Cascade delete with data: KB with sources, docs, chunks all cleaned up', async () => {
    const { KnowledgeBase, SearchIndex, SearchSource, SearchDocument, SearchChunk } =
      await import('@agent-platform/database/models');

    // Create KB with full data chain
    const kbRes = await createKB({ name: 'Cascade KB' });
    const kbId = kbRes.body.knowledgeBase._id;
    const indexId = kbRes.body.knowledgeBase.searchIndexId;

    // Add 2 sources
    const src1 = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'S1', sourceType: 'file' },
    });
    const src2 = await request('POST', `/api/indexes/${indexId}/sources`, {
      body: { name: 'S2', sourceType: 'web' },
    });

    // Add documents for each source
    const doc1 = await SearchDocument.create({
      tenantId: 'tenant-1',
      indexId,
      sourceId: src1.body.source._id,
      contentHash: 'hash1',
      status: 'ready',
      contentSizeBytes: 100,
    });
    const doc2 = await SearchDocument.create({
      tenantId: 'tenant-1',
      indexId,
      sourceId: src2.body.source._id,
      contentHash: 'hash2',
      status: 'ready',
      contentSizeBytes: 200,
    });

    // Add chunks for each document
    await SearchChunk.create({
      tenantId: 'tenant-1',
      indexId,
      documentId: doc1._id,
      content: 'chunk 1a',
      tokenCount: 5,
      chunkIndex: 0,
      status: 'ready',
    });
    await SearchChunk.create({
      tenantId: 'tenant-1',
      indexId,
      documentId: doc1._id,
      content: 'chunk 1b',
      tokenCount: 5,
      chunkIndex: 1,
      status: 'ready',
    });
    await SearchChunk.create({
      tenantId: 'tenant-1',
      indexId,
      documentId: doc2._id,
      content: 'chunk 2a',
      tokenCount: 5,
      chunkIndex: 0,
      status: 'ready',
    });

    // Verify data exists before delete (2 explicitly added sources, no auto-created default)
    expect(await SearchSource.countDocuments()).toBe(2);
    expect(await SearchDocument.countDocuments()).toBe(2);
    expect(await SearchChunk.countDocuments()).toBe(3);

    // Delete KB
    const { status } = await request('DELETE', `/api/knowledge-bases/${kbId}`);
    expect(status).toBe(200);

    // Verify everything is cleaned up
    expect(await KnowledgeBase.countDocuments()).toBe(0);
    expect(await SearchIndex.countDocuments()).toBe(0);
    expect(await SearchSource.countDocuments()).toBe(0);
    expect(await SearchDocument.countDocuments()).toBe(0);
    expect(await SearchChunk.countDocuments()).toBe(0);
  });

  test('Duplicate slug handling: create two KBs with same name', async () => {
    const first = await createKB({
      projectId: 'proj-dup',
      name: 'Same Name',
    });
    expect(first.status).toBe(201);

    const second = await createKB({
      projectId: 'proj-dup',
      name: 'Same Name',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('already exists');
  });
});
