import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockApplyStudioLayeredImportV2,
  mockPreviewStudioLayeredImportV2,
  mockNotifyRuntimeModelConfigChanged,
} = vi.hoisted(() => ({
  mockApplyStudioLayeredImportV2: vi.fn(),
  mockPreviewStudioLayeredImportV2: vi.fn(),
  mockNotifyRuntimeModelConfigChanged: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: (ctx: Record<string, unknown>) => Promise<Response>) =>
    async (request: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) =>
      handler({
        request,
        user: { id: 'user-1', tenantId: 'tenant-1', permissions: ['project:*'] },
        params: await routeCtx.params,
        tenantId: 'tenant-1',
      }),
}));

vi.mock('@/lib/project-import/layered-import-support', () => ({
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
  previewStudioLayeredImportV2: (...args: unknown[]) => mockPreviewStudioLayeredImportV2(...args),
}));

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: (...args: unknown[]) =>
    mockNotifyRuntimeModelConfigChanged(...args),
}));

import { POST as APPLY_POST } from '../../app/api/projects/[id]/import/apply/route';
import { POST as PREVIEW_POST } from '../../app/api/projects/[id]/import/preview/route';

const PROJECT_ID = 'project-1';
const IMPORT_FILES = {
  'agents/Main.agent.abl': 'AGENT: Main\nGOAL: Help\n',
};

function makeRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://studio.test${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function routeCtx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

function appliedCounts() {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    toolsCreated: 0,
    toolsUpdated: 0,
    toolsDeleted: 0,
    localesCreated: 0,
    localesUpdated: 0,
    localesDeleted: 0,
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    modelPoliciesUpserted: 0,
    modelPoliciesDeleted: 0,
  };
}

describe('project import conflict strategy parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: { previewDigest: 'preview-digest-1' },
      warnings: [],
    });
    mockApplyStudioLayeredImportV2.mockResolvedValue({
      success: true,
      operationId: 'import-op-1',
      applied: appliedCounts(),
      entryAgentName: 'Main',
      warnings: [],
    });
  });

  it('maps default Studio preview and apply imports to merge strategy', async () => {
    await PREVIEW_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/preview`, { files: IMPORT_FILES }),
      routeCtx(),
    );
    await APPLY_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/apply`, {
        files: IMPORT_FILES,
        previewDigest: 'preview-digest-1',
        acknowledgedIssueIds: [],
      }),
      routeCtx(),
    );

    expect(mockPreviewStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        tenantId: 'tenant-1',
        userId: 'user-1',
        files: expect.any(Map),
        conflictStrategy: 'merge',
      }),
    );
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        tenantId: 'tenant-1',
        userId: 'user-1',
        files: expect.any(Map),
        conflictStrategy: 'merge',
      }),
    );
  });

  it('maps deleteUnmatched Studio preview and apply imports to replace strategy', async () => {
    await PREVIEW_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/preview`, {
        files: IMPORT_FILES,
        deleteUnmatched: true,
      }),
      routeCtx(),
    );
    await APPLY_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/apply`, {
        files: IMPORT_FILES,
        deleteUnmatched: true,
        previewDigest: 'preview-digest-1',
        acknowledgedIssueIds: [],
      }),
      routeCtx(),
    );

    expect(mockPreviewStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictStrategy: 'replace',
      }),
    );
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictStrategy: 'replace',
      }),
    );
  });
});
