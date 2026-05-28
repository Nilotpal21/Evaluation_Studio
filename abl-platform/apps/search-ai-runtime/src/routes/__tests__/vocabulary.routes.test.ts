import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockSearchIndex, mockListEntries } = vi.hoisted(() => ({
  mockSearchIndex: { findOne: vi.fn() },
  mockListEntries: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { tenantId: 'tenant_123', id: 'user_456' };
    req.tenantContext = {
      tenantId: 'tenant_123',
      userId: 'user_456',
      projectScope: ['proj_1'],
    };
    next();
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchIndex') return mockSearchIndex;
    return {};
  },
}));

vi.mock('../../services/vocabulary-management/vocabulary.service.js', () => ({
  VocabularyService: vi.fn().mockImplementation(function () {
    return {
      listEntries: mockListEntries,
    };
  }),
}));

describe('Vocabulary Management Routes', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSearchIndex.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'kb_789',
        tenantId: 'tenant_123',
        projectId: 'proj_1',
      }),
    });
    mockListEntries.mockResolvedValue({ entries: [], total: 0 });

    const { default: vocabularyRoutes } = await import('../vocabulary.routes.js');
    app = express();
    app.use(express.json());
    app.use(vocabularyRoutes);
  });

  it('lists vocabulary after verifying kb belongs to the route project and project scope', async () => {
    await request(app).get('/projects/proj_1/kb/kb_789/vocabulary').expect(200);

    expect(mockSearchIndex.findOne).toHaveBeenCalledWith({
      _id: 'kb_789',
      tenantId: 'tenant_123',
      projectId: 'proj_1',
    });
    expect(mockListEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        projectKbId: 'kb_789',
        tenantId: 'tenant_123',
      }),
    );
  });

  it('rejects cross-project kb access before calling the vocabulary service', async () => {
    mockSearchIndex.findOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });

    const response = await request(app)
      .get('/projects/proj_other/kb/kb_789/vocabulary')
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(mockListEntries).not.toHaveBeenCalled();
  });
});
