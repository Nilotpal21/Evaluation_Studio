import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const {
  mockSearchIndexFindOne,
  mockConnectorFindOne,
  mockSearchSourceFindOne,
  mockCleanupFindOne,
  mockInitiatePurge,
  mockGetPurgeStatus,
  mockCancelPurge,
  mockRetryPurge,
} = vi.hoisted(() => ({
  mockSearchIndexFindOne: vi.fn(),
  mockConnectorFindOne: vi.fn(),
  mockSearchSourceFindOne: vi.fn(),
  mockCleanupFindOne: vi.fn(),
  mockInitiatePurge: vi.fn(),
  mockGetPurgeStatus: vi.fn(),
  mockCancelPurge: vi.fn(),
  mockRetryPurge: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectScope: ['project-allowed'],
    };
    req.user = { email: 'user@example.com' };
    next();
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'SearchIndex') return { findOne: mockSearchIndexFindOne };
    if (modelName === 'ConnectorConfig') return { findOne: mockConnectorFindOne };
    if (modelName === 'SearchSource') return { findOne: mockSearchSourceFindOne };
    if (modelName === 'ConnectorCleanupJob') return { findOne: mockCleanupFindOne };
    return {};
  }),
}));

vi.mock('../../services/connector-content-purge.service.js', () => ({
  initiatePurge: mockInitiatePurge,
  getPurgeStatus: mockGetPurgeStatus,
  cancelPurge: mockCancelPurge,
  retryPurge: mockRetryPurge,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import connectorContentPurgeRouter from '../connector-content-purge.js';

function chainResolved(value: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  };
}

describe('Connector content purge project isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchIndexFindOne.mockReturnValue(chainResolved({ _id: 'index-allowed' }));
    mockConnectorFindOne.mockReturnValue(
      chainResolved({ _id: 'connector-1', sourceId: 'source-1' }),
    );
    mockSearchSourceFindOne.mockReturnValue(chainResolved({ _id: 'source-1' }));
    mockCleanupFindOne.mockReturnValue(chainResolved({ _id: 'cleanup-1' }));
    mockInitiatePurge.mockResolvedValue({ cleanupId: 'cleanup-1', status: 'in_progress' });
    mockGetPurgeStatus.mockResolvedValue({
      cleanupId: 'cleanup-1',
      status: 'in_progress',
      documents: { total: 0, removed: 0 },
      chunks: { total: 0, removed: 0 },
      vectorEmbeddings: { total: 0, removed: 0 },
      estimatedTimeRemaining: null,
      error: null,
    });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/indexes', connectorContentPurgeRouter);
    return app;
  }

  it('rejects purge initiation when index is outside API-key project scope', async () => {
    mockSearchIndexFindOne.mockReturnValue(chainResolved(null));

    const res = await request(createApp()).post(
      '/api/indexes/index-cross/connectors/connector-1/content/purge',
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'index-cross',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockInitiatePurge).not.toHaveBeenCalled();
  });

  it('rejects purge initiation when connector source does not belong to route index', async () => {
    mockSearchSourceFindOne.mockReturnValue(chainResolved(null));

    const res = await request(createApp()).post(
      '/api/indexes/index-allowed/connectors/connector-1/content/purge',
    );

    expect(res.status).toBe(404);
    expect(mockSearchSourceFindOne).toHaveBeenCalledWith({
      _id: 'source-1',
      tenantId: 'tenant-1',
      indexId: 'index-allowed',
    });
    expect(mockInitiatePurge).not.toHaveBeenCalled();
  });

  it('passes route index and connector scope into purge service for allowed initiation', async () => {
    const res = await request(createApp()).post(
      '/api/indexes/index-allowed/connectors/connector-1/content/purge',
    );

    expect(res.status).toBe(201);
    expect(mockInitiatePurge).toHaveBeenCalledWith(
      'connector-1',
      'tenant-1',
      'index-allowed',
      'user@example.com',
    );
  });

  it('requires the cleanup job to belong to the route connector before status reads', async () => {
    mockCleanupFindOne.mockReturnValue(chainResolved(null));

    const res = await request(createApp()).get(
      '/api/indexes/index-allowed/connectors/connector-1/content/purge/cleanup-cross',
    );

    expect(res.status).toBe(404);
    expect(mockCleanupFindOne).toHaveBeenCalledWith({
      _id: 'cleanup-cross',
      tenantId: 'tenant-1',
      connectorId: 'connector-1',
    });
    expect(mockGetPurgeStatus).not.toHaveBeenCalled();
  });

  it('passes connector scope into cancel and retry service operations', async () => {
    mockCancelPurge.mockResolvedValue({
      cleanupId: 'cleanup-1',
      status: 'cancelled',
      documents: { total: 0, removed: 0 },
      chunks: { total: 0, removed: 0 },
      vectorEmbeddings: { total: 0, removed: 0 },
      estimatedTimeRemaining: null,
      error: null,
    });
    mockRetryPurge.mockResolvedValue({
      cleanupId: 'cleanup-1',
      status: 'in_progress',
      documents: { total: 0, removed: 0 },
      chunks: { total: 0, removed: 0 },
      vectorEmbeddings: { total: 0, removed: 0 },
      estimatedTimeRemaining: null,
      error: null,
    });

    await request(createApp()).post(
      '/api/indexes/index-allowed/connectors/connector-1/content/purge/cleanup-1/cancel',
    );
    await request(createApp()).post(
      '/api/indexes/index-allowed/connectors/connector-1/content/purge/cleanup-1/retry',
    );

    expect(mockCancelPurge).toHaveBeenCalledWith('cleanup-1', 'tenant-1', 'connector-1');
    expect(mockRetryPurge).toHaveBeenCalledWith(
      'cleanup-1',
      'tenant-1',
      'connector-1',
      'index-allowed',
    );
  });
});
