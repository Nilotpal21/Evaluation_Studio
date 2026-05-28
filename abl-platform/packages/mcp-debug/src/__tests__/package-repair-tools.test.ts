import { beforeEach, describe, expect, it, vi } from 'vitest';
import { debugLintAbl } from '../tools/debug-lint-abl.js';
import { debugWhyTranscriptFailed } from '../tools/debug-why-transcript-failed.js';
import type { DebugContext } from '../tools/index.js';
import { platformPackageModel } from '../tools/platform-package-model.js';
import { fetchWithTimeout } from '../utils/fetch.js';

vi.mock('../utils/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithTimeout);

const ctx = {
  httpClient: {
    getBaseUrl: () => 'http://localhost:3112',
    getAuthToken: () => 'token-123',
  },
} as unknown as DebugContext;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('package repair MCP tools', () => {
  it('accepts import-style data.files payloads across lint, model, and transcript diagnosis', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, issues: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, model: { agents: [] } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, diagnosis: { findings: [] } }));

    const data = {
      files: {
        'wrapped/project.json': '{"format_version":"2.0"}',
        'wrapped/agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
      },
    };

    expect(JSON.parse(await debugLintAbl({ data }, ctx))).toMatchObject({ success: true });
    expect(JSON.parse(await platformPackageModel({ data }, ctx))).toMatchObject({ success: true });
    expect(
      JSON.parse(
        await debugWhyTranscriptFailed(
          { data, transcript: { steps: [{ type: 'finalize' }] } },
          ctx,
        ),
      ),
    ).toMatchObject({ success: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:5173/api/abl/package/lint',
      expect.objectContaining({ method: 'POST' }),
      30_000,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:5173/api/abl/package/model',
      expect.objectContaining({ method: 'POST' }),
      30_000,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:5173/api/abl/package/diagnose-transcript',
      expect.objectContaining({ method: 'POST' }),
      30_000,
    );

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1]?.body as string) as {
        files: Record<string, string>;
      };
      expect(body.files).toEqual({
        'project.json': '{"format_version":"2.0"}',
        'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
      });
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}
