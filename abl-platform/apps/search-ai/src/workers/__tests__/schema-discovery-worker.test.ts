import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const {
  mockDiscoverSchema,
  mockApplyTemplateEnumPatterns,
  mockUpsertDiscoveredSchema,
  mockDiscoveredSchemaModel,
  mockSearchSourceModel,
  mockQueueAdd,
} = vi.hoisted(() => ({
  mockDiscoverSchema: vi.fn(),
  mockApplyTemplateEnumPatterns: vi.fn(),
  mockUpsertDiscoveredSchema: vi.fn(),
  mockDiscoveredSchemaModel: { findOneAndUpdate: vi.fn() },
  mockSearchSourceModel: { findOne: vi.fn() },
  mockQueueAdd: vi.fn(),
}));

vi.mock('@agent-platform/search-ai-internal/services', () => ({
  applyTemplateEnumPatterns: mockApplyTemplateEnumPatterns,
  upsertDiscoveredSchema: mockUpsertDiscoveredSchema,
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'SearchSource') return mockSearchSourceModel;
    return mockDiscoveredSchemaModel;
  }),
}));

vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn(async (_ctx: any, cb: () => any) => cb()),
}));

vi.mock('../shared.js', () => ({
  createQueue: vi.fn(() => ({ add: mockQueueAdd })),
  createWorkerOptions: vi.fn(() => ({ connection: {} })),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

// Import after mocks
import type { SchemaDiscoveryJobData } from '../schema-discovery-worker.js';
import {
  processSchemaDiscoveryJob,
  setDiscoveryServiceFactory,
  resolveDiscoveryService,
} from '../schema-discovery-worker.js';
import { withTenantContext } from '@agent-platform/database/mongo';
import { workerLog, workerError } from '../shared.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeJobData(overrides: Partial<SchemaDiscoveryJobData> = {}): SchemaDiscoveryJobData {
  return {
    tenantId: 'tenant-test',
    connectorId: 'conn-001',
    knowledgeBaseId: 'kb-001',
    connectorType: 'sharepoint',
    discoveryTrigger: 'manual',
    ...overrides,
  };
}

function makeJob(data?: Partial<SchemaDiscoveryJobData>): Job<SchemaDiscoveryJobData> {
  return {
    id: 'job-001',
    data: makeJobData(data),
    updateProgress: vi.fn(),
  } as unknown as Job<SchemaDiscoveryJobData>;
}

const fakeDiscoveredSchema = {
  connectorId: 'conn-001',
  tenantId: 'tenant-test',
  fields: [
    { name: 'title', type: 'string', path: 'columns/title', metadata: {} },
    { name: 'status', type: 'string', path: 'columns/status', metadata: {} },
  ],
  discoveryMethod: 'api' as const,
  discoveredAt: new Date('2026-03-14T10:00:00Z'),
  metadata: { connectorType: 'sharepoint' },
};

const fakeEnrichedSchema = {
  ...fakeDiscoveredSchema,
  fields: [
    ...fakeDiscoveredSchema.fields,
    {
      name: 'priority',
      type: 'string',
      path: 'columns/priority',
      metadata: { enumValues: ['high', 'low'], enumSource: 'template' as const },
    },
  ],
};

const fakePersistedDoc = {
  _id: 'schema-uuid-001',
  tenantId: 'tenant-test',
  connectorId: 'conn-001',
  knowledgeBaseId: 'kb-001',
  version: 1,
  fieldCount: 3,
  status: 'active',
};

// ─── Setup ───────────────────────────────────────────────────────────────────

const mockService = {
  discoverSchema: mockDiscoverSchema,
  validateCredentials: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();

  // Default mock: factory returns mockService for any connector type
  setDiscoveryServiceFactory(() => mockService as any);

  mockDiscoverSchema.mockResolvedValue(fakeDiscoveredSchema);
  mockApplyTemplateEnumPatterns.mockReturnValue(fakeEnrichedSchema);
  mockUpsertDiscoveredSchema.mockResolvedValue(fakePersistedDoc);
  mockSearchSourceModel.findOne.mockResolvedValue({ _id: 'source-001', indexId: 'kb-001' });
  mockQueueAdd.mockResolvedValue({ id: 'field-mapping-job-001' });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('processSchemaDiscoveryJob', () => {
  test('calls discovery service with correct options', async () => {
    const job = makeJob();
    await processSchemaDiscoveryJob(job);

    expect(mockDiscoverSchema).toHaveBeenCalledWith({
      connectorId: 'conn-001',
      tenantId: 'tenant-test',
    });
  });

  test('calls applyTemplateEnumPatterns with discovered schema and connectorType', async () => {
    const job = makeJob();
    await processSchemaDiscoveryJob(job);

    expect(mockApplyTemplateEnumPatterns).toHaveBeenCalledWith(fakeDiscoveredSchema, 'sharepoint');
  });

  test('calls upsertDiscoveredSchema with enriched schema and model', async () => {
    const job = makeJob();
    await processSchemaDiscoveryJob(job);

    expect(mockUpsertDiscoveredSchema).toHaveBeenCalledWith(
      { schema: fakeEnrichedSchema, knowledgeBaseId: 'kb-001' },
      mockDiscoveredSchemaModel,
    );
  });

  test('wraps execution in withTenantContext', async () => {
    const job = makeJob();
    await processSchemaDiscoveryJob(job);

    expect(withTenantContext).toHaveBeenCalledWith(
      { tenantId: 'tenant-test' },
      expect.any(Function),
    );
  });

  test('updates job progress at 50, 75, 90, 100', async () => {
    const job = makeJob();
    await processSchemaDiscoveryJob(job);

    expect(job.updateProgress).toHaveBeenCalledWith(50);
    expect(job.updateProgress).toHaveBeenCalledWith(75);
    expect(job.updateProgress).toHaveBeenCalledWith(90);
    expect(job.updateProgress).toHaveBeenCalledWith(100);
  });

  test('logs start and completion with context', async () => {
    const job = makeJob();
    await processSchemaDiscoveryJob(job);

    expect(workerLog).toHaveBeenCalledWith(
      'schema-discovery',
      'Starting schema discovery',
      expect.objectContaining({
        connectorId: 'conn-001',
        tenantId: 'tenant-test',
        knowledgeBaseId: 'kb-001',
        connectorType: 'sharepoint',
        discoveryTrigger: 'manual',
      }),
    );

    expect(workerLog).toHaveBeenCalledWith(
      'schema-discovery',
      'Schema discovery completed',
      expect.objectContaining({
        connectorId: 'conn-001',
        tenantId: 'tenant-test',
        schemaId: 'schema-uuid-001',
        fieldCount: 3,
      }),
    );
  });

  test('rethrows error for BullMQ retry', async () => {
    const error = new Error('API timeout');
    mockDiscoverSchema.mockRejectedValue(error);

    const job = makeJob();
    await expect(processSchemaDiscoveryJob(job)).rejects.toThrow('API timeout');
  });

  test('logs error on failure', async () => {
    mockDiscoverSchema.mockRejectedValue(new Error('Auth failed'));

    const job = makeJob();
    await expect(processSchemaDiscoveryJob(job)).rejects.toThrow('Auth failed');

    expect(workerError).toHaveBeenCalledWith(
      'schema-discovery',
      'Schema discovery failed: Auth failed',
      expect.any(Error),
    );
  });

  test('resolves correct service for google_sheets connectorType', async () => {
    const factorySpy = vi.fn().mockReturnValue(mockService);
    setDiscoveryServiceFactory(factorySpy);

    const job = makeJob({ connectorType: 'google_sheets' });
    await processSchemaDiscoveryJob(job);

    expect(factorySpy).toHaveBeenCalledWith('google_sheets');
  });
});

describe('resolveDiscoveryService', () => {
  test('throws when no factory configured', () => {
    setDiscoveryServiceFactory(undefined as any);

    expect(() => resolveDiscoveryService('unknown')).toThrow(
      'Schema discovery service factory not configured',
    );
  });

  test('throws when factory rejects connector type', () => {
    const badFactory = () => {
      throw new Error('Unsupported connector type');
    };
    setDiscoveryServiceFactory(badFactory);

    expect(() => resolveDiscoveryService('unknown')).toThrow('Unsupported connector type');
  });

  test('delegates to registered factory', () => {
    const factory = vi.fn().mockReturnValue(mockService);
    setDiscoveryServiceFactory(factory);

    const result = resolveDiscoveryService('sharepoint');

    expect(factory).toHaveBeenCalledWith('sharepoint');
    expect(result).toBe(mockService);
  });
});
