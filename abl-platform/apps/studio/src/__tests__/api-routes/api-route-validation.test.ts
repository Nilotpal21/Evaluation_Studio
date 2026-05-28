/**
 * Tests for API route input validation across import, git, permissions, and dependencies routes.
 *
 * Covers: file count/size limits, path traversal, git PATCH whitelist,
 * permissions authorization, dependency agent limit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { rateLimiter } from '@/lib/rate-limiter';

// ─── Shared Mocks ──────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({
    id: 'user-1',
    email: 'test@test.com',
    name: 'Test User',
    tenantId: 'tenant-1',
    role: 'member',
    permissions: ['*:*'],
  })),
  isAuthError: vi.fn(() => false),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: vi.fn(async () => ({
    project: {
      id: 'proj-1',
      name: 'Test',
      slug: 'test',
      ownerId: 'user-1',
      tenantId: 'tenant-1',
    },
  })),
  isAccessError: vi.fn(() => false),
}));

const mockProjectAgentFind = vi.fn();
const mockProjectAgentCreate = vi.fn();
const mockProjectFindById = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockAgentOwnershipFindOneAndUpdate = vi.fn();
const mockNotifyRuntimeModelConfigChanged = vi.fn();
const mockPreviewStudioLayeredImportV2 = vi.fn();
const mockApplyStudioLayeredImportV2 = vi.fn();

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: (...args: unknown[]) =>
    mockNotifyRuntimeModelConfigChanged(...args),
}));

vi.mock('@/lib/project-import/layered-import-support', () => ({
  previewStudioLayeredImportV2: (...args: unknown[]) => mockPreviewStudioLayeredImportV2(...args),
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  COMPLETED_OPERATION_TTL_SECONDS: 3600,
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
    create: (...args: unknown[]) => mockProjectAgentCreate(...args),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn().mockReturnValue({ catch: vi.fn() }),
  },
  Project: {
    findById: (...args: unknown[]) => mockProjectFindById(...args),
    findByIdAndUpdate: vi.fn(),
    findOne: (...args: unknown[]) => mockProjectFindById(...args),
  },
  GitIntegration: {
    findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    findOneAndUpdate: (...args: unknown[]) => mockGitIntegrationFindOneAndUpdate(...args),
    create: vi.fn(),
    deleteOne: vi.fn(),
  },
  AgentOwnership: {
    findOneAndUpdate: (...args: unknown[]) => mockAgentOwnershipFindOneAndUpdate(...args),
  },
  ProjectMember: {
    findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
  },
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
  ProjectLLMConfig: {
    findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
  AgentModelConfig: {
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
  EvalSet: {
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
  },
  EvalScenario: {
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
  },
  EvalPersona: {
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
  },
  EvalEvaluator: {
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
  },
}));

vi.mock('@agent-platform/project-io/import', () => ({
  collectImportedPromptVersionSnapshots: vi.fn(() => []),
  importProject: vi.fn(() => ({
    success: true,
    preview: {
      changes: {
        agents: { added: [], modified: [], removed: [], unchanged: [] },
        tools: { added: [], modified: [], removed: [] },
      },
    },
    operations: [],
  })),
  prepareCoreImportApplyV2: vi.fn(async () => ({
    success: true,
    currentState: {
      agents: [],
      tools: [],
      entryAgentName: null,
    },
    plan: {
      preparedFiles: new Map(),
      preview: {
        valid: true,
        formatVersion: '2.0',
        layers: ['core'],
        layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
        agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
        toolChanges: { added: [], modified: [], removed: [] },
        shaIntegrity: {
          valid: true,
          integrityMatch: true,
          layerResults: {},
          errors: [],
          warnings: [],
        },
        crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
        syntaxErrors: [],
        issues: [],
        hasBlockingIssues: false,
        requiresAcknowledgement: false,
        blockingIssueCount: 0,
        nonBlockingIssueCount: 0,
        entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
        warnings: [],
      },
      agentOperations: [],
      toolOperations: [],
      mcpServerOperations: [],
      localeOperations: [],
      evalOperations: [],
      entryAgentName: null,
      warnings: [],
      applied: {
        created: 0,
        updated: 0,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
      },
    },
  })),
  previewCoreImportV2: vi.fn(async () => ({
    success: true,
    currentState: {
      agents: [],
      tools: [],
      entryAgentName: null,
    },
    plan: {
      preparedFiles: new Map(),
      preview: {
        valid: true,
        formatVersion: '2.0',
        layers: ['core'],
        layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
        agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
        toolChanges: { added: [], modified: [], removed: [] },
        shaIntegrity: {
          valid: true,
          integrityMatch: true,
          layerResults: {},
          errors: [],
          warnings: [],
        },
        crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
        syntaxErrors: [],
        issues: [],
        hasBlockingIssues: false,
        requiresAcknowledgement: false,
        blockingIssueCount: 0,
        nonBlockingIssueCount: 0,
        entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
        warnings: [],
      },
      agentOperations: [],
      toolOperations: [],
      mcpServerOperations: [],
      localeOperations: [],
      evalOperations: [],
      entryAgentName: null,
      warnings: [],
      applied: {
        created: 0,
        updated: 0,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
      },
    },
    preview: {
      valid: true,
      formatVersion: '2.0',
      layers: ['core'],
      layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
      agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
      toolChanges: { added: [], modified: [], removed: [] },
      shaIntegrity: {
        valid: true,
        integrityMatch: true,
        layerResults: {},
        errors: [],
        warnings: [],
      },
      crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
      syntaxErrors: [],
      issues: [],
      hasBlockingIssues: false,
      requiresAcknowledgement: false,
      blockingIssueCount: 0,
      nonBlockingIssueCount: 0,
      entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
      warnings: [],
    },
    warnings: [],
  })),
  buildCoreImportApplyPlanV2: vi.fn(async () => ({
    success: true,
    plan: {
      preparedFiles: new Map(),
      preview: {
        valid: true,
        formatVersion: '2.0',
        layers: ['core'],
        layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
        agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
        toolChanges: { added: [], modified: [], removed: [] },
        shaIntegrity: {
          valid: true,
          integrityMatch: true,
          layerResults: {},
          errors: [],
          warnings: [],
        },
        crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
        syntaxErrors: [],
        issues: [],
        hasBlockingIssues: false,
        requiresAcknowledgement: false,
        blockingIssueCount: 0,
        nonBlockingIssueCount: 0,
        entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
        warnings: [],
      },
      agentOperations: [],
      toolOperations: [],
      mcpServerOperations: [],
      localeOperations: [],
      evalOperations: [],
      entryAgentName: null,
      warnings: [],
      applied: {
        created: 0,
        updated: 0,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        localesCreated: 0,
        localesUpdated: 0,
        localesDeleted: 0,
      },
    },
  })),
  buildCoreImportExistingStateV2: vi.fn(
    (currentState: {
      agents?: Array<{ name: string; dslContent: string | null }>;
      tools?: Array<{ name: string; dslContent: string }>;
    }) => ({
      agents: new Map(
        (currentState.agents ?? []).map((agent) => [
          agent.name,
          { name: agent.name, dslContent: agent.dslContent },
        ]),
      ),
      toolFiles: new Map(),
      tools: new Map(
        (currentState.tools ?? []).map((tool) => [
          tool.name,
          { name: tool.name, dslContent: tool.dslContent },
        ]),
      ),
      activeRecords: new Map(),
    }),
  ),
  applyCoreImportPlanWithSnapshotV2: vi.fn(
    async (input: { plan: { applied: unknown; entryAgentName: unknown } }) => ({
      success: true,
      operationId: 'import-op-1',
      applied: input.plan.applied,
      entryAgentName: input.plan.entryAgentName,
    }),
  ),
  applyCoreImportV2: vi.fn(async () => ({
    success: true,
    operationId: 'import-op-1',
    applied: {
      created: 0,
      updated: 0,
      deleted: 0,
      toolsCreated: 0,
      toolsUpdated: 0,
      toolsDeleted: 0,
    },
    entryAgentName: null,
    warnings: [],
    preview: {
      valid: true,
      formatVersion: '2.0',
      layers: ['core'],
      layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
      agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
      toolChanges: { added: [], modified: [], removed: [] },
      shaIntegrity: {
        valid: true,
        integrityMatch: true,
        layerResults: {},
        errors: [],
        warnings: [],
      },
      crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
      syntaxErrors: [],
      issues: [],
      hasBlockingIssues: false,
      requiresAcknowledgement: false,
      blockingIssueCount: 0,
      nonBlockingIssueCount: 0,
      entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
      warnings: [],
    },
  })),
  revertCoreImportFromSnapshotV2: vi.fn(async () => ({
    success: true,
    operationId: 'revert-op-1',
    applied: {
      created: 0,
      updated: 0,
      deleted: 0,
      toolsCreated: 0,
      toolsUpdated: 0,
      toolsDeleted: 0,
    },
    entryAgentName: null,
  })),
}));

vi.mock('@agent-platform/project-io/export', () => ({
  computeSourceHash: vi.fn(() => 'hash123'),
}));

vi.mock('@agent-platform/project-io/dependencies', () => ({
  buildDependencyGraph: vi.fn(() => ({
    agents: [],
    toolFiles: [],
    edges: [],
    adjacency: new Map(),
    reverseAdjacency: new Map(),
  })),
  validateDependencies: vi.fn(() => ({ valid: true, missing: [], circular: [] })),
  getAgentDependencies: vi.fn(() => []),
  getAgentDependents: vi.fn(() => []),
}));

function makeRequest(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractErrorText(body: Record<string, unknown>): string {
  const directError =
    typeof body.error === 'string'
      ? body.error
      : typeof body.error === 'object' && body.error !== null
        ? String((body.error as { message?: unknown }).message ?? '')
        : '';
  const errors = Array.isArray(body.errors)
    ? body.errors
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object') {
            return String(
              (entry as { msg?: unknown; message?: unknown }).msg ??
                (entry as { message?: unknown }).message ??
                '',
            );
          }
          return '';
        })
        .filter(Boolean)
        .join(' | ')
    : '';

  return [directError, errors, JSON.stringify(body)].filter(Boolean).join(' | ');
}

const routeParams = { params: Promise.resolve({ id: 'proj-1' }) };
const routeParamsWithAgent = { params: Promise.resolve({ id: 'proj-1', agentId: 'agent-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiter.clear();
  mockProjectAgentFind.mockReturnValue({
    lean: () => Promise.resolve([]),
    limit: () => ({
      lean: () => Promise.resolve([]),
    }),
  });
  mockProjectFindById.mockReturnValue({
    lean: () => Promise.resolve({ _id: 'proj-1', ownerId: 'user-1', tenantId: 'tenant-1' }),
  });
  mockGitIntegrationFindOneAndUpdate.mockReturnValue({
    lean: () => Promise.resolve({ defaultBranch: 'main' }),
  });
  mockAgentOwnershipFindOneAndUpdate.mockResolvedValue({});
  mockPreviewStudioLayeredImportV2.mockResolvedValue({
    success: true,
    preview: {
      valid: true,
      formatVersion: '2.0',
      layers: ['core'],
      layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
      agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
      toolChanges: { added: [], modified: [], removed: [] },
      shaIntegrity: {
        valid: true,
        integrityMatch: true,
        layerResults: {},
        errors: [],
        warnings: [],
      },
      crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
      syntaxErrors: [],
      issues: [],
      hasBlockingIssues: false,
      requiresAcknowledgement: false,
      blockingIssueCount: 0,
      nonBlockingIssueCount: 0,
      entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
      warnings: [],
      previewDigest: 'digest-1',
    },
    warnings: [],
  });
  mockApplyStudioLayeredImportV2.mockResolvedValue({
    success: true,
    operationId: 'import-op-1',
    applied: {
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
    },
    entryAgentName: null,
    warnings: [],
  });
});

// ─── Import Preview Validation ──────────────────────────────────────────────

describe('import preview route validation', () => {
  let importPreviewHandler: (req: NextRequest, ctx: typeof routeParams) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/import/preview/route');
    importPreviewHandler = mod.POST;
  });

  it('should reject file count > 500', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 501; i++) {
      files[`agents/agent_${i}.abl`] = 'AGENT: a\nGOAL: h';
    }
    const req = makeRequest('/api/projects/proj-1/import/preview', { files });
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(extractErrorText(body)).toContain('Too many files');
  });

  it('should reject single file > 1MB', async () => {
    const largeContent = 'x'.repeat(1024 * 1024 + 1);
    const req = makeRequest('/api/projects/proj-1/import/preview', {
      files: { 'agents/big.abl': largeContent },
    });
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(extractErrorText(body)).toContain('File too large');
  });

  it('should reject path with ..', async () => {
    const req = makeRequest('/api/projects/proj-1/import/preview', {
      files: { '../../../etc/passwd': 'malicious' },
    });
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(extractErrorText(body)).toContain('Invalid file path');
  });

  it('should reject absolute path starting with /', async () => {
    const req = makeRequest('/api/projects/proj-1/import/preview', {
      files: { '/etc/passwd': 'malicious' },
    });
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(extractErrorText(body)).toContain('Invalid file path');
  });

  it('should reject invalid JSON bodies with an explicit import error', async () => {
    const req = new NextRequest(
      new URL('/api/projects/proj-1/import/preview', 'http://localhost:3000'),
      {
        method: 'POST',
        body: '{invalid json',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Invalid JSON body',
      },
    });
  });

  it('should preserve preview failures as non-2xx import responses', async () => {
    mockPreviewStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      preview: {
        valid: false,
        formatVersion: '2.0',
        layers: ['core'],
        layerChanges: { core: { added: 0, modified: 0, removed: 0, unchanged: 0 } },
        agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
        toolChanges: { added: [], modified: [], removed: [] },
        shaIntegrity: {
          valid: true,
          integrityMatch: true,
          layerResults: {},
          errors: [],
          warnings: [],
        },
        crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
        syntaxErrors: [],
        issues: [],
        hasBlockingIssues: true,
        requiresAcknowledgement: false,
        blockingIssueCount: 1,
        nonBlockingIssueCount: 0,
        entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
        warnings: [],
        previewDigest: 'digest-1',
      },
      warnings: ['Preview stopped after validation'],
      error: {
        code: 'IMPORT_PREVIEW_PARTIAL',
        message: 'Preview stopped after blocking validation issues were found.',
      },
    });

    const req = makeRequest('/api/projects/proj-1/import/preview', {
      files: { 'agents/test.abl': 'AGENT: Test\nGOAL: Help\n' },
    });
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      warnings: ['Preview stopped after validation'],
      error: {
        code: 'IMPORT_PREVIEW_PARTIAL',
        message: 'Preview stopped after blocking validation issues were found.',
      },
      previewDigest: 'digest-1',
      preview: {
        hasBlockingIssues: true,
      },
    });
  });

  it('should forward requested layers into the layered preview path', async () => {
    const req = makeRequest('/api/projects/proj-1/import/preview', {
      files: { 'agents/test.abl': 'AGENT: Test\nGOAL: Help\n' },
      layers: ['core'],
    });
    const res = await importPreviewHandler(req, routeParams);

    expect(res.status).toBe(200);
    expect(mockPreviewStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        layers: ['core'],
        conflictStrategy: 'merge',
      }),
    );
  });
});

// ─── Import Apply Validation ────────────────────────────────────────────────

describe('import apply route validation', () => {
  let importApplyHandler: (req: NextRequest, ctx: typeof routeParams) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/import/apply/route');
    importApplyHandler = mod.POST;
  });

  it('should reject total size > 50MB', async () => {
    // 50MB = 52,428,800 bytes. 53 files at 999,999 chars each = 52,999,947 > 50MB
    const manyFiles: Record<string, string> = {};
    for (let i = 0; i < 53; i++) {
      manyFiles[`agents/agent_${i}.abl`] = 'x'.repeat(999_999);
    }
    const req = makeRequest('/api/projects/proj-1/import/apply', { files: manyFiles });
    const res = await importApplyHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(extractErrorText(body)).toContain('Total upload size exceeds 50MB');
  });

  it('should reject non-string file content', async () => {
    const req = makeRequest('/api/projects/proj-1/import/apply', {
      files: { 'agents/test.abl': 12345 },
    });
    const res = await importApplyHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(extractErrorText(body)).toContain('File content must be a string');
  });

  it('should reject invalid JSON bodies with an explicit import error', async () => {
    const req = new NextRequest(
      new URL('/api/projects/proj-1/import/apply', 'http://localhost:3000'),
      {
        method: 'POST',
        body: '{invalid json',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const res = await importApplyHandler(req, routeParams);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Invalid JSON body',
      },
    });
  });

  it('should preserve apply-stage failures with metadata', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'apply',
      operationId: 'import-op-1',
      warnings: ['Snapshot created'],
      preview: {
        valid: true,
        formatVersion: '2.0',
        layers: ['core'],
        layerChanges: { core: { added: 1, modified: 0, removed: 0, unchanged: 0 } },
        agentChanges: { added: ['Test'], modified: [], removed: [], unchanged: [] },
        toolChanges: { added: [], modified: [], removed: [] },
        shaIntegrity: {
          valid: true,
          integrityMatch: true,
          layerResults: {},
          errors: [],
          warnings: [],
        },
        crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
        syntaxErrors: [],
        issues: [],
        hasBlockingIssues: false,
        requiresAcknowledgement: false,
        blockingIssueCount: 0,
        nonBlockingIssueCount: 0,
        entryAgentResolution: { requested: null, resolved: 'Test', matchedBy: 'exact' },
        warnings: [],
        previewDigest: 'digest-1',
      },
      error: {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply.',
        stage: 'apply',
        sanitizedCause: 'Persistence operation failed',
      },
    });

    const req = makeRequest('/api/projects/proj-1/import/apply', {
      files: { 'agents/test.abl': 'AGENT: Test\nGOAL: Help\n' },
      previewDigest: 'digest-1',
      acknowledgedIssueIds: [],
    });
    const res = await importApplyHandler(req, routeParams);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      operationId: 'import-op-1',
      warnings: ['Snapshot created'],
      error: {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply.',
        stage: 'apply',
        sanitizedCause: 'Persistence operation failed',
      },
      previewDigest: 'digest-1',
      preview: {
        agentChanges: {
          added: ['Test'],
        },
      },
    });
  });

  it('should notify runtime cache invalidation when imported model policy config changes', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: true,
      operationId: 'import-op-1',
      applied: {
        created: 0,
        updated: 0,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        modelPoliciesUpserted: 1,
        modelPoliciesDeleted: 0,
      },
      entryAgentName: null,
      warnings: [],
    });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/import/apply', 'http://localhost:3000'),
      {
        method: 'POST',
        body: JSON.stringify({
          files: {
            'config/llm-config.json': JSON.stringify({
              operationTierOverrides: { realtime_voice: 'voice' },
            }),
          },
          previewDigest: 'digest-1',
          acknowledgedIssueIds: [],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer studio-token',
        },
      },
    );

    const res = await importApplyHandler(req, routeParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      applied: { modelPoliciesUpserted: 1 },
    });
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer studio-token',
    });
  });

  it('should forward requested layers into the layered apply path', async () => {
    const req = makeRequest('/api/projects/proj-1/import/apply', {
      files: { 'agents/test.abl': 'AGENT: Test\nGOAL: Help\n' },
      layers: ['core', 'evals'],
      previewDigest: 'digest-1',
      acknowledgedIssueIds: [],
    });
    const res = await importApplyHandler(req, routeParams);

    expect(res.status).toBe(200);
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        layers: ['core', 'evals'],
        conflictStrategy: 'merge',
      }),
    );
  });
});

// ─── Git PATCH Whitelist ────────────────────────────────────────────────────

describe('git PATCH route whitelist', () => {
  let gitPatchHandler: (req: NextRequest, ctx: typeof routeParams) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/git/route');
    gitPatchHandler = mod.PATCH;
  });

  it('should accept allowed field (defaultBranch)', async () => {
    const req = makeRequest('/api/projects/proj-1/git', { defaultBranch: 'develop' }, 'PATCH');
    const res = await gitPatchHandler(req, routeParams);

    // Should succeed (not 400)
    expect(res.status).not.toBe(400);
  });

  it('should reject when only disallowed fields are sent', async () => {
    const req = makeRequest(
      '/api/projects/proj-1/git',
      {
        token: 'stolen-token',
        repositoryUrl: 'http://evil.com',
      },
      'PATCH',
    );
    const res = await gitPatchHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('No valid fields');
  });

  it('should strip disallowed fields and apply allowed ones', async () => {
    const req = makeRequest(
      '/api/projects/proj-1/git',
      {
        defaultBranch: 'develop',
        token: 'stolen-token',
        provider: 'evil-provider',
      },
      'PATCH',
    );
    const res = await gitPatchHandler(req, routeParams);

    // Should succeed — allowed field present
    expect(res.status).not.toBe(400);

    // Verify only allowed fields were passed to the update
    const updateCall = mockGitIntegrationFindOneAndUpdate.mock.calls[0];
    expect(updateCall).toBeDefined();
    const updateBody = updateCall[1];
    expect(updateBody.$set).toHaveProperty('defaultBranch', 'develop');
    expect(updateBody.$set).not.toHaveProperty('token');
    expect(updateBody.$set).not.toHaveProperty('provider');
  });
});

// ─── Permissions Authorization ──────────────────────────────────────────────

describe('permissions route authorization', () => {
  let permissionsHandler: (req: NextRequest, ctx: typeof routeParamsWithAgent) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/agents/[agentId]/permissions/route');
    permissionsHandler = mod.POST;
  });

  it('should return 403 for non-owner non-admin', async () => {
    // Project ownerId is different from user, and user role is 'member'
    mockProjectFindById.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'proj-1', ownerId: 'other-owner', tenantId: 'tenant-1' }),
    });

    const req = makeRequest('/api/projects/proj-1/agents/agent-1/permissions', {
      principalType: 'user',
      principalId: 'user-2',
      operations: ['edit'],
    });
    const res = await permissionsHandler(req, routeParamsWithAgent);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('owner or admin');
  });
});

// ─── Dependencies Agent Limit ───────────────────────────────────────────────

describe('dependencies route agent limit', () => {
  let dependenciesHandler: (req: NextRequest, ctx: typeof routeParams) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/dependencies/route');
    dependenciesHandler = mod.GET;
  });

  it('should return 400 when agents exceed 1000', async () => {
    const agents = Array.from({ length: 1001 }, (_, i) => ({
      name: `agent_${i}`,
      dslContent: `AGENT: agent_${i}\nGOAL: Help
GOAL: "Handle agent tasks"`,
      domain: 'default',
    }));
    mockProjectAgentFind.mockReturnValue({
      limit: () => ({
        lean: () => Promise.resolve(agents),
      }),
    });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/dependencies', 'http://localhost:3000'),
      {
        method: 'GET',
      },
    );
    const res = await dependenciesHandler(req, routeParams);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Too many agents');
  });

  it('should return 200 when agents are under limit', async () => {
    const agents = [
      { name: 'agent_a', dslContent: 'AGENT: agent_a\nGOAL: Help', domain: 'default' },
      { name: 'agent_b', dslContent: 'AGENT: agent_b\nGOAL: Help', domain: 'default' },
    ];
    mockProjectAgentFind.mockReturnValue({
      limit: () => ({
        lean: () => Promise.resolve(agents),
      }),
    });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/dependencies', 'http://localhost:3000'),
      {
        method: 'GET',
      },
    );
    const res = await dependenciesHandler(req, routeParams);

    expect(res.status).toBe(200);
  });
});
