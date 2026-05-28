/**
 * Variable Namespace Members Route Tests
 *
 * Tests the variable namespace membership routes at:
 * /api/projects/:projectId/variable-namespaces/:variableNamespaceId/members
 *
 * Strategy: mock all dependencies (models, repos, middleware) and test the route handlers
 * directly with fabricated req/res objects — no supertest / network required.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// =============================================================================
// MOCK: Repository functions
// =============================================================================

const mockFindVariableNamespaceById = vi.fn();
const mockFindDefaultVariableNamespace = vi.fn();
const mockFindMembershipsByVariableNamespace = vi.fn();
const mockFindVariableNamespaceMembershipsByVariableIds = vi.fn();
const mockAddVariableNamespaceMemberships = vi.fn();
const mockRemoveVariableNamespaceMembership = vi.fn();
const mockMoveVariableNamespaceMemberships = vi.fn();
const mockCountVariableNamespaceMembershipsForVariable = vi.fn();
const mockFindEnvironmentVariables = vi.fn();
const mockFindEnvironmentVariableById = vi.fn();

vi.mock('../../../repos/variable-namespace-repo.js', () => ({
  findVariableNamespaceById: (...args: any[]) => mockFindVariableNamespaceById(...args),
  findDefaultVariableNamespace: (...args: any[]) => mockFindDefaultVariableNamespace(...args),
}));

vi.mock('../../../repos/variable-namespace-membership-repo.js', () => ({
  findMembershipsByVariableNamespace: (...args: any[]) =>
    mockFindMembershipsByVariableNamespace(...args),
  findVariableNamespaceMembershipsByVariableIds: (...args: any[]) =>
    mockFindVariableNamespaceMembershipsByVariableIds(...args),
  addVariableNamespaceMemberships: (...args: any[]) => mockAddVariableNamespaceMemberships(...args),
  removeVariableNamespaceMembership: (...args: any[]) =>
    mockRemoveVariableNamespaceMembership(...args),
  moveVariableNamespaceMemberships: (...args: any[]) =>
    mockMoveVariableNamespaceMemberships(...args),
  countVariableNamespaceMembershipsForVariable: (...args: any[]) =>
    mockCountVariableNamespaceMembershipsForVariable(...args),
}));

vi.mock('../../../repos/security-repo.js', () => ({
  findEnvironmentVariables: (...args: any[]) => mockFindEnvironmentVariables(...args),
  findEnvironmentVariableById: (...args: any[]) => mockFindEnvironmentVariableById(...args),
}));

// =============================================================================
// MOCK: @agent-platform/database/models
// =============================================================================

const mockProjectConfigVariableFind = vi.fn();
const mockProjectConfigVariableFindOne = vi.fn();

function makeQueryBuilder(docs: any[]) {
  const builder: any = {
    lean: vi.fn(async () => docs),
  };
  return builder;
}

vi.mock('@agent-platform/database/models', () => ({
  ProjectConfigVariable: {
    find: (...args: any[]) => mockProjectConfigVariableFind(...args),
    findOne: (...args: any[]) => mockProjectConfigVariableFindOne(...args),
  },
}));

// =============================================================================
// MOCK: Mongoose session (for transaction tests)
// =============================================================================

const mockSession = {
  startSession: vi.fn(() => ({
    withTransaction: vi.fn(async (cb: any) => await cb()),
    endSession: vi.fn(async () => {}),
  })),
};

vi.mock('mongoose', () => ({
  default: mockSession,
}));

// =============================================================================
// MOCK: Express middleware dependencies
// =============================================================================

vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn(async () => true),
}));

// =============================================================================
// MOCK: Logger
// =============================================================================

vi.mock('@abl/compiler/platform', async () => {
  const actual = await vi.importActual('@abl/compiler/platform');
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

// =============================================================================
// HELPER: fabricate Express req / res objects
// =============================================================================

function makeReq(
  overrides: Partial<{
    params: Record<string, string>;
    query: Record<string, string>;
    body: Record<string, unknown>;
    tenantContext: { tenantId: string; userId?: string };
  }> = {},
): any {
  return {
    params: { projectId: 'proj-1', variableNamespaceId: 'ns-1' },
    query: {},
    body: {},
    tenantContext: { tenantId: 'tenant-1', userId: 'user-1' },
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {
    _status: 200,
    _body: undefined,
    status: vi.fn((code: number) => {
      res._status = code;
      return res;
    }),
    json: vi.fn((body: any) => {
      res._body = body;
      return res;
    }),
  };
  return res;
}

/** Extracts route handlers from the router. */
async function getRouteHandlers() {
  const routerModule = await import('../../../routes/variable-namespace-members.js');
  const router = (routerModule as any).default as any;

  const handlers: Record<string, any> = {};

  // Find GET / handler
  const getListLayer = router.stack?.find((layer: any) => {
    return layer?.route?.path === '/' && layer.route.methods.get;
  });
  if (getListLayer) {
    const getHandlers: any[] = getListLayer.route.stack.map((s: any) => s.handle);
    handlers.list = getHandlers[getHandlers.length - 1];
  }

  // Find POST / handler
  const postAddLayer = router.stack?.find((layer: any) => {
    return layer?.route?.path === '/' && layer.route.methods.post;
  });
  if (postAddLayer) {
    const postHandlers: any[] = postAddLayer.route.stack.map((s: any) => s.handle);
    handlers.add = postHandlers[postHandlers.length - 1];
  }

  // Find DELETE /:variableId handler
  const deleteLayer = router.stack?.find((layer: any) => {
    return layer?.route?.path === '/:variableId' && layer.route.methods.delete;
  });
  if (deleteLayer) {
    const deleteHandlers: any[] = deleteLayer.route.stack.map((s: any) => s.handle);
    handlers.remove = deleteHandlers[deleteHandlers.length - 1];
  }

  // Find POST /move handler
  const moveLayer = router.stack?.find((layer: any) => {
    return layer?.route?.path === '/move' && layer.route.methods.post;
  });
  if (moveLayer) {
    const moveHandlers: any[] = moveLayer.route.stack.map((s: any) => s.handle);
    handlers.move = moveHandlers[moveHandlers.length - 1];
  }

  return handlers;
}

