import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ABL_DOCS, DOC_TOPICS, searchDocumentation } from '../docs/index.js';
import { docs } from '../tools/docs.js';
import type { DebugContext } from '../tools/index.js';
import { fetchWithTimeout } from '../utils/fetch.js';

vi.mock('../utils/fetch.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithTimeout);

const connectedCtx = {
  httpClient: {
    getBaseUrl: () => 'http://localhost:3112',
    getAuthToken: () => 'token-123',
  },
} as unknown as DebugContext;

const disconnectedCtx = {
  httpClient: {
    getBaseUrl: () => '',
    getAuthToken: () => null,
  },
} as unknown as DebugContext;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('Embedded documentation fallback', () => {
  test('ABL_DOCS includes focused MCP fallback topics', () => {
    expect(ABL_DOCS['mcp/import-contract']).toContain('Import Preview and Apply Contract');
    expect(ABL_DOCS['mcp/behavior-profiles']).toContain('Behavior Profile Package Contract');
  });

  test('DOC_TOPICS exposes topic metadata', () => {
    expect(DOC_TOPICS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'mcp/platform-contract',
          title: 'MCP Platform Contract',
        }),
      ]),
    );
  });

  test('searchDocumentation returns fallback excerpts', () => {
    expect(searchDocumentation('previewDigest')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'mcp/import-contract',
          excerpt: expect.stringContaining('previewDigest'),
        }),
      ]),
    );
  });
});

describe('debug_docs fallback behavior', () => {
  test('lists embedded topics when not connected', async () => {
    const result = JSON.parse(await docs({}, disconnectedCtx)) as {
      source: string;
      total: number;
    };

    expect(result.source).toBe('embedded');
    expect(result.total).toBeGreaterThan(0);
  });

  test('returns embedded topics when Studio docs are unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        status: 404,
        statusText: 'Not Found',
      }),
    );

    const result = JSON.parse(await docs({ topic: 'mcp/import-contract' }, connectedCtx)) as {
      source: string;
      content: string;
      detail: string;
    };

    expect(result.source).toBe('embedded');
    expect(result.content).toContain('previewDigest');
    expect(result.detail).toContain('Failed to fetch Studio topic');
  });

  test('merges embedded search results with Studio search results', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          results: [{ id: 'abl-reference/flow', title: 'Flow', excerpt: 'FLOW docs' }],
        }),
      ),
    );

    const result = JSON.parse(await docs({ query: 'previewDigest' }, connectedCtx)) as {
      source: string;
      resultCount: number;
      embeddedFallbackResultCount: number;
      results: Array<{ id: string }>;
    };

    expect(result.source).toBe('api');
    expect(result.embeddedFallbackResultCount).toBeGreaterThan(0);
    expect(result.results.map((entry) => entry.id)).toContain('mcp/import-contract');
    expect(result.resultCount).toBe(result.results.length);
  });
});
