import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformValidatePackage } from '../tools/platform-validate-package.js';
import type { DebugContext } from '../tools/index.js';
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

describe('platformValidatePackage', () => {
  it('accepts import-style data.files payloads for validator/import-preview parity', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ valid: true, issues: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          preview: {
            hasBlockingIssues: false,
            nonBlockingIssueCount: 0,
            issues: [],
          },
        }),
      );

    const result = JSON.parse(
      await platformValidatePackage(
        {
          projectId: 'proj_123',
          data: {
            deleteUnmatched: false,
            files: {
              'project.json': '{"format_version":"2.0"}',
            },
          },
        },
        ctx,
      ),
    ) as { success: boolean; importPreview: { canApply: boolean } };

    expect(result.success).toBe(true);
    expect(result.importPreview.canApply).toBe(true);

    const validateBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      files: Record<string, string>;
    };
    const previewBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      deleteUnmatched: boolean;
      files: Record<string, string>;
    };
    expect(validateBody.files).toEqual({ 'project.json': '{"format_version":"2.0"}' });
    expect(previewBody).toMatchObject({
      deleteUnmatched: false,
      files: { 'project.json': '{"format_version":"2.0"}' },
    });
  });

  it('returns apply-ready acknowledgement args when preview issues are fully identifiable', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ valid: true, issues: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          previewDigest: 'digest-1',
          preview: {
            hasBlockingIssues: false,
            nonBlockingIssueCount: 1,
            issues: [{ id: 'warning-1', blocking: false, severity: 'warning' }],
          },
        }),
      );

    const result = JSON.parse(
      await platformValidatePackage(
        {
          projectId: 'proj_123',
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as {
      success: boolean;
      importPreview: {
        canApply: boolean;
        acknowledgementReady: boolean;
        suggestedApplyArgs: { previewDigest: string; acknowledgedIssueIds: string[] };
      };
    };

    expect(result.success).toBe(true);
    expect(result.importPreview).toMatchObject({
      canApply: true,
      acknowledgementReady: true,
      suggestedApplyArgs: {
        previewDigest: 'digest-1',
        acknowledgedIssueIds: ['warning-1'],
      },
    });
  });

  it('marks preview acknowledgement incomplete when issue IDs or digest are missing', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ valid: true, issues: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          preview: {
            hasBlockingIssues: false,
            nonBlockingIssueCount: 1,
            issues: [{ blocking: false, severity: 'warning' }],
          },
        }),
      );

    const result = JSON.parse(
      await platformValidatePackage(
        {
          projectId: 'proj_123',
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as {
      importPreview: {
        canApply: boolean;
        acknowledgementReady: boolean;
        missingAcknowledgementIssueIdCount: number;
        suggestedApplyArgs?: unknown;
      };
    };

    expect(result.importPreview).toMatchObject({
      canApply: false,
      acknowledgementReady: false,
      missingAcknowledgementIssueIdCount: 1,
    });
    expect(result.importPreview.suggestedApplyArgs).toBeUndefined();
  });
});

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}