// =============================================================================
// MODULE PRELOAD
// =============================================================================

beforeAll(async () => {
  await import('../../../routes/variable-namespace-members.js');
}, 30_000);

// =============================================================================
// HELPERS
// =============================================================================

function makeNamespaceDoc(id: string, projectId = 'proj-1', isDefault = false) {
  return { _id: id, projectId, isDefault, name: `namespace-${id}` };
}

function makeMembershipDoc(
  variableId: string,
  variableType: 'env' | 'config',
  namespaceId = 'ns-1',
) {
  return { variableId, variableType, namespaceId };
}

function makeEnvVarDoc(id: string, projectId = 'proj-1', key = 'TEST_KEY') {
  return { _id: id, projectId, key, encryptedValue: 'encrypted', environment: 'production' };
}

function makeConfigVarDoc(id: string, projectId = 'proj-1', key = 'TEST_VAR') {
  return { _id: id, projectId, key, value: 'test-value' };
}

// =============================================================================
// TESTS: GET / — List members of a namespace
// =============================================================================

describe('GET / — List members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns env vars and config vars with namespace enrichment', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindMembershipsByVariableNamespace.mockResolvedValue([
      makeMembershipDoc('env-1', 'env'),
      makeMembershipDoc('config-1', 'config'),
    ]);
    mockFindEnvironmentVariables.mockResolvedValue([makeEnvVarDoc('env-1')]);
    mockProjectConfigVariableFind.mockReturnValue(makeQueryBuilder([makeConfigVarDoc('config-1')]));
    mockFindVariableNamespaceMembershipsByVariableIds.mockResolvedValue([
      { variableId: 'env-1', namespaceId: 'ns-1' },
      { variableId: 'config-1', namespaceId: 'ns-1' },
    ]);

    const req = makeReq();
    const res = makeRes();

    await handlers.list(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.envVars).toHaveLength(1);
    expect(res._body.configVars).toHaveLength(1);
    expect(res._body.envVars[0].variableNamespaceIds).toEqual(['ns-1']);
    expect(res._body.configVars[0].variableNamespaceIds).toEqual(['ns-1']);
  });

  it('filters by type query param (env only)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindMembershipsByVariableNamespace.mockResolvedValue([
      makeMembershipDoc('env-1', 'env'),
      makeMembershipDoc('config-1', 'config'),
    ]);
    mockFindEnvironmentVariables.mockResolvedValue([makeEnvVarDoc('env-1')]);
    mockFindVariableNamespaceMembershipsByVariableIds.mockResolvedValue([
      { variableId: 'env-1', namespaceId: 'ns-1' },
    ]);

    const req = makeReq({ query: { type: 'env' } });
    const res = makeRes();

    await handlers.list(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.envVars).toHaveLength(1);
    expect(res._body.configVars).toHaveLength(0);
  });

  it('filters by type query param (config only)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindMembershipsByVariableNamespace.mockResolvedValue([
      makeMembershipDoc('env-1', 'env'),
      makeMembershipDoc('config-1', 'config'),
    ]);
    mockProjectConfigVariableFind.mockReturnValue(makeQueryBuilder([makeConfigVarDoc('config-1')]));
    mockFindVariableNamespaceMembershipsByVariableIds.mockResolvedValue([
      { variableId: 'config-1', namespaceId: 'ns-1' },
    ]);

    const req = makeReq({ query: { type: 'config' } });
    const res = makeRes();

    await handlers.list(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.envVars).toHaveLength(0);
    expect(res._body.configVars).toHaveLength(1);
  });

  it('returns 404 when namespace not found', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();

    await handlers.list(req, res);

    expect(res._status).toBe(404);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('Variable namespace not found');
  });

  it('paginates results', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindMembershipsByVariableNamespace.mockResolvedValue([
      makeMembershipDoc('env-1', 'env'),
      makeMembershipDoc('env-2', 'env'),
      makeMembershipDoc('env-3', 'env'),
    ]);
    mockFindEnvironmentVariables.mockResolvedValue([
      makeEnvVarDoc('env-1'),
      makeEnvVarDoc('env-2'),
      makeEnvVarDoc('env-3'),
    ]);
    mockFindVariableNamespaceMembershipsByVariableIds.mockResolvedValue([
      { variableId: 'env-1', namespaceId: 'ns-1' },
      { variableId: 'env-2', namespaceId: 'ns-1' },
      { variableId: 'env-3', namespaceId: 'ns-1' },
    ]);

    const req = makeReq({ query: { page: '2', limit: '2' } });
    const res = makeRes();

    await handlers.list(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.pagination.page).toBe(2);
    expect(res._body.pagination.limit).toBe(2);
    expect(res._body.pagination.total).toBe(3);
    expect(res._body.pagination.totalPages).toBe(2);
    // Page 2 with limit 2 should have 1 item (skip 2, take 2)
    expect(res._body.envVars).toHaveLength(1);
  });
});

