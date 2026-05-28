import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformImportExport } from '../tools/platform-import-export.js';
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

describe('platformImportExport', () => {
  it('auto-acknowledges non-blocking preview issues before import/apply', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          previewDigest: 'digest-1',
          preview: {
            hasBlockingIssues: false,
            issues: [
              { id: 'issue-warning', blocking: false, severity: 'warning' },
              { id: 'issue-info', blocking: false, severity: 'info' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, applied: true }));

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0"}',
            'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
          },
        },
        ctx,
      ),
    ) as {
      success: boolean;
      data: {
        autoAcknowledgement: {
          previewDigest: string;
          acknowledgedIssueIds: string[];
          acknowledgedIssueCount: number;
        };
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.autoAcknowledgement).toEqual({
      previewDigest: 'digest-1',
      acknowledgedIssueIds: ['issue-warning', 'issue-info'],
      acknowledgedIssueCount: 2,
      nonBlockingIssueCount: 2,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:5173/api/projects/proj_123/import/preview',
      expect.objectContaining({ method: 'POST' }),
      30_000,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:5173/api/projects/proj_123/import/apply',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"previewDigest":"digest-1"'),
      }),
      30_000,
    );

    const applyBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      acknowledgedIssueIds: string[];
    };
    expect(applyBody.acknowledgedIssueIds).toEqual(['issue-warning', 'issue-info']);
  });

  it('preserves server error bodies for import preview failures', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'INVALID_LAYERS',
            message: 'Unsupported import layer(s): behavior_profiles',
          },
        },
        { status: 400, statusText: 'Bad Request' },
      ),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import_preview',
          projectId: 'proj_123',
          files: {
            'project.json': '{"format_version":"2.0","layers_included":["behavior_profiles"]}',
          },
        },
        ctx,
      ),
    ) as {
      success: boolean;
      status: number;
      body: { error: { code: string; message: string } };
    };

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body.error).toEqual({
      code: 'INVALID_LAYERS',
      message: 'Unsupported import layer(s): behavior_profiles',
    });
  });

  it('normalizes import-style data.files before sending import previews', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        preview: { hasBlockingIssues: false, issues: [] },
      }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import_preview',
          projectId: 'proj_123',
          data: {
            deleteUnmatched: true,
            files: {
              'wrapped-project/project.json': '{"format_version":"2.0"}',
              'wrapped-project/agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
            },
          },
        },
        ctx,
      ),
    ) as {
      success: boolean;
      data: { warnings: string[]; source: { kind: string }; result: unknown };
    };

    expect(result.success).toBe(true);
    expect(result.data.warnings).toContain('Stripped common archive prefix "wrapped-project/".');
    expect(result.data.source).toEqual({ kind: 'inline' });

    const previewBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      deleteUnmatched: boolean;
      files: Record<string, string>;
    };
    expect(previewBody).toMatchObject({
      deleteUnmatched: true,
      files: {
        'project.json': '{"format_version":"2.0"}',
        'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
      },
    });
  });

  it('does not apply imports when preview still has blocking issues', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        previewDigest: 'digest-blocked',
        preview: {
          hasBlockingIssues: true,
          issues: [
            { id: 'missing-profile', blocking: true, severity: 'error' },
            { id: 'non-blocking-warning', blocking: false, severity: 'warning' },
          ],
        },
      }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as { success: boolean; needsResolution: boolean; previewDigest: string };

    expect(result).toMatchObject({
      success: false,
      needsResolution: true,
      previewDigest: 'digest-blocked',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes server response body when entry-agent patch fails after apply', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          previewDigest: 'digest-1',
          preview: {
            hasBlockingIssues: false,
            issues: [],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, applied: true }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: { code: 'PROJECT_LOCKED', message: 'Project is locked' },
          },
          { status: 423, statusText: 'Locked' },
        ),
      );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0","entry_agent":"Support"}',
          },
        },
        ctx,
      ),
    ) as { success: boolean; warning: string };

    expect(result.success).toBe(true);
    expect(result.warning).toContain('PROJECT_LOCKED');
    expect(result.warning).toContain('Project is locked');
  });

  it('refuses auto-acknowledgement when preview issue IDs are missing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        previewDigest: 'digest-unstable',
        preview: {
          hasBlockingIssues: false,
          nonBlockingIssueCount: 1,
          issues: [{ blocking: false, severity: 'warning' }],
        },
      }),
    );

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as { success: boolean; error: string; nonBlockingIssueCount: number };

    expect(result).toMatchObject({
      success: false,
      nonBlockingIssueCount: 1,
    });
    expect(result.error).toContain('stable IDs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auto-previews when callers provide only a partial acknowledgement by default', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          previewDigest: 'fresh-digest',
          preview: {
            hasBlockingIssues: false,
            issues: [{ id: 'warning-id', blocking: false, severity: 'warning' }],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, applied: true }));

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          previewDigest: 'stale-or-partial-digest',
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as { success: boolean };

    expect(result.success).toBe(true);
    const applyBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      previewDigest: string;
      acknowledgedIssueIds: string[];
    };
    expect(applyBody).toMatchObject({
      previewDigest: 'fresh-digest',
      acknowledgedIssueIds: ['warning-id'],
    });
  });

  it('applies without a preview digest when preview has no acknowledgement-required issues', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          preview: {
            hasBlockingIssues: false,
            nonBlockingIssueCount: 0,
            issues: [],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, applied: true }));

    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          autoAcknowledgeNonBlocking: true,
          data: {
            previewDigest: 'stale-digest-from-caller',
            acknowledgedIssueIds: ['stale-warning-id'],
          },
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as { success: boolean };

    expect(result.success).toBe(true);
    const previewBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      previewDigest?: string;
      acknowledgedIssueIds?: string[];
    };
    const applyBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      previewDigest?: string;
      acknowledgedIssueIds: string[];
    };
    expect(previewBody.previewDigest).toBeUndefined();
    expect(previewBody.acknowledgedIssueIds).toBeUndefined();
    expect(applyBody.previewDigest).toBeUndefined();
    expect(applyBody.acknowledgedIssueIds).toEqual([]);
  });

  it('rejects partial manual acknowledgements when auto-ack is disabled', async () => {
    const result = JSON.parse(
      await platformImportExport(
        {
          action: 'import',
          projectId: 'proj_123',
          confirm: true,
          previewDigest: 'digest-only',
          autoAcknowledgeNonBlocking: false,
          files: {
            'project.json': '{"format_version":"2.0"}',
          },
        },
        ctx,
      ),
    ) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires both previewDigest and acknowledgedIssueIds');
    expect(fetchMock).not.toHaveBeenCalled();
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
