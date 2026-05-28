/**
 * Tests for Studio Tool API Routes (project_tools — single collection, no versioning)
 *
 * Covers:
 *   GET/POST  /api/projects/:id/tools                          - List / create project tools
 *   GET/PUT/DELETE /api/projects/:id/tools/:toolId              - Get / update / delete project tool
 *   GET       /api/projects/:id/tools/:toolId/export            - Export tool as JSON
 *   POST      /api/projects/:id/tools/:toolId/duplicate         - Duplicate tool
 *   POST      /api/projects/:id/tools/import                    - Import tool
 *   POST      /api/projects/:id/tools/:toolId/test              - Test tool execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — server-only (auth.ts imports 'server-only' which throws in non-server env)
// ---------------------------------------------------------------------------

vi.mock('server-only', () => ({}));

// ---------------------------------------------------------------------------
// Mocks — auth
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — project access
// ---------------------------------------------------------------------------

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mocks — audit service
// ---------------------------------------------------------------------------

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  AuditActions: {
    TOOL_CREATED: 'TOOL_CREATED',
    TOOL_UPDATED: 'TOOL_UPDATED',
    TOOL_DELETED: 'TOOL_DELETED',
  },
}));

// ---------------------------------------------------------------------------
// Mocks — repos (project_tools — single collection)
// ---------------------------------------------------------------------------

const mockFindProjectToolsByProject = vi.fn();
const mockFindProjectToolById = vi.fn();
const mockFindProjectToolByName = vi.fn();
const mockCreateProjectTool = vi.fn();
const mockUpdateProjectTool = vi.fn();
const mockDeleteProjectTool = vi.fn();
const mockCountProjectToolsByProject = vi.fn().mockResolvedValue(0);
const mockRefreshProjectAgentDraftMetadataForToolMutation = vi.fn().mockResolvedValue(undefined);

vi.mock('@agent-platform/shared/repos', () => ({
  findProjectToolsByProject: mockFindProjectToolsByProject,
  findProjectToolById: mockFindProjectToolById,
  findProjectToolByName: mockFindProjectToolByName,
  createProjectTool: mockCreateProjectTool,
  updateProjectTool: mockUpdateProjectTool,
  deleteProjectTool: mockDeleteProjectTool,
  countProjectToolsByProject: mockCountProjectToolsByProject,
}));

vi.mock('@/lib/project-tool-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForToolMutation: (...args: unknown[]) =>
    mockRefreshProjectAgentDraftMetadataForToolMutation(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — SSRF validation
// ---------------------------------------------------------------------------

const mockValidateUrlWithPlaceholders = vi.fn().mockResolvedValue({ safe: true });

vi.mock('@/lib/resolve-and-validate-url', () => ({
  validateUrlWithPlaceholders: mockValidateUrlWithPlaceholders,
}));

// ---------------------------------------------------------------------------
// Mocks — shared utilities
// ---------------------------------------------------------------------------

const mockSerializeToolFormToDsl = vi.fn().mockReturnValue('mock_tool() -> object\n  type: http');
const mockComputeSourceHash = vi.fn().mockReturnValue('a'.repeat(64));
const mockParseDslProperties = vi.fn((dslContent: string) => {
  const props: Record<string, string> = {};
  const type = dslContent.match(/^\s*type:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
  const endpoint = dslContent.match(/^\s*endpoint:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
  if (type) props.type = type;
  if (endpoint) props.endpoint = endpoint;
  return props;
});

vi.mock('@agent-platform/shared', () => ({
  serializeToolFormToDsl: mockSerializeToolFormToDsl,
  computeSourceHash: mockComputeSourceHash,
  parseDslProperties: mockParseDslProperties,
}));

// ---------------------------------------------------------------------------
// Mocks — validation
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/validation', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/shared/validation')>(
    '@agent-platform/shared/validation',
  );
  return {
    ...actual,
  };
});

// ---------------------------------------------------------------------------
// Mocks — tool test service
// ---------------------------------------------------------------------------

const mockExecuteToolTest = vi.fn();

vi.mock('@/services/tool-test-service', () => ({
  executeToolTest: mockExecuteToolTest,
}));

// ---------------------------------------------------------------------------
// Mocks — database models
// ---------------------------------------------------------------------------

const mockProjectAgentFind = vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) });
const mockWorkflowFindOne = vi.fn();
const mockWorkflowVersionFindOne = vi.fn();
const mockTriggerRegistrationFindOne = vi.fn();
const mockSearchIndexFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  TOOL_TYPES: ['http', 'mcp', 'sandbox'],
  ProjectMember: { findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }) },
  ProjectAgent: { find: mockProjectAgentFind },
  Workflow: { findOne: mockWorkflowFindOne },
  WorkflowVersion: { findOne: mockWorkflowVersionFindOne },
  TriggerRegistration: { findOne: mockTriggerRegistrationFindOne },
  SearchIndex: { findOne: mockSearchIndexFindOne },
  AuditLog: {
    create: vi.fn().mockResolvedValue({ toObject: () => ({ _id: 'audit-1', action: 'test' }) }),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
  },
  VariableNamespace: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'ns-default', name: 'default', isDefault: true }),
    }),
    create: vi.fn().mockResolvedValue({
      toObject: () => ({ _id: 'ns-default', name: 'default', isDefault: true }),
    }),
  },
  EnvironmentVariable: {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    }),
  },
  ProjectConfigVariable: {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    }),
  },
  VariableNamespaceMembership: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['*:*'],
};

const testProject = {
  id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'user-1',
  tenantId: 'tenant-1',
};

const baseProjectTool = {
  id: 'tool-1',
  name: 'my_http_tool',
  slug: 'my_http_tool',
  toolType: 'http',
  description: 'Fetches data',
  dslContent: [
    'my_http_tool() -> object',
    '  description: "Fetches data"',
    '  type: http',
    '  endpoint: "https://api.example.com/data"',
    '  method: GET',
  ].join('\n'),
  sourceHash: 'a'.repeat(64),
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  createdBy: 'Test User',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

type RouteCtx = { params: Promise<Record<string, string>> };

function makeRequest(url: string, method = 'GET', body?: unknown): NextRequest {
  const opts: any = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
  mockValidateUrlWithPlaceholders.mockResolvedValue({ safe: true });
  mockSerializeToolFormToDsl.mockReturnValue('mock_tool() -> object\n  type: http');
  mockComputeSourceHash.mockReturnValue('a'.repeat(64));
  mockParseDslProperties.mockImplementation((dslContent: string) => {
    const props: Record<string, string> = {};
    const type = dslContent.match(/^\s*type:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
    const endpoint = dslContent.match(/^\s*endpoint:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
    if (type) props.type = type;
    if (endpoint) props.endpoint = endpoint;
    return props;
  });
  mockCountProjectToolsByProject.mockResolvedValue(0);
  mockWorkflowFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({ _id: 'wf-refund', status: 'active', deleted: false }),
  });
  mockWorkflowVersionFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mockTriggerRegistrationFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      _id: 'manual',
      workflowId: 'wf-refund',
      triggerType: 'webhook',
      status: 'active',
    }),
  });
  mockSearchIndexFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      _id: 'idx-refunds',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    }),
  });
});

// ===========================================================================
// GET /api/projects/:id/tools
// ===========================================================================

describe('GET /api/projects/:id/tools', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/route');
    handler = mod.GET;
  });

  it('returns paginated project tool list', async () => {
    mockFindProjectToolsByProject.mockResolvedValue({
      data: [baseProjectTool],
      pagination: { page: 1, limit: 20, total: 1, hasMore: false },
    });

    const req = makeRequest('/api/projects/proj-1/tools?page=1&limit=20');
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });

  it('passes filter params to repo (tenant-isolated)', async () => {
    mockFindProjectToolsByProject.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, hasMore: false },
    });

    const req = makeRequest(
      '/api/projects/proj-1/tools?page=2&limit=10&sort=name&order=asc&toolType=http&search=fetch',
    );
    await handler(req, routeCtx({ id: 'proj-1' }));

    expect(mockFindProjectToolsByProject).toHaveBeenCalledWith('tenant-1', 'proj-1', {
      page: 2,
      limit: 10,
      sort: 'name',
      order: 'asc',
      toolType: 'http',
      search: 'fetch',
    });
  });

  it('returns 401 when not authenticated', async () => {
    const authResp = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResp);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/projects/proj-1/tools');
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// POST /api/projects/:id/tools
// ===========================================================================

describe('POST /api/projects/:id/tools', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/route');
    handler = mod.POST;
  });

  it('creates project tool and returns 201', async () => {
    mockFindProjectToolByName.mockResolvedValue(null); // no conflict
    mockCreateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools', 'POST', {
      name: 'my_http_tool',
      toolType: 'http',
      description: 'Fetches data',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
    });
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tool).toBeDefined();
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('passes tenantId to createProjectTool (tenant isolation)', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools', 'POST', {
      name: 'my_http_tool',
      toolType: 'http',
      description: 'Fetches data',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
    });
    await handler(req, routeCtx({ id: 'proj-1' }));

    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'my_http_tool',
        createdBy: 'Test User',
      }),
    );
  });

  it('creates SearchAI tool DSL with tenant_id derived from auth context', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      name: 'search_docs',
      toolType: 'searchai',
    });
    mockSerializeToolFormToDsl.mockReturnValueOnce(`search_docs(query: string) -> object
  description: "Search docs"
  type: searchai
  index_id: idx_docs
  tenant_id: tenant-1`);

    const req = makeRequest('/api/projects/proj-1/tools', 'POST', {
      name: 'search_docs',
      toolType: 'searchai',
      description: 'Search docs',
      indexId: 'idx_docs',
      kbName: 'Docs',
    });
    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(201);
    expect(mockSerializeToolFormToDsl).toHaveBeenCalledWith(
      expect.objectContaining({
        toolType: 'searchai',
        indexId: 'idx_docs',
        tenantId: 'tenant-1',
      }),
    );
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'search_docs',
        toolType: 'searchai',
        dslContent: expect.stringContaining('tenant_id: tenant-1'),
      }),
    );
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        dslContent: expect.stringContaining('index_id: idx_docs'),
      }),
    );
  });

  it('returns 409 when tool name already exists', async () => {
    mockFindProjectToolByName.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools', 'POST', {
      name: 'my_http_tool',
      toolType: 'http',
      description: 'Fetches data',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
    });
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns a product-facing duplicate-name message when create collides on slug', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { slug: 1 },
      }),
    );

    const req = makeRequest('/api/projects/proj-1/tools', 'POST', {
      name: 'my_http_tool',
      toolType: 'http',
      description: 'Fetches data',
      endpoint: 'https://api.example.com/data',
      method: 'GET',
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      errors: [
        {
          msg: 'Tool with the same name already exists',
          code: 'NAME_CONFLICT',
        },
      ],
    });
  });
});

// ===========================================================================
// GET /api/projects/:id/tools/:toolId
// ===========================================================================

describe('GET /api/projects/:id/tools/:toolId', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/[toolId]/route');
    handler = mod.GET;
  });

  it('returns project tool by ID', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tool).toBeDefined();
    expect(body.tool.name).toBe('my_http_tool');
  });

  it('returns 404 when tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/bad-id');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'bad-id' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('passes tenantId and projectId to findProjectToolById (tenant isolation)', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1');
    await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(mockFindProjectToolById).toHaveBeenCalledWith('tool-1', 'tenant-1', 'proj-1');
  });
});

// ===========================================================================
// PUT /api/projects/:id/tools/:toolId
// ===========================================================================

describe('PUT /api/projects/:id/tools/:toolId', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/[toolId]/route');
    handler = mod.PUT;
  });

  it('updates tool dslContent and returns updated tool', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    const updatedTool = { ...baseProjectTool, description: 'New desc' };
    mockUpdateProjectTool.mockResolvedValue(updatedTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      description: 'New desc',
      dslContent: [
        'my_http_tool() -> object',
        '  type: http',
        '  endpoint: "https://api.example.com"',
        '  method: GET',
      ].join('\n'),
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('rewrites dslContent and sourceHash when renaming without an explicit DSL update', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockFindProjectToolByName.mockResolvedValue(null);
    const renamedDslContent = [
      'renamed_http_tool() -> object',
      '  description: "Fetches data"',
      '  type: http',
      '  endpoint: "https://api.example.com/data"',
      '  method: GET',
    ].join('\n');
    mockUpdateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      name: 'renamed_http_tool',
      dslContent: renamedDslContent,
      sourceHash: 'a'.repeat(64),
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      name: 'renamed_http_tool',
    });

    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(res.status).toBe(200);
    expect(mockComputeSourceHash).toHaveBeenCalledWith(renamedDslContent);
    expect(mockUpdateProjectTool).toHaveBeenCalledWith(
      'tool-1',
      'tenant-1',
      'proj-1',
      expect.objectContaining({
        name: 'renamed_http_tool',
        dslContent: renamedDslContent,
        sourceHash: 'a'.repeat(64),
      }),
    );
  });

  it('rejects dslContent updates when the signature name diverges from the stored tool name', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      dslContent: [
        'other_http_tool() -> object',
        '  type: http',
        '  endpoint: "https://api.example.com"',
      ].join('\n'),
    });

    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(res.status).toBe(400);
    expect(mockUpdateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects dslContent updates that fail type-specific validation', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      name: 'run_refund_workflow',
      toolType: 'workflow',
      dslContent: [
        'run_refund_workflow(order_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "wf-refund"',
        '  trigger_id: "manual"',
      ].join('\n'),
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      dslContent: [
        'run_refund_workflow(order_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "wf-refund"',
      ].join('\n'),
    });

    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(res.status).toBe(400);
    expect(mockUpdateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects workflow dslContent updates when the referenced workflow is missing', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      name: 'run_refund_workflow',
      toolType: 'workflow',
      dslContent: [
        'run_refund_workflow(order_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "wf-refund"',
        '  trigger_id: "manual"',
      ].join('\n'),
    });
    mockWorkflowFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      dslContent: [
        'run_refund_workflow(order_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "wf-missing"',
        '  trigger_id: "manual"',
      ].join('\n'),
    });

    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(res.status).toBe(404);
    expect(mockWorkflowFindOne).toHaveBeenCalledWith({
      _id: 'wf-missing',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(mockUpdateProjectTool).not.toHaveBeenCalled();
  });

  it('returns 404 when tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/bad-id', 'PUT', {
      description: 'x',
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'bad-id' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 when updateProjectTool returns null', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockUpdateProjectTool.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      description: 'x',
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(404);
  });

  it('passes tenantId to updateProjectTool (tenant isolation)', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockUpdateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      description: 'New',
    });
    await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(mockUpdateProjectTool).toHaveBeenCalledWith(
      'tool-1',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ description: 'New' }),
    );
  });

  it('validates config-placeholder endpoint updates against linked namespaces', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      variableNamespaceIds: ['ns-tools'],
    });
    mockUpdateProjectTool.mockResolvedValue(baseProjectTool);

    const dslContent = [
      'my_http_tool() -> object',
      '  type: http',
      '  endpoint: "{{config.API_BASE}}/data"',
      '  method: GET',
    ].join('\n');
    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      dslContent,
    });

    await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(mockValidateUrlWithPlaceholders).toHaveBeenCalledWith(
      '{{config.API_BASE}}/data',
      'tenant-1',
      'proj-1',
      'dev',
      {
        allowUnresolvedEnvPlaceholders: true,
        variableNamespaceIds: ['ns-tools'],
        useDefaultNamespaceFallback: false,
      },
    );
  });

  it('warns when {{config.*}} placeholders lose all namespace links without changing DSL', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      dslContent: [
        'my_http_tool() -> object',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/data"',
        '  method: GET',
      ].join('\n'),
      variableNamespaceIds: ['ns-tools'],
    });
    mockUpdateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      variableNamespaceIds: [],
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      variableNamespaceIds: [],
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.warnings).toEqual([
      'Variable "API_BASE" will not resolve — tool has no linked namespaces',
    ]);
  });

  it('warns when changed DSL introduces config placeholders on a tool with no namespace links', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      variableNamespaceIds: [],
    });
    mockUpdateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      dslContent: [
        'my_http_tool() -> object',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/data"',
        '  method: GET',
      ].join('\n'),
      variableNamespaceIds: [],
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      dslContent: [
        'my_http_tool() -> object',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/data"',
        '  method: GET',
      ].join('\n'),
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockUpdateProjectTool).toHaveBeenCalledWith(
      'tool-1',
      'tenant-1',
      'proj-1',
      expect.not.objectContaining({ variableNamespaceIds: expect.anything() }),
    );
    expect(body.warnings).toEqual([
      'Variable "API_BASE" will not resolve — tool has no linked namespaces',
    ]);
  });

  it('scopes config namespace membership validation by tenantId and projectId', async () => {
    const { ProjectConfigVariable, VariableNamespaceMembership } =
      await import('@agent-platform/database/models');

    vi.mocked(ProjectConfigVariable.findOne).mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'cfg-api-base', value: 'https://api.example.com' }),
      }),
    } as any);
    vi.mocked(VariableNamespaceMembership.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);

    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      dslContent: [
        'my_http_tool() -> object',
        '  type: http',
        '  endpoint: "{{config.API_BASE}}/data"',
        '  method: GET',
      ].join('\n'),
      variableNamespaceIds: ['ns-tools'],
    });
    mockUpdateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'PUT', {
      variableNamespaceIds: ['ns-tools'],
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.warnings).toEqual([
      `Variable "API_BASE" exists but is not in any of the tool's linked namespaces`,
    ]);
    expect(VariableNamespaceMembership.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      variableId: 'cfg-api-base',
      variableType: 'config',
      namespaceId: { $in: ['ns-tools'] },
    });
  });
});

// ===========================================================================
// DELETE /api/projects/:id/tools/:toolId
// ===========================================================================

describe('DELETE /api/projects/:id/tools/:toolId', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/[toolId]/route');
    handler = mod.DELETE;
    mockProjectAgentFind.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  it('deletes tool directly when no agents reference it', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockDeleteProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'DELETE');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe('tool-1');
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('returns 409 when agents reference the tool and force is not set', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockProjectAgentFind.mockReturnValue({
      lean: () => Promise.resolve([{ name: 'booking_agent' }, { name: 'support_agent' }]),
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'DELETE');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0].msg).toContain('booking_agent');
    expect(body.errors[0].msg).toContain('support_agent');
    expect(mockDeleteProjectTool).not.toHaveBeenCalled();
  });

  it('deletes tool with force=true even when agents reference it', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockDeleteProjectTool.mockResolvedValue(baseProjectTool);
    mockProjectAgentFind.mockReturnValue({
      lean: () => Promise.resolve([{ name: 'booking_agent' }]),
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1?force=true', 'DELETE');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe('tool-1');
  });

  it('returns 404 when tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/bad-id', 'DELETE');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'bad-id' }));
    expect(res.status).toBe(404);
  });

  it('passes tenantId to deleteProjectTool (tenant isolation)', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockDeleteProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1', 'DELETE');
    await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(mockDeleteProjectTool).toHaveBeenCalledWith('tool-1', 'tenant-1', 'proj-1');
  });
});

// ===========================================================================
// GET /api/projects/:id/tools/:toolId/export
// ===========================================================================

describe('GET /api/projects/:id/tools/:toolId/export', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/[toolId]/export/route');
    handler = mod.GET;
  });

  it('exports tool with sanitized fields', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/export');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.export.exportVersion).toBe(2);
    expect(body.export.tool).toBeDefined();
    // Internal fields stripped
    expect(body.export.tool.tenantId).toBeUndefined();
    expect(body.export.tool.id).toBeUndefined();
    expect(body.export.tool.projectId).toBeUndefined();
  });

  it('returns 404 when tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/bad-id/export');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'bad-id' }));
    expect(res.status).toBe(404);
  });

  it('passes tenantId to findProjectToolById (tenant isolation)', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/export');
    await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(mockFindProjectToolById).toHaveBeenCalledWith('tool-1', 'tenant-1', 'proj-1');
  });
});

// ===========================================================================
// POST /api/projects/:id/tools/:toolId/duplicate
// ===========================================================================

describe('POST /api/projects/:id/tools/:toolId/duplicate', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/[toolId]/duplicate/route');
    handler = mod.POST;
  });

  it('duplicates a tool with _copy suffix', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    mockFindProjectToolByName.mockResolvedValue(null); // no conflict
    const newTool = { ...baseProjectTool, id: 'tool-2', name: 'my_http_tool_copy' };
    mockCreateProjectTool.mockResolvedValue(newTool);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/duplicate', 'POST');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tool).toBeDefined();

    // Verify the name passed includes _copy
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my_http_tool_copy' }),
    );
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('preserves variable namespace IDs when duplicating a scoped tool', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      variableNamespaceIds: ['ns-tools', 'ns-secrets'],
    });
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      id: 'tool-2',
      name: 'my_http_tool_copy',
      variableNamespaceIds: ['ns-tools', 'ns-secrets'],
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/duplicate', 'POST');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(res.status).toBe(201);
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ variableNamespaceIds: ['ns-tools', 'ns-secrets'] }),
    );
  });

  it('returns 404 when source tool not found', async () => {
    mockFindProjectToolById.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/bad-id/duplicate', 'POST');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'bad-id' }));
    expect(res.status).toBe(404);
  });

  it('rejects duplicate when rewritten source DSL fails persistence validation', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      name: 'run_workflow',
      toolType: 'workflow',
      dslContent: [
        'run_workflow() -> object',
        '  description: "Run a workflow"',
        '  type: workflow',
        '  workflow_id: "wf_missing_trigger"',
      ].join('\n'),
    });
    mockFindProjectToolByName.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/duplicate', 'POST');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.errors[0].msg).toContain('trigger_id');
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects duplicate when rewritten source DSL references a SearchAI index outside the project', async () => {
    mockFindProjectToolById.mockResolvedValue({
      ...baseProjectTool,
      name: 'search_foreign_kb',
      toolType: 'searchai',
      dslContent: [
        'search_foreign_kb(query: string) -> object',
        '  description: "Search foreign KB"',
        '  type: searchai',
        '  index_id: "idx-foreign"',
        '  tenant_id: "tenant-1"',
      ].join('\n'),
    });
    mockFindProjectToolByName.mockResolvedValue(null);
    mockSearchIndexFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/duplicate', 'POST');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(res.status).toBe(404);
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-foreign',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('increments suffix when _copy name already exists', async () => {
    mockFindProjectToolById.mockResolvedValue(baseProjectTool);
    // First name check finds conflict, second succeeds
    mockFindProjectToolByName
      .mockResolvedValueOnce({ id: 'existing' }) // my_http_tool_copy exists
      .mockResolvedValueOnce(null); // my_http_tool_copy_2 is free
    mockCreateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      id: 'tool-2',
      name: 'my_http_tool_copy_2',
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/duplicate', 'POST');
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(201);

    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my_http_tool_copy_2' }),
    );
  });
});

// ===========================================================================
// POST /api/projects/:id/tools/import
// ===========================================================================

describe('POST /api/projects/:id/tools/import', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/import/route');
    handler = mod.POST;
  });

  it('imports tool from { tool } format (v2)', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'my_http_tool',
        toolType: 'http',
        dslContent: baseProjectTool.dslContent,
        description: 'Fetches data',
      },
    });
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockRefreshProjectAgentDraftMetadataForToolMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('imports workflow tool exports', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      name: 'run_refund_workflow',
      toolType: 'workflow',
      dslContent: [
        'run_refund_workflow(order_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "wf-refund"',
        '  trigger_id: "manual"',
      ].join('\n'),
    });

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'run_refund_workflow',
        toolType: 'workflow',
        dslContent: [
          'run_refund_workflow(order_id: string) -> object',
          '  type: workflow',
          '  workflow_id: "wf-refund"',
          '  trigger_id: "manual"',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(201);
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'run_refund_workflow', toolType: 'workflow' }),
    );
  });

  it('imports searchai tool exports', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue({
      ...baseProjectTool,
      name: 'search_refund_kb',
      toolType: 'searchai',
      dslContent: [
        'search_refund_kb(query: string) -> object',
        '  type: searchai',
        '  index_id: "idx-refunds"',
        '  tenant_id: "tenant-1"',
      ].join('\n'),
    });

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'search_refund_kb',
        toolType: 'searchai',
        dslContent: [
          'search_refund_kb(query: string) -> object',
          '  type: searchai',
          '  index_id: "idx-refunds"',
          '  tenant_id: "tenant-1"',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(201);
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'search_refund_kb', toolType: 'searchai' }),
    );
  });

  it('rejects searchai imports when the index is not in the target project', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockSearchIndexFindOne.mockImplementation((filter: Record<string, unknown>) => ({
      lean: vi
        .fn()
        .mockResolvedValue(
          filter.projectId === 'proj-1'
            ? null
            : { _id: 'idx-foreign', tenantId: 'tenant-1', projectId: 'other-project' },
        ),
    }));

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'search_foreign_kb',
        toolType: 'searchai',
        dslContent: [
          'search_foreign_kb(query: string) -> object',
          '  type: searchai',
          '  index_id: "idx-foreign"',
          '  tenant_id: "tenant-1"',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(404);
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'idx-foreign',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects imports when dslContent type disagrees with the persisted toolType', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'mismatched_tool',
        toolType: 'http',
        dslContent: [
          'mismatched_tool() -> object',
          '  type: sandbox',
          '  runtime: javascript',
          '  code: |',
          '    return {};',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(400);
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('rejects imports that fail type-specific DSL validation', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'search_refund_kb',
        toolType: 'searchai',
        dslContent: [
          'search_refund_kb(query: string) -> object',
          '  type: searchai',
          '  tenant_id: "tenant-1"',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));

    expect(res.status).toBe(400);
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid import format', async () => {
    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      someField: 'invalid',
    });
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(400);
  });

  it('returns 409 when tool name already exists', async () => {
    mockFindProjectToolByName.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'my_http_tool',
        toolType: 'http',
        dslContent: baseProjectTool.dslContent,
      },
    });
    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(409);
  });

  it('passes tenantId to createProjectTool (tenant isolation)', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'my_http_tool',
        toolType: 'http',
        dslContent: baseProjectTool.dslContent,
      },
    });
    await handler(req, routeCtx({ id: 'proj-1' }));

    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', projectId: 'proj-1' }),
    );
  });

  it('uses placeholder-aware URL validation for imported HTTP tools', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'templated_http_tool',
        toolType: 'http',
        dslContent: [
          'templated_http_tool() -> object',
          '  type: http',
          '  endpoint: "https://{{env.API_HOST}}/data"',
          '  method: GET',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(201);

    expect(mockValidateUrlWithPlaceholders).toHaveBeenCalledWith(
      'https://{{env.API_HOST}}/data',
      'tenant-1',
      'proj-1',
      'dev',
      {
        allowUnresolvedEnvPlaceholders: true,
        variableNamespaceIds: ['ns-default'],
        useDefaultNamespaceFallback: true,
      },
    );
  });

  it('uses placeholder-aware URL validation for imported config endpoints', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockCreateProjectTool.mockResolvedValue(baseProjectTool);

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'config_http_tool',
        toolType: 'http',
        dslContent: [
          'config_http_tool() -> object',
          '  type: http',
          '  endpoint: "{{config.API_BASE}}/data"',
          '  method: GET',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(201);

    expect(mockValidateUrlWithPlaceholders).toHaveBeenCalledWith(
      '{{config.API_BASE}}/data',
      'tenant-1',
      'proj-1',
      'dev',
      {
        allowUnresolvedEnvPlaceholders: true,
        variableNamespaceIds: ['ns-default'],
        useDefaultNamespaceFallback: true,
      },
    );
    expect(mockCreateProjectTool).toHaveBeenCalledWith(
      expect.objectContaining({ variableNamespaceIds: ['ns-default'] }),
    );
  });

  it('returns 400 when placeholder-aware URL validation rejects an import', async () => {
    mockFindProjectToolByName.mockResolvedValue(null);
    mockValidateUrlWithPlaceholders.mockResolvedValue({
      safe: false,
      reason: 'Endpoint blocked by SSRF protection',
    });

    const req = makeRequest('/api/projects/proj-1/tools/import', 'POST', {
      tool: {
        name: 'blocked_http_tool',
        toolType: 'http',
        dslContent: [
          'blocked_http_tool() -> object',
          '  type: http',
          '  endpoint: "https://{{env.API_HOST}}/data"',
          '  method: GET',
        ].join('\n'),
      },
    });

    const res = await handler(req, routeCtx({ id: 'proj-1' }));
    expect(res.status).toBe(400);
    expect(mockCreateProjectTool).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/projects/:id/tools/:toolId/test
// ===========================================================================

describe('POST /api/projects/:id/tools/:toolId/test', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/tools/[toolId]/test/route');
    handler = mod.POST;
  });

  it('executes tool test and returns result', async () => {
    mockExecuteToolTest.mockResolvedValue({ output: { data: 'test-result' }, durationMs: 250 });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/test', 'POST', {
      input: { query: 'test' },
      timeoutMs: 5000,
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.result).toBeDefined();
  });

  it('passes correct args to executeToolTest', async () => {
    mockExecuteToolTest.mockResolvedValue({ output: {} });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/test', 'POST', {
      input: { key: 'val' },
      timeoutMs: 10000,
    });
    await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));

    expect(mockExecuteToolTest).toHaveBeenCalledWith({
      toolId: 'tool-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'proj-1',
      input: { key: 'val' },
      timeoutMs: 10000,
      debug: false,
    });
  });

  it('returns 404 when executeToolTest reports a missing tool', async () => {
    mockExecuteToolTest.mockResolvedValue({
      output: null,
      error: 'Tool not found',
      errorCode: 'NOT_FOUND',
    });

    const req = makeRequest('/api/projects/proj-1/tools/tool-1/test', 'POST', {
      input: { query: 'test' },
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0]).toMatchObject({ msg: 'Tool not found', code: 'NOT_FOUND' });
  });

  it('returns 400 for timeoutMs below minimum', async () => {
    const req = makeRequest('/api/projects/proj-1/tools/tool-1/test', 'POST', {
      timeoutMs: 500,
    });
    const res = await handler(req, routeCtx({ id: 'proj-1', toolId: 'tool-1' }));
    expect(res.status).toBe(400);
  });
});