// =============================================================================
// TESTS: POST / — Add variables to a namespace
// =============================================================================

describe('POST / — Add variables to namespace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds valid variables, returns added count', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindEnvironmentVariableById.mockResolvedValue(makeEnvVarDoc('env-1'));
    mockCountVariableNamespaceMembershipsForVariable.mockResolvedValue(0);
    mockAddVariableNamespaceMemberships.mockResolvedValue(undefined);

    const req = makeReq({
      body: {
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.added).toBe(1);
    expect(res._body.skipped).toBe(0);
    expect(res._body.errors).toHaveLength(0);
  });

  it('returns 404 when namespace not found', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(null);

    const req = makeReq({
      body: {
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(404);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('Variable namespace not found');
  });

  it('rejects empty variables array (400)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));

    const req = makeReq({ body: { variables: [] } });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('variables must be a non-empty array');
  });

  it('rejects variables exceeding MAX_BULK_VARIABLES (400)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));

    const variables = Array.from({ length: 101 }, (_, i) => ({
      variableId: `var-${i}`,
      variableType: 'env' as const,
    }));

    const req = makeReq({ body: { variables } });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('Maximum of 100 variables per request');
  });

  it('reports errors for invalid variableId/variableType entries', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));

    const req = makeReq({
      body: {
        variables: [
          { variableId: '', variableType: 'env' },
          { variableId: 'var-1', variableType: 'invalid' },
        ],
      },
    });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.added).toBe(0);
    expect(res._body.errors).toHaveLength(2);
    expect(res._body.errors[0].reason).toBe('Invalid variableId or variableType');
  });

  it('reports errors for variables not found in project', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindEnvironmentVariableById.mockResolvedValue(null);

    const req = makeReq({
      body: {
        variables: [{ variableId: 'env-missing', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.added).toBe(0);
    expect(res._body.errors).toHaveLength(1);
    expect(res._body.errors[0].reason).toBe('Variable not found in project');
  });

  it('reports errors when MAX_VARIABLE_NAMESPACES_PER_VARIABLE exceeded', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindEnvironmentVariableById.mockResolvedValue(makeEnvVarDoc('env-1'));
    mockCountVariableNamespaceMembershipsForVariable.mockResolvedValue(10); // Exceeds limit

    const req = makeReq({
      body: {
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.added).toBe(0);
    expect(res._body.errors).toHaveLength(1);
    expect(res._body.errors[0].reason).toContain('MAX_VARIABLE_NAMESPACES_PER_VARIABLE');
  });

  it('handles duplicate memberships (skipped count)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockFindEnvironmentVariableById.mockResolvedValue(makeEnvVarDoc('env-1'));
    mockCountVariableNamespaceMembershipsForVariable.mockResolvedValue(0);
    // Simulate duplicate key error
    mockAddVariableNamespaceMemberships.mockRejectedValue(new Error('Duplicate'));

    const req = makeReq({
      body: {
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.add(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.added).toBe(0);
    expect(res._body.skipped).toBe(1);
  });
});

// =============================================================================
// TESTS: DELETE /:variableId — Remove variable from namespace
// =============================================================================

describe('DELETE /:variableId — Remove variable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes membership successfully', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockRemoveVariableNamespaceMembership.mockResolvedValue(undefined);
    mockCountVariableNamespaceMembershipsForVariable.mockResolvedValue(1); // Still has other memberships

    const req = makeReq({
      params: { projectId: 'proj-1', variableNamespaceId: 'ns-1', variableId: 'env-1' },
      query: { type: 'env' },
    });
    const res = makeRes();

    await handlers.remove(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.movedToDefault).toBe(false);
  });

  it('returns 404 when namespace not found', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(null);

    const req = makeReq({
      params: { projectId: 'proj-1', variableNamespaceId: 'ns-1', variableId: 'env-1' },
      query: { type: 'env' },
    });
    const res = makeRes();

    await handlers.remove(req, res);

    expect(res._status).toBe(404);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('Variable namespace not found');
  });

  it('rejects missing type query param (400)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));

    const req = makeReq({
      params: { projectId: 'proj-1', variableNamespaceId: 'ns-1', variableId: 'env-1' },
      query: {},
    });
    const res = makeRes();

    await handlers.remove(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('type is required');
  });

  it('rejects invalid type query param (400)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));

    const req = makeReq({
      params: { projectId: 'proj-1', variableNamespaceId: 'ns-1', variableId: 'env-1' },
      query: { type: 'invalid' },
    });
    const res = makeRes();

    await handlers.remove(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('type is required');
  });

  it('auto-adds to default namespace when last membership removed', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValue(makeNamespaceDoc('ns-1'));
    mockRemoveVariableNamespaceMembership.mockResolvedValue(undefined);
    mockCountVariableNamespaceMembershipsForVariable.mockResolvedValue(0); // Last membership
    mockFindDefaultVariableNamespace.mockResolvedValue(
      makeNamespaceDoc('ns-default', 'proj-1', true),
    );
    mockAddVariableNamespaceMemberships.mockResolvedValue(undefined);

    const req = makeReq({
      params: { projectId: 'proj-1', variableNamespaceId: 'ns-1', variableId: 'env-1' },
      query: { type: 'env' },
    });
    const res = makeRes();

    await handlers.remove(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.movedToDefault).toBe(true);
    expect(mockAddVariableNamespaceMemberships).toHaveBeenCalled();
  });
});

