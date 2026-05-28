import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();

vi.mock('../../store/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'test-access-token',
      tenantId: 'test-tenant-id',
    }),
  },
}));

describe('prompt-library API client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  it('preserves runtime draft agent references in fetchReferences()', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            count: 2,
            agents: [
              {
                agentName: 'PublishedAgent',
                versionId: 'version-active',
                resolvedHash: 'hash-active',
              },
            ],
            draftAgents: [
              {
                agentName: 'DraftAgent',
                versionId: 'version-draft',
              },
            ],
          },
        }),
    });

    const { fetchReferences } = await import('../../api/prompt-library');

    await expect(fetchReferences('proj-1', 'prompt-1')).resolves.toEqual({
      count: 2,
      agents: [
        {
          agentName: 'PublishedAgent',
          versionId: 'version-active',
          resolvedHash: 'hash-active',
        },
      ],
      draftAgents: [
        {
          agentName: 'DraftAgent',
          versionId: 'version-draft',
        },
      ],
    });
  });
});
