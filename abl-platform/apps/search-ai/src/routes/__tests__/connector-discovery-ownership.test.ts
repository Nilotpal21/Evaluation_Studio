import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

const {
  mockConnectorConfigFindOne,
  mockSearchSourceFindOne,
  mockSearchIndexFindOne,
  mockTriggerDiscovery,
} = vi.hoisted(() => ({
  mockConnectorConfigFindOne: vi.fn(),
  mockSearchSourceFindOne: vi.fn(),
  mockSearchIndexFindOne: vi.fn(),
  mockTriggerDiscovery: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (modelName: string) => {
    if (modelName === 'ConnectorConfig') {
      return { findOne: mockConnectorConfigFindOne, findOneAndUpdate: vi.fn() };
    }
    if (modelName === 'SearchSource') {
      return { findOne: mockSearchSourceFindOne };
    }
    if (modelName === 'SearchIndex') {
      return { findOne: mockSearchIndexFindOne };
    }
    return { findOne: vi.fn(), create: vi.fn() };
  },
}));

vi.mock('../../services/setup/quick-setup-orchestrator.js', () => ({
  triggerDiscovery: (...args: unknown[]) => mockTriggerDiscovery(...args),
  generateRecommendations: vi.fn(),
  acceptRecommendation: vi.fn(),
}));

vi.mock('../../workers/shared.js', () => ({
  createQueue: vi.fn(),
  getRedisConnection: vi.fn(() => ({})),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../workers/connector-discovery-worker.js', () => ({
  QUEUE_CONNECTOR_DISCOVERY: 'connector-discovery',
}));

describe('connector discovery ownership', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockConnectorConfigFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'conn-1',
        tenantId: 'tenant-123',
        sourceId: 'source-1',
        oauthTokenId: 'token-1',
        connectorType: 'sharepoint',
      }),
    });
    mockSearchSourceFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mockTriggerDiscovery.mockResolvedValue({ discoveryId: 'disc-1', jobId: 'job-1' });

    const { default: connectorDiscoveryRouter } = await import('../connector-discovery.js');
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.tenantContext = {
        tenantId: 'tenant-123',
        userId: 'user-456',
        projectScope: ['project-allowed'],
      } as any;
      next();
    });
    app.use(connectorDiscoveryRouter);
  });

  it('rejects discovery for connectors outside projectScope before queueing work', async () => {
    const response = await request(app)
      .post('/connectors/conn-1/discover')
      .send({ mode: 'discover_only' })
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(mockSearchSourceFindOne).toHaveBeenCalledWith({
      _id: 'source-1',
      tenantId: 'tenant-123',
    });
    expect(mockTriggerDiscovery).not.toHaveBeenCalled();
  });
});