// =============================================================================
// TESTS: POST /move — Move variables between namespaces
// =============================================================================

describe('POST /move — Move variables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves variables between namespaces atomically', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById
      .mockResolvedValueOnce(makeNamespaceDoc('ns-1')) // source
      .mockResolvedValueOnce(makeNamespaceDoc('ns-2')); // target
    mockMoveVariableNamespaceMemberships.mockResolvedValue(undefined);

    const req = makeReq({
      body: {
        targetNamespaceId: 'ns-2',
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.moved).toBe(1);
  });

  it('rejects missing targetNamespaceId (400)', async () => {
    const handlers = await getRouteHandlers();

    const req = makeReq({
      body: {
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('targetNamespaceId is required');
  });

  it('rejects same source and target (400)', async () => {
    const handlers = await getRouteHandlers();

    const req = makeReq({
      params: { projectId: 'proj-1', variableNamespaceId: 'ns-1' },
      body: {
        targetNamespaceId: 'ns-1', // Same as source
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('must be different');
  });

  it('rejects empty variables array (400)', async () => {
    const handlers = await getRouteHandlers();

    const req = makeReq({
      body: {
        targetNamespaceId: 'ns-2',
        variables: [],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('variables must be a non-empty array');
  });

  it('rejects variables exceeding MAX_BULK_VARIABLES (400)', async () => {
    const handlers = await getRouteHandlers();

    const variables = Array.from({ length: 101 }, (_, i) => ({
      variableId: `var-${i}`,
      variableType: 'env' as const,
    }));

    const req = makeReq({
      body: {
        targetNamespaceId: 'ns-2',
        variables,
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('Maximum of 100 variables per request');
  });

  it('returns 404 when source namespace not found', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById.mockResolvedValueOnce(null); // source not found

    const req = makeReq({
      body: {
        targetNamespaceId: 'ns-2',
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(404);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('Source variable namespace not found');
  });

  it('returns 404 when target namespace not found', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById
      .mockResolvedValueOnce(makeNamespaceDoc('ns-1')) // source found
      .mockResolvedValueOnce(null); // target not found

    const req = makeReq({
      body: {
        targetNamespaceId: 'ns-2',
        variables: [{ variableId: 'env-1', variableType: 'env' }],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(404);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('Target variable namespace not found');
  });

  it('rejects invalid variable entries (400)', async () => {
    const handlers = await getRouteHandlers();

    mockFindVariableNamespaceById
      .mockResolvedValueOnce(makeNamespaceDoc('ns-1'))
      .mockResolvedValueOnce(makeNamespaceDoc('ns-2'));

    const req = makeReq({
      body: {
        targetNamespaceId: 'ns-2',
        variables: [
          { variableId: '', variableType: 'env' }, // Invalid
        ],
      },
    });
    const res = makeRes();

    await handlers.move(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('must have variableId and variableType');
  });
});
