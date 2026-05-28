import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEnsureDb = vi.fn().mockResolvedValue(undefined);

const mockProjectToolFind = vi.fn();
const mockAuthProfileFind = vi.fn();

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: (ctx: Record<string, unknown>) => Promise<Response>) =>
    async (request: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => {
      const params = await routeCtx.params;
      return handler({
        request,
        params,
        tenantId: 'tenant-1',
        user: { id: 'user-1', tenantId: 'tenant-1', permissions: ['*:*'] },
        project: { id: params.id, tenantId: 'tenant-1', ownerId: 'user-1' },
      });
    },
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: mockEnsureDb,
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  AuthProfile: {
    find: (...args: unknown[]) => mockAuthProfileFind(...args),
  },
}));

type RouteCtx = { params: Promise<Record<string, string>> };

interface SelectableQuery<T> {
  select: (fields: string) => {
    lean: () => Promise<T[]>;
  };
}

function makeSelectQuery<T>(value: T[]): SelectableQuery<T> {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  };
}

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

describe('GET /api/projects/:id/tools/workflow-compatible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectToolFind.mockReturnValue(makeSelectQuery([]));
    mockAuthProfileFind.mockReturnValue(makeSelectQuery([]));
  });

  it('filters out jit/per_user auth profile tools and preserves compatible + unresolved refs', async () => {
    mockProjectToolFind.mockReturnValue(
      makeSelectQuery([
        {
          _id: 'tool-no-auth',
          name: 'tool_no_auth',
          dslContent: ['tool_no_auth() -> object', '  type: http'].join('\n'),
        },
        {
          _id: 'tool-compatible',
          name: 'tool_compatible',
          dslContent: [
            'tool_compatible() -> object',
            '  type: http',
            '  auth_profile: "shared_compatible"',
          ].join('\n'),
        },
        {
          _id: 'tool-jit',
          name: 'tool_jit',
          dslContent: [
            'tool_jit() -> object',
            '  type: http',
            '  auth_profile: "jit_profile"',
          ].join('\n'),
        },
        {
          _id: 'tool-per-user',
          name: 'tool_per_user',
          dslContent: [
            'tool_per_user() -> object',
            '  type: http',
            '  auth_profile: "per_user_profile"',
          ].join('\n'),
        },
        {
          _id: 'tool-templated',
          name: 'tool_templated',
          dslContent: [
            'tool_templated() -> object',
            '  type: http',
            '  auth_profile: "{{config.CRM_AUTH_PROFILE}}"',
          ].join('\n'),
        },
        {
          _id: 'tool-missing',
          name: 'tool_missing_profile',
          dslContent: [
            'tool_missing_profile() -> object',
            '  type: http',
            '  auth_profile: "unknown_profile"',
          ].join('\n'),
        },
      ]),
    );

    mockAuthProfileFind.mockReturnValue(
      makeSelectQuery([
        {
          _id: 'ap-1',
          name: 'shared_compatible',
          projectId: null,
          usageMode: 'preconfigured',
          connectionMode: 'shared',
        },
        {
          _id: 'ap-2',
          name: 'jit_profile',
          projectId: null,
          usageMode: 'jit',
          connectionMode: 'shared',
        },
        {
          _id: 'ap-3',
          name: 'per_user_profile',
          projectId: null,
          usageMode: 'preconfigured',
          connectionMode: 'per_user',
        },
      ]),
    );

    const { GET } = await import('@/app/api/projects/[id]/tools/workflow-compatible/route');
    const response = await GET(
      makeRequest('/api/projects/proj-1/tools/workflow-compatible'),
      routeCtx({ id: 'proj-1' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      { id: 'tool-no-auth', name: 'tool_no_auth' },
      { id: 'tool-compatible', name: 'tool_compatible' },
      { id: 'tool-templated', name: 'tool_templated' },
      { id: 'tool-missing', name: 'tool_missing_profile' },
    ]);

    expect(mockProjectToolFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(mockAuthProfileFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        status: 'active',
        $or: [{ projectId: 'proj-1' }, { projectId: null }],
      }),
    );
  });

  it('prefers project-scoped profiles over tenant-scoped profiles with the same name', async () => {
    mockProjectToolFind.mockReturnValue(
      makeSelectQuery([
        {
          _id: 'tool-shadow-keep',
          name: 'tool_shadow_keep',
          dslContent: [
            'tool_shadow_keep() -> object',
            '  type: http',
            '  auth_profile: "shadow_keep"',
          ].join('\n'),
        },
        {
          _id: 'tool-shadow-block',
          name: 'tool_shadow_block',
          dslContent: [
            'tool_shadow_block() -> object',
            '  type: http',
            '  auth_profile: "shadow_block"',
          ].join('\n'),
        },
      ]),
    );

    mockAuthProfileFind.mockReturnValue(
      makeSelectQuery([
        {
          _id: 'ap-tenant-keep',
          name: 'shadow_keep',
          projectId: null,
          usageMode: 'jit',
          connectionMode: 'shared',
        },
        {
          _id: 'ap-project-keep',
          name: 'shadow_keep',
          projectId: 'proj-1',
          usageMode: 'preconfigured',
          connectionMode: 'shared',
        },
        {
          _id: 'ap-tenant-block',
          name: 'shadow_block',
          projectId: null,
          usageMode: 'preconfigured',
          connectionMode: 'shared',
        },
        {
          _id: 'ap-project-block',
          name: 'shadow_block',
          projectId: 'proj-1',
          usageMode: 'preconfigured',
          connectionMode: 'per_user',
        },
      ]),
    );

    const { GET } = await import('@/app/api/projects/[id]/tools/workflow-compatible/route');
    const response = await GET(
      makeRequest('/api/projects/proj-1/tools/workflow-compatible'),
      routeCtx({ id: 'proj-1' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([{ id: 'tool-shadow-keep', name: 'tool_shadow_keep' }]);
  });

  it('filters out workflow tools that point to the current workflow', async () => {
    mockProjectToolFind.mockReturnValue(
      makeSelectQuery([
        {
          _id: 'tool-self',
          name: 'self_workflow_tool',
          toolType: 'workflow',
          dslContent: [
            'self_workflow_tool() -> object',
            '  type: workflow',
            '  workflow_id: "wf-self"',
            '  trigger_id: "tr-webhook"',
            '  mode: "async"',
          ].join('\n'),
        },
        {
          _id: 'tool-other',
          name: 'other_workflow_tool',
          toolType: 'workflow',
          dslContent: [
            'other_workflow_tool() -> object',
            '  type: workflow',
            '  workflow_id: "wf-other"',
            '  trigger_id: "tr-webhook"',
            '  mode: "async"',
          ].join('\n'),
        },
        {
          _id: 'tool-http',
          name: 'plain_http_tool',
          toolType: 'http',
          dslContent: ['plain_http_tool() -> object', '  type: http'].join('\n'),
        },
      ]),
    );

    const { GET } = await import('@/app/api/projects/[id]/tools/workflow-compatible/route');
    const response = await GET(
      makeRequest('/api/projects/proj-1/tools/workflow-compatible?currentWorkflowId=wf-self'),
      routeCtx({ id: 'proj-1' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      { id: 'tool-other', name: 'other_workflow_tool' },
      { id: 'tool-http', name: 'plain_http_tool' },
    ]);
  });
});
