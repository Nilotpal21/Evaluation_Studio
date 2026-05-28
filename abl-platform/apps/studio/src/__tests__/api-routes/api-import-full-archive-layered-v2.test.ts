import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LayerName } from '@agent-platform/project-io';

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
const ALL_LAYERS: LayerName[] = [
  'connections',
  'prompts',
  'core',
  'search',
  'workflows',
  'guardrails',
  'evals',
  'channels',
  'vocabulary',
];

const FULL_ARCHIVE_FILES = {
  'project.json': JSON.stringify({
    format_version: '2.0',
    name: 'Full Mercury Archive',
    layers_included: ALL_LAYERS,
    entry_agent: 'MainSupervisor',
  }),
  'connections/mercury-banking.connection.json': JSON.stringify({
    displayName: 'Mercury Banking',
    connectorType: 'openapi',
  }),
  'prompts/customer-care.prompt.json': JSON.stringify({ name: 'Customer Care' }),
  'agents/MainSupervisor.agent.abl': 'AGENT: MainSupervisor\nGOAL: Route customers\n',
  'tools/get_accounts.tools.abl': 'TOOL: get_accounts\nDESCRIPTION: "Read accounts"\n',
  'search/customer-support.index.json': JSON.stringify({ name: 'Customer Support' }),
  'workflows/loan-approval/workflow.json': JSON.stringify({ name: 'Loan Approval' }),
  'guardrails/banking-safety.guardrail.json': JSON.stringify({ name: 'Banking Safety' }),
  'evals/sets/regression.eval-set.json': JSON.stringify({ name: 'Regression' }),
  'channels/web.channel.json': JSON.stringify({ displayName: 'Web Chat' }),
  'vocabulary/banking/domain-vocabulary.json': JSON.stringify({ name: 'Banking Vocabulary' }),
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

function fullArchivePreview() {
  return {
    previewDigest: 'full-archive-preview-digest',
    layers: ALL_LAYERS,
    layerChanges: Object.fromEntries(
      ALL_LAYERS.map((layer) => [layer, { added: 1, modified: 0, removed: 0, unchanged: 0 }]),
    ),
    hasBlockingIssues: false,
    requiresAcknowledgement: false,
    blockingIssueCount: 0,
    nonBlockingIssueCount: 0,
  };
}

function appliedCounts() {
  return {
    created: 1,
    updated: 0,
    deleted: 0,
    toolsCreated: 1,
    toolsUpdated: 0,
    toolsDeleted: 0,
    localesCreated: 0,
    localesUpdated: 0,
    localesDeleted: 0,
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    evalsCreated: 1,
    evalsUpdated: 0,
    evalsDeleted: 0,
    modelPoliciesUpserted: 1,
    modelPoliciesDeleted: 0,
  };
}

describe('full archive import v2 route regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: fullArchivePreview(),
      warnings: [],
    });
    mockApplyStudioLayeredImportV2.mockResolvedValue({
      success: true,
      operationId: 'import-op-full-archive-1',
      applied: appliedCounts(),
      entryAgentName: 'MainSupervisor',
      warnings: [],
    });
  });

  it('previews all supported archive layers through the layered v2 path', async () => {
    const response = await PREVIEW_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/preview`, {
        files: FULL_ARCHIVE_FILES,
        layers: ALL_LAYERS,
      }),
      routeCtx(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      preview: expect.objectContaining({
        layers: ALL_LAYERS,
        layerChanges: expect.objectContaining({
          connections: expect.any(Object),
          prompts: expect.any(Object),
          core: expect.any(Object),
          search: expect.any(Object),
          workflows: expect.any(Object),
          guardrails: expect.any(Object),
          evals: expect.any(Object),
          channels: expect.any(Object),
          vocabulary: expect.any(Object),
        }),
      }),
      previewDigest: 'full-archive-preview-digest',
      warnings: [],
    });
    expect(mockPreviewStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        tenantId: 'tenant-1',
        userId: 'user-1',
        files: expect.any(Map),
        layers: ALL_LAYERS,
        conflictStrategy: 'merge',
      }),
    );
    const [{ files }] = mockPreviewStudioLayeredImportV2.mock.calls[0] as [
      { files: Map<string, string> },
    ];
    expect([...files.keys()].sort()).toEqual(Object.keys(FULL_ARCHIVE_FILES).sort());
  });

  it('applies all supported archive layers and preserves operation diagnostics', async () => {
    const response = await APPLY_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/apply`, {
        files: FULL_ARCHIVE_FILES,
        layers: ALL_LAYERS,
        previewDigest: 'full-archive-preview-digest',
        acknowledgedIssueIds: [],
      }),
      routeCtx(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      operationId: 'import-op-full-archive-1',
      applied: appliedCounts(),
      entryAgentName: 'MainSupervisor',
      warnings: [],
    });
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        tenantId: 'tenant-1',
        userId: 'user-1',
        files: expect.any(Map),
        layers: ALL_LAYERS,
        conflictStrategy: 'merge',
        previewDigest: 'full-archive-preview-digest',
        acknowledgedIssueIds: [],
      }),
    );
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer token',
    });
  });

  it('surfaces blocking full-archive preview issues without dropping diagnostics', async () => {
    mockPreviewStudioLayeredImportV2.mockResolvedValue({
      success: false,
      preview: {
        ...fullArchivePreview(),
        hasBlockingIssues: true,
        requiresAcknowledgement: true,
        blockingIssueCount: 1,
        issues: [
          {
            id: 'workflow-binding-missing',
            severity: 'error',
            message: 'Workflow tool must have workflow_binding',
          },
        ],
      },
      warnings: ['review workflow binding'],
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Import preview contains blocking issues',
      },
    });

    const response = await PREVIEW_POST(
      makeRequest(`/api/projects/${PROJECT_ID}/import/preview`, {
        files: FULL_ARCHIVE_FILES,
        layers: ALL_LAYERS,
      }),
      routeCtx(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      preview: expect.objectContaining({
        layers: ALL_LAYERS,
        hasBlockingIssues: true,
        requiresAcknowledgement: true,
        blockingIssueCount: 1,
        issues: [expect.objectContaining({ id: 'workflow-binding-missing' })],
      }),
      previewDigest: 'full-archive-preview-digest',
      warnings: ['review workflow binding'],
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Import preview contains blocking issues',
      },
    });
  });
});
