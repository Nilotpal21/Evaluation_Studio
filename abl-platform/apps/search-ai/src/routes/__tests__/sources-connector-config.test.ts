/**
 * Sources Route — ConnectorConfig Auto-Creation Tests
 *
 * Verifies that POST /:indexId/sources auto-creates a ConnectorConfig
 * for manual sources (sourceType='manual') with connectorType='file_upload',
 * and does NOT create one for non-manual source types.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const { mockSearchSource, mockSearchIndex, mockConnectorConfig } = vi.hoisted(() => ({
  mockSearchSource: {
    find: vi.fn(),
    create: vi.fn(),
  },
  mockSearchIndex: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
  mockConnectorConfig: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'SearchSource') return mockSearchSource;
    if (modelName === 'SearchIndex') return mockSearchIndex;
    if (modelName === 'ConnectorConfig') return mockConnectorConfig;
    return {};
  }),
}));

// ─── Import the router under test ────────────────────────────────────────────

import sourcesRouter from '../sources.js';

// ─── Express helpers ─────────────────────────────────────────────────────────

function createMockReq(overrides: Record<string, any> = {}): any {
  return {
    params: { indexId: 'idx-1' },
    body: { name: 'My Source', sourceType: 'manual' },
    tenantContext: { tenantId: 'tenant-1' },
    ...overrides,
  };
}

function createMockRes(): any {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// ─── Extract the POST handler from the router ────────────────────────────────

function getPostHandler() {
  // Express Router stores routes in router.stack
  const stack = (sourcesRouter as any).stack;
  const postLayer = stack.find(
    (layer: any) => layer.route?.methods?.post && layer.route?.path === '/:indexId/sources',
  );
  if (!postLayer) throw new Error('POST /:indexId/sources route not found');
  // The handler is the last function in the route stack
  return postLayer.route.stack[postLayer.route.stack.length - 1].handle;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /:indexId/sources — ConnectorConfig auto-creation', () => {
  let handler: (...args: any[]) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getPostHandler();

    // Default: index exists
    mockSearchIndex.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'idx-1', tenantId: 'tenant-1' }),
    });
    mockSearchIndex.findOneAndUpdate.mockResolvedValue({});

    // Default: source creation succeeds
    mockSearchSource.create.mockResolvedValue({
      _id: 'src-1',
      tenantId: 'tenant-1',
      indexId: 'idx-1',
      name: 'My Source',
      sourceType: 'manual',
      status: 'pending',
    });

    // Default: no existing ConnectorConfig
    mockConnectorConfig.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mockConnectorConfig.create.mockResolvedValue({
      _id: 'cc-1',
      tenantId: 'tenant-1',
      sourceId: 'src-1',
      connectorType: 'file_upload',
    });
  });

  it('should auto-create ConnectorConfig with connectorType=file_upload for manual sources', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockConnectorConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        sourceId: 'src-1',
        connectorType: 'file_upload',
        connectionConfig: {},
        configurationSource: 'manual',
      }),
    );
  });

  it('scopes index ownership by API-key projectScope before creating a source', async () => {
    const req = createMockReq({
      tenantContext: {
        tenantId: 'tenant-1',
        projectScope: ['project-1'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockSearchIndex.findOne).toHaveBeenCalledWith({
      _id: 'idx-1',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-1'] },
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('should NOT create duplicate ConnectorConfig (idempotency)', async () => {
    // ConnectorConfig already exists for this source
    mockConnectorConfig.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'cc-existing',
        tenantId: 'tenant-1',
        sourceId: 'src-1',
        connectorType: 'file_upload',
      }),
    });

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockConnectorConfig.create).not.toHaveBeenCalled();
  });

  it('should NOT create ConnectorConfig for non-manual source types', async () => {
    const req = createMockReq({ body: { name: 'SP Source', sourceType: 'sharepoint' } });
    const res = createMockRes();

    mockSearchSource.create.mockResolvedValue({
      _id: 'src-2',
      tenantId: 'tenant-1',
      indexId: 'idx-1',
      name: 'SP Source',
      sourceType: 'sharepoint',
      status: 'pending',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockConnectorConfig.findOne).not.toHaveBeenCalled();
    expect(mockConnectorConfig.create).not.toHaveBeenCalled();
  });
});
