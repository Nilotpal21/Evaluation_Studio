/**
 * Schema Discovery API Endpoint Tests (Story 1.9)
 *
 * Tests POST /connectors/:connectorId/discover-schema and
 * GET /connectors/:connectorId/discovered endpoints.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const {
  mockConnectorConfigFindOne,
  mockSearchSourceFindOne,
  mockSearchIndexFindOne,
  mockDiscoveredSchemaFindOne,
  mockConnectorSchemaFindOne,
  mockQueueAdd,
  mockQueueClose,
} = vi.hoisted(() => ({
  mockConnectorConfigFindOne: vi.fn(),
  mockSearchSourceFindOne: vi.fn(),
  mockSearchIndexFindOne: vi.fn(),
  mockDiscoveredSchemaFindOne: vi.fn(),
  mockConnectorSchemaFindOne: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockQueueClose: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    switch (modelName) {
      case 'ConnectorConfig':
        return { findOne: mockConnectorConfigFindOne };
      case 'SearchSource':
        return { findOne: mockSearchSourceFindOne };
      case 'SearchIndex':
        return { findOne: mockSearchIndexFindOne };
      case 'DiscoveredSchema':
        return { findOne: mockDiscoveredSchemaFindOne };
      case 'ConnectorSchema':
        return { findOne: mockConnectorSchemaFindOne, find: vi.fn() };
      case 'CanonicalSchema':
        return { findOne: vi.fn(), findOneAndUpdate: vi.fn(), create: vi.fn() };
      case 'FieldMapping':
        return { find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) };
      default:
        return {};
    }
  }),
}));

vi.mock('@agent-platform/database/models', () => ({}));

vi.mock('../../workers/shared.js', () => ({
  createQueue: vi.fn(() => ({
    add: mockQueueAdd,
    close: mockQueueClose,
  })),
  getRedisConnection: vi.fn(() => ({})),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_SCHEMA_SYNC: 'search-schema-sync',
  QUEUE_SCHEMA_DISCOVERY: 'search-schema-discovery',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks
import schemasRouter from '../schemas.js';

// ─── Test App Setup ─────────────────────────────────────────────────────────

function createApp(tenantContext: Record<string, unknown> = { projectScope: ['project-allowed'] }) {
  const app = express();
  app.use(express.json());
  // Inject fake tenant context (auth middleware would do this in production)
  app.use((req, _res, next) => {
    req.tenantContext = { tenantId: 'tenant-test', ...tenantContext } as any;
    next();
  });
  app.use('/schemas', schemasRouter);
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const fakeConnector = {
  _id: 'conn-001',
  tenantId: 'tenant-test',
  sourceId: 'source-001',
  connectorType: 'sharepoint',
  oauthTokenId: 'oauth-token-001',
};

const fakeSource = {
  _id: 'source-001',
  tenantId: 'tenant-test',
  indexId: 'kb-001',
};

const fakeIndex = {
  _id: 'kb-001',
  tenantId: 'tenant-test',
  projectId: 'project-allowed',
};

const fakeDiscoveredSchema = {
  _id: 'schema-001',
  tenantId: 'tenant-test',
  connectorId: 'conn-001',
  version: 2,
  fields: [
    { name: 'title', type: 'string', path: 'columns/title' },
    { name: 'status', type: 'string', path: 'columns/status' },
  ],
  fieldCount: 2,
  status: 'active',
};

// ─── Setup ──────────────────────────────────────────────────────────────────

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();

  // Default mocks: happy path
  mockConnectorConfigFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeConnector) });
  mockSearchSourceFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeSource) });
  mockSearchIndexFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeIndex) });
  mockQueueAdd.mockResolvedValue({ id: 'job-001' });
  mockQueueClose.mockResolvedValue(undefined);
});

// ─── POST /connectors/:connectorId/discover-schema ──────────────────────────

describe('POST /schemas/connectors/:connectorId/discover-schema', () => {
  test('happy path: enqueues job and returns 202', async () => {
    const res = await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(res.status).toBe(202);
    expect(res.body.data.jobId).toBe('job-001');
    expect(res.body.data.status).toBe('queued');
    expect(res.body.meta.message).toBe('Schema discovery initiated');
  });

  test('enqueues with correct job data', async () => {
    await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'schema-discovery:conn-001',
      {
        tenantId: 'tenant-test',
        connectorId: 'conn-001',
        knowledgeBaseId: 'kb-001',
        connectorType: 'sharepoint',
        discoveryTrigger: 'manual',
      },
      {
        jobId: 'schema-discovery:tenant-test:conn-001',
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    );
  });

  test('always closes queue after enqueue', async () => {
    await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(mockQueueClose).toHaveBeenCalled();
  });

  test('closes queue even when add fails', async () => {
    mockQueueAdd.mockRejectedValue(new Error('Redis down'));

    await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(mockQueueClose).toHaveBeenCalled();
  });

  test('returns 404 when connector not found', async () => {
    mockConnectorConfigFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const res = await request(app).post('/schemas/connectors/conn-999/discover-schema').send();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Connector not found');
  });

  test('returns 400 when connector not authenticated', async () => {
    mockConnectorConfigFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ ...fakeConnector, oauthTokenId: null }),
    });

    const res = await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_AUTHENTICATED');
  });

  test('returns 404 when source not found', async () => {
    mockSearchSourceFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const res = await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Source not found for connector');
  });

  test('includes tenantId in connector query', async () => {
    await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(mockConnectorConfigFindOne).toHaveBeenCalledWith({
      _id: 'conn-001',
      tenantId: 'tenant-test',
    });
  });

  test('includes tenantId in source query', async () => {
    await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(mockSearchSourceFindOne).toHaveBeenCalledWith({
      _id: 'source-001',
      tenantId: 'tenant-test',
    });
  });

  test('rejects schema discovery when connector index is outside projectScope', async () => {
    mockSearchIndexFindOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });

    const res = await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'kb-001',
      tenantId: 'tenant-test',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('returns 500 on unexpected error', async () => {
    mockConnectorConfigFindOne.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });

    const res = await request(app).post('/schemas/connectors/conn-001/discover-schema').send();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DISCOVERY_FAILED');
  });
});

describe('GET /schemas/connectors/:connectorId', () => {
  test('preserves legacy tenant-wide ConnectorSchema reads without source-linked connector rows', async () => {
    const legacyApp = createApp({});
    mockConnectorConfigFindOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    mockConnectorSchemaFindOne.mockReturnValueOnce({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'schema-legacy',
          connectorId: 'conn-legacy',
          tenantId: 'tenant-test',
          version: 1,
          fields: [{ path: 'title', label: 'Title', type: 'string' }],
        }),
      }),
    });

    const res = await request(legacyApp).get('/schemas/connectors/conn-legacy');

    expect(res.status).toBe(200);
    expect(res.body.schema._id).toBe('schema-legacy');
    expect(mockSearchIndexFindOne).not.toHaveBeenCalled();
    expect(mockConnectorSchemaFindOne).toHaveBeenCalledWith({
      connectorId: 'conn-legacy',
      tenantId: 'tenant-test',
    });
  });
});

// ─── GET /connectors/:connectorId/discovered ────────────────────────────────

describe('GET /schemas/connectors/:connectorId/discovered', () => {
  beforeEach(() => {
    mockDiscoveredSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(fakeDiscoveredSchema),
      }),
    });
  });

  test('happy path: returns discovered schema', async () => {
    const res = await request(app).get('/schemas/connectors/conn-001/discovered');

    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe('schema-001');
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.fields).toHaveLength(2);
  });

  test('returns 404 when no schema exists', async () => {
    mockDiscoveredSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });

    const res = await request(app).get('/schemas/connectors/conn-001/discovered');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Discovered schema not found');
  });

  test('queries with tenantId scoping', async () => {
    await request(app).get('/schemas/connectors/conn-001/discovered');

    expect(mockDiscoveredSchemaFindOne).toHaveBeenCalledWith({
      connectorId: 'conn-001',
      tenantId: 'tenant-test',
    });
  });

  test('returns latest version (sorted by version desc)', async () => {
    await request(app).get('/schemas/connectors/conn-001/discovered');

    const sortCall = mockDiscoveredSchemaFindOne.mock.results[0].value.sort;
    expect(sortCall).toHaveBeenCalledWith({ version: -1 });
  });

  test('returns 500 on unexpected error', async () => {
    mockDiscoveredSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB timeout')),
      }),
    });

    const res = await request(app).get('/schemas/connectors/conn-001/discovered');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
