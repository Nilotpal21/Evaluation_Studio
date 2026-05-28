import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

const { mockSearchIndexFindOne, mockResolveIndexLLMConfig, mockGetCircuitBreakerStatus } =
  vi.hoisted(() => ({
    mockSearchIndexFindOne: vi.fn(),
    mockResolveIndexLLMConfig: vi.fn(),
    mockGetCircuitBreakerStatus: vi.fn(),
  }));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (modelName: string) => {
    if (modelName === 'SearchIndex') {
      return { findOne: mockSearchIndexFindOne };
    }
    return {};
  },
}));

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: (...args: unknown[]) => mockResolveIndexLLMConfig(...args),
}));

vi.mock('../../services/mapping-suggestion/index.js', () => ({
  mappingSuggestionService: {
    getCircuitBreakerStatus: (...args: unknown[]) => mockGetCircuitBreakerStatus(...args),
  },
}));

describe('circuit status route', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx-1',
        tenantId: 'tenant-123',
        projectId: 'project-allowed',
      }),
    });
    mockResolveIndexLLMConfig.mockResolvedValue({
      provider: 'openai',
      useCases: {
        mapping_suggestion: { provider: 'openai' },
      },
    });
    mockGetCircuitBreakerStatus.mockResolvedValue({ provider: 'openai', state: 'CLOSED' });

    const { default: circuitStatusRouter } = await import('../circuit-status.js');
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
    app.use(circuitStatusRouter);
  });

  it('rejects indexes outside API-key projectScope before resolving LLM config', async () => {
    mockSearchIndexFindOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });

    const response = await request(app).get('/circuit-status?indexId=idx-1').expect(404);

    expect(response.body.error).toBe('Could not resolve LLM provider for the given index');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-1',
      tenantId: 'tenant-123',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockResolveIndexLLMConfig).not.toHaveBeenCalled();
  });
});
