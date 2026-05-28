import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureProjectModelConfig, type FetchContext } from '../configure-model';

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

const ctx: FetchContext = {
  projectId: 'project-1',
  tenantId: 'tenant-1',
  authToken: 'token-1',
};

describe('ensureProjectModelConfig provider aliases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats an existing gemini project model config as satisfying a google request', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        models: [{ modelId: 'gemini-2.5-pro', provider: 'gemini' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureProjectModelConfig(ctx, 'gemini-2.5-pro', 'google');

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('matches legacy gemini tenant models when creating a google project model config', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'tenant-model-1',
              modelId: 'gemini-2.5-pro',
              provider: 'gemini',
              isActive: true,
              inferenceEnabled: true,
              connections: [{ id: 'connection-1' }],
              supportsTools: true,
              supportsVision: true,
              supportsStreaming: true,
              contextWindow: 128_000,
              tier: 'balanced',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'project-model-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureProjectModelConfig(ctx, 'gemini-2.5-pro', 'google');

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      modelId: 'gemini-2.5-pro',
      provider: 'google',
      tenantModelId: 'tenant-model-1',
    });
  });
});
