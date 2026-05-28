import { describe, expect, it, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockSearchIndexFindOne, mockSearchChunkFind, mockSearchChunkFindOne } = vi.hoisted(() => ({
  mockSearchIndexFindOne: vi.fn(),
  mockSearchChunkFind: vi.fn(),
  mockSearchChunkFindOne: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'SearchIndex') {
      return { findOne: mockSearchIndexFindOne };
    }
    if (modelName === 'SearchChunk') {
      return {
        find: mockSearchChunkFind,
        findOne: mockSearchChunkFindOne,
        countDocuments: vi.fn(),
        aggregate: vi.fn(),
      };
    }
    if (modelName === 'SearchDocument') {
      return { find: vi.fn() };
    }
    return {};
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import chunksRouter from '../chunks.js';

describe('Chunks route project isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchIndexFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.tenantContext = {
        tenantId: 'tenant-1',
        projectScope: ['project-allowed'],
      };
      next();
    });
    app.use('/api/indexes', chunksRouter);
    return app;
  }

  it('rejects index chunk listing outside API-key project scope before reading chunks', async () => {
    const res = await request(createApp()).get('/api/indexes/index-cross/chunks');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Index not found');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'index-cross',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockSearchChunkFind).not.toHaveBeenCalled();
  });

  it('rejects document chunk listing outside API-key project scope before reading chunks', async () => {
    const res = await request(createApp()).get('/api/indexes/index-cross/documents/doc-1/chunks');

    expect(res.status).toBe(404);
    expect(mockSearchChunkFind).not.toHaveBeenCalled();
  });

  it('rejects single chunk lookup outside API-key project scope before reading chunk content', async () => {
    const res = await request(createApp()).get('/api/indexes/index-cross/chunks/chunk-1');

    expect(res.status).toBe(404);
    expect(mockSearchChunkFindOne).not.toHaveBeenCalled();
  });
});
