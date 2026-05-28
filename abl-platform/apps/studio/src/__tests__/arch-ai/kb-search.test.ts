// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkToolPermissionMock,
  clientGetMock,
  clientPostMock,
  createKBApiClientMock,
  resolveKBContextMock,
} = vi.hoisted(() => ({
  checkToolPermissionMock: vi.fn(),
  clientGetMock: vi.fn(),
  clientPostMock: vi.fn(),
  createKBApiClientMock: vi.fn(),
  resolveKBContextMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/guards', () => ({
  checkToolPermission: checkToolPermissionMock,
}));

vi.mock('@/lib/arch-ai/tools/kb-api-client', () => ({
  createKBApiClient: createKBApiClientMock,
}));

vi.mock('@/lib/arch-ai/tools/kb-context', () => ({
  resolveKBContext: resolveKBContextMock,
}));

import { executeKBSearch } from '@/lib/arch-ai/tools/kb-search';

function makeCtx() {
  return {
    projectId: 'proj-1',
    user: {
      permissions: ['tool:read', 'tool:write'],
      tenantId: 'tenant-1',
      userId: 'user-1',
    },
  };
}

function makeEnv() {
  return {
    pageContext: null,
    authToken: 'auth-token',
  };
}

describe('executeKBSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    checkToolPermissionMock.mockResolvedValue({ allowed: true });
    resolveKBContextMock.mockResolvedValue({ kbId: 'kb-1', availableKBs: [] });

    createKBApiClientMock.mockReturnValue({
      get: clientGetMock,
      post: clientPostMock,
      patch: vi.fn(),
      del: vi.fn(),
      postFormData: vi.fn(),
    });

    clientGetMock.mockImplementation(async (path: string) => {
      if (path === '/api/search-ai/knowledge-bases/kb-1') {
        return {
          knowledgeBase: {
            _id: 'kb-1',
            name: 'Support KB',
            searchIndexId: 'index-1',
          },
        };
      }

      throw new Error(`Unexpected GET ${path}`);
    });
  });

  it('normalizes record filters and forces semantic search through the unified query route', async () => {
    clientPostMock.mockResolvedValue({
      results: [],
      latency: { totalMs: 18 },
    });

    const result = await executeKBSearch(
      {
        action: 'query',
        kbId: 'kb-1',
        query: 'find ready onboarding docs',
        limit: 7,
        filters: {
          status: 'ready',
          categories: ['guide', 'faq'],
          priority: { operator: 'gte', value: 2 },
          archived: { operator: 'exists' },
        },
      },
      makeCtx(),
      makeEnv(),
    );

    expect(clientPostMock).toHaveBeenCalledWith('/api/search-ai-runtime/search/index-1/query', {
      queryType: 'semantic',
      query: 'find ready onboarding docs',
      topK: 7,
      filters: [
        { field: 'status', operator: 'eq', value: 'ready' },
        { field: 'categories', operator: 'in', value: ['guide', 'faq'] },
        { field: 'priority', operator: 'gte', value: 2 },
        { field: 'archived', operator: 'exists', value: true },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        kbId: 'kb-1',
        kbName: 'Support KB',
        indexId: 'index-1',
      },
    });
  });

  it('routes structured queries through the unified query endpoint and normalizes array filters', async () => {
    clientPostMock.mockResolvedValue({
      results: [{ title: 'APAC Rollout', score: 1 }],
      latency: { totalMs: 12 },
    });

    const result = await executeKBSearch(
      {
        action: 'structured_query',
        kbId: 'kb-1',
        query: 'show APAC rollout docs',
        filters: [
          { field: 'region', operator: 'eq', value: 'apac' },
          { field: 'owner', operator: 'exists' },
        ],
      },
      makeCtx(),
      makeEnv(),
    );

    expect(clientPostMock).toHaveBeenCalledWith('/api/search-ai-runtime/search/index-1/query', {
      queryType: 'structured',
      query: 'show APAC rollout docs',
      limit: 10,
      filters: [
        { field: 'region', operator: 'eq', value: 'apac' },
        { field: 'owner', operator: 'exists', value: true },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        kbId: 'kb-1',
        kbName: 'Support KB',
        indexId: 'index-1',
        results: [{ title: 'APAC Rollout', score: 1 }],
      },
    });
  });
});
