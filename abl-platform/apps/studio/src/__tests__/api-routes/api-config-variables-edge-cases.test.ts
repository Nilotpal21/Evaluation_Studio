/**
 * Config Variables API — Edge Case Tests
 *
 * Validates fixes for edge cases in config-variables routes:
 *
 * 1. POST validates namespaces BEFORE creating variable (no orphans).
 * 2. DELETE passes projectId to repo for atomic scoping.
 * 3. DELETE namespace cascade includes tenantId.
 * 4. PATCH namespace replace includes tenantId on deleteMany.
 * 5. GET single passes projectId to findConfigVariableById.
 * 6. Empty value rejected on create (min(1) on value).
 * 7. PATCH with empty body rejected (requires at least one field).
 * 8. Auth consistency: all routes use requireProjectMemberOrAdmin.
 * 9. Structured logger used instead of console.error.
 * 10. Extra fields rejected via .strict().
 * 11. variableNamespaceIds validated through Zod in both create and update.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — server-only
// ---------------------------------------------------------------------------

vi.mock('server-only', () => ({}));

// ---------------------------------------------------------------------------
// Mocks — auth & access
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockRequireProjectMemberOrAdmin = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/require-project-member-or-admin', () => ({
  requireProjectMemberOrAdmin: (...args: unknown[]) => mockRequireProjectMemberOrAdmin(...args),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@abl/compiler', () => ({
  MAX_CONFIG_VARIABLES_PER_PROJECT: 200,
  MAX_CONFIG_VAR_VALUE_LENGTH: 4096,
  MAX_CONFIG_VAR_KEY_LENGTH: 100,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  MAX_VARIABLE_NAMESPACES_PER_VARIABLE: 10,
}));

// ---------------------------------------------------------------------------
// Mocks — repo layer
// ---------------------------------------------------------------------------

const mockFindByProject = vi.fn();
const mockFindByKey = vi.fn();
const mockFindById = vi.fn();
const mockCreateVar = vi.fn();
const mockUpdateVar = vi.fn();
const mockDeleteVar = vi.fn();
const mockCountVars = vi.fn();

vi.mock('@/repos/config-variable-repo', () => ({
  findConfigVariablesByProject: (...args: unknown[]) => mockFindByProject(...args),
  findConfigVariableByKey: (...args: unknown[]) => mockFindByKey(...args),
  findConfigVariableById: (...args: unknown[]) => mockFindById(...args),
  createConfigVariable: (...args: unknown[]) => mockCreateVar(...args),
  updateConfigVariable: (...args: unknown[]) => mockUpdateVar(...args),
  deleteConfigVariable: (...args: unknown[]) => mockDeleteVar(...args),
  countConfigVariables: (...args: unknown[]) => mockCountVars(...args),
}));

// ---------------------------------------------------------------------------
// Mocks — database models (namespace support)
// ---------------------------------------------------------------------------

const mockNamespaceFind = vi.fn();
const mockNamespaceFindOne = vi.fn();
const mockNamespaceCreate = vi.fn();
const mockMembershipFind = vi.fn();
const mockMembershipInsertMany = vi.fn();
const mockMembershipCreate = vi.fn();
const mockMembershipDeleteMany = vi.fn();

const mockConfigVarFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  VariableNamespace: {
    findOne: (...args: unknown[]) => mockNamespaceFindOne(...args),
    find: (...args: unknown[]) => mockNamespaceFind(...args),
    create: (...args: unknown[]) => mockNamespaceCreate(...args),
  },
  VariableNamespaceMembership: {
    find: (...args: unknown[]) => mockMembershipFind(...args),
    findOne: vi.fn(),
    create: (...args: unknown[]) => mockMembershipCreate(...args),
    insertMany: (...args: unknown[]) => mockMembershipInsertMany(...args),
    deleteMany: (...args: unknown[]) => mockMembershipDeleteMany(...args),
  },
  ProjectConfigVariable: {
    findOneAndUpdate: (...args: unknown[]) => mockConfigVarFindOneAndUpdate(...args),
  },
}));

// ---------------------------------------------------------------------------
// Route imports (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  GET as listConfigVars,
  POST as createConfigVar,
} from '../../app/api/projects/[id]/config-variables/route';
import {
  GET as getConfigVar,
  PATCH as updateConfigVar,
  DELETE as deleteConfigVar,
} from '../../app/api/projects/[id]/config-variables/[varId]/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['*:*'],
};

const TEST_PROJECT_ACCESS = {
  project: {
    id: 'proj-1',
    _id: 'proj-1',
    name: 'Test Project',
    tenantId: 'tenant-1',
    ownerId: 'user-1',
  },
  accessPath: 'membership',
};

function makeRequest(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeChainableQuery<T>(value: T) {
  return {
    sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
    lean: vi.fn().mockResolvedValue(value),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockRequireAuth.mockResolvedValue(TEST_USER);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue(TEST_PROJECT_ACCESS);
  mockRequireProjectMemberOrAdmin.mockResolvedValue(TEST_PROJECT_ACCESS);
  mockIsAccessError.mockReturnValue(false);
  mockFindById.mockResolvedValue({
    id: 'var-1',
    _id: 'var-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'MY_VAR',
    value: 'val',
  });

  // Default: no namespaces, no memberships
  mockMembershipFind.mockReturnValue(makeChainableQuery([]));
  mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));
  mockNamespaceCreate.mockResolvedValue({
    toObject: () => ({
      _id: 'default-ns',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      isDefault: true,
    }),
  });
  mockMembershipDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockMembershipInsertMany.mockResolvedValue([]);
  mockMembershipCreate.mockResolvedValue({});
});

// ===========================================================================
// FIX 1: POST — namespace validation happens BEFORE variable creation
// ===========================================================================

describe('POST /config-variables — namespace validation before create', () => {
  it('should NOT persist the variable if namespace validation fails', async () => {
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);

    // Namespace does not exist — validation should fail before DB insert
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'MY_KEY',
      value: 'val',
      variableNamespaceIds: ['nonexistent-ns'],
    });

    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    // Returns 400 for bad namespace
    expect(res.status).toBe(400);

    // FIX VERIFIED: createConfigVariable was NOT called because namespace
    // validation happens before the DB insert.
    expect(mockCreateVar).not.toHaveBeenCalled();
  });

  it('should create and link the default namespace when no namespace is supplied', async () => {
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    mockCreateVar.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'API_BASE',
      value: 'https://api.example.com',
    });
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'API_BASE',
      value: 'https://api.example.com',
    });

    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(201);
    expect(mockNamespaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'default',
        isDefault: true,
      }),
    );
    expect(mockMembershipInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          namespaceId: 'default-ns',
          variableId: 'var-1',
          variableType: 'config',
        }),
      ],
      { ordered: false },
    );
  });

  it('should re-read and link the default namespace when concurrent creation wins first', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    mockCreateVar.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'API_BASE',
      value: 'https://api.example.com',
    });
    mockNamespaceFindOne.mockReturnValueOnce(makeChainableQuery(null)).mockReturnValueOnce(
      makeChainableQuery({
        _id: 'default-ns-after-race',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isDefault: true,
      }),
    );
    mockNamespaceCreate.mockRejectedValueOnce(duplicateError);

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'API_BASE',
      value: 'https://api.example.com',
    });

    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(201);
    expect(mockMembershipInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          namespaceId: 'default-ns-after-race',
          variableId: 'var-1',
          variableType: 'config',
        }),
      ],
      { ordered: false },
    );
  });

  it('should not persist the variable when the default namespace cannot be created', async () => {
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));
    mockNamespaceCreate.mockRejectedValueOnce(new Error('namespace unavailable'));

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'API_BASE',
      value: 'https://api.example.com',
    });

    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(500);
    expect(mockCreateVar).not.toHaveBeenCalled();
    expect(mockMembershipInsertMany).not.toHaveBeenCalled();
  });

  it('should not persist the variable when duplicate default namespace recovery cannot re-read', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));
    mockNamespaceCreate.mockRejectedValueOnce(duplicateError);

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'API_BASE',
      value: 'https://api.example.com',
    });

    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(500);
    expect(mockCreateVar).not.toHaveBeenCalled();
    expect(mockMembershipInsertMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// FIX 2: DELETE — projectId passed to repo deleteConfigVariable
// ===========================================================================

describe('DELETE /config-variables/:varId — projectId in repo call', () => {
  it('should pass projectId to the repo delete function', async () => {
    mockFindById.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      key: 'API_KEY',
      value: 'secret',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    mockDeleteVar.mockResolvedValue(undefined);

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'DELETE');
    await deleteConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    // FIX VERIFIED: deleteConfigVariable is called WITH projectId
    expect(mockDeleteVar).toHaveBeenCalledWith('var-1', 'tenant-1', 'proj-1');
  });
});

// ===========================================================================
// FIX 3: DELETE — namespace cascade includes tenantId
// ===========================================================================

describe('DELETE /config-variables/:varId — namespace cascade tenant isolation', () => {
  it('should scope namespace membership deletion to tenantId', async () => {
    mockFindById.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      key: 'API_URL',
      value: 'https://example.com',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    mockDeleteVar.mockResolvedValue(undefined);

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'DELETE');
    await deleteConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    // FIX VERIFIED: deleteMany includes tenantId and projectId
    expect(mockMembershipDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        variableId: 'var-1',
        variableType: 'config',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    );
  });
});

// ===========================================================================
// FIX 4: PATCH — namespace replace deleteMany includes tenantId
// ===========================================================================

describe('PATCH /config-variables/:varId — namespace replace tenant isolation', () => {
  it('should scope namespace membership deleteMany to tenantId when replacing', async () => {
    mockUpdateVar.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'MY_VAR',
      value: 'new-val',
    });
    mockNamespaceFindOne.mockReturnValue(
      makeChainableQuery({
        _id: 'ns-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    );
    mockMembershipInsertMany.mockResolvedValue([]);

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'PATCH', {
      value: 'new-val',
      variableNamespaceIds: ['ns-1'],
    });
    await updateConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    expect(mockUpdateVar).toHaveBeenCalledWith(
      'var-1',
      'tenant-1',
      {
        value: 'new-val',
        updatedBy: 'user-1',
      },
      'proj-1',
    );
    expect(mockNamespaceFindOne).toHaveBeenCalledWith({
      _id: 'ns-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    // FIX VERIFIED: deleteMany includes tenantId and projectId
    expect(mockMembershipDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        variableId: 'var-1',
        variableType: 'config',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    );
  });

  it('should scope namespace membership deleteMany to tenantId when clearing namespaces', async () => {
    mockUpdateVar.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'MY_VAR',
      value: 'val',
    });
    mockNamespaceFindOne.mockReturnValue(
      makeChainableQuery({
        _id: 'default-ns',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isDefault: true,
      }),
    );

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'PATCH', {
      value: 'val',
      variableNamespaceIds: [],
    });
    await updateConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    expect(mockUpdateVar).toHaveBeenCalledWith(
      'var-1',
      'tenant-1',
      {
        value: 'val',
        updatedBy: 'user-1',
      },
      'proj-1',
    );
    expect(mockMembershipDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', projectId: 'proj-1' }),
    );
  });

  it('should create and link the default namespace when namespaces are cleared and none exists', async () => {
    mockUpdateVar.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'MY_VAR',
      value: 'val',
    });
    mockNamespaceFindOne.mockReturnValueOnce(makeChainableQuery(null)).mockReturnValueOnce(
      makeChainableQuery({
        _id: 'default-ns',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isDefault: true,
      }),
    );

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'PATCH', {
      variableNamespaceIds: [],
    });
    await updateConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    expect(mockNamespaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'default',
        isDefault: true,
      }),
    );
    expect(mockMembershipDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        variableId: 'var-1',
        variableType: 'config',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    );
    expect(mockMembershipInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          namespaceId: 'default-ns',
          variableId: 'var-1',
          variableType: 'config',
        }),
      ],
      { ordered: false },
    );
  });

  it('should reject invalid namespace updates before changing the variable', async () => {
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'PATCH', {
      value: 'new-val',
      variableNamespaceIds: ['missing-ns'],
    });
    const res = await updateConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateVar).not.toHaveBeenCalled();
    expect(mockMembershipDeleteMany).not.toHaveBeenCalled();
    expect(mockMembershipInsertMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// FIX 5: GET single — projectId passed to findConfigVariableById
// ===========================================================================

describe('GET /config-variables/:varId — projectId in DB query', () => {
  it('should pass projectId to findConfigVariableById for atomic scoping', async () => {
    mockFindById.mockResolvedValue({
      id: 'var-1',
      _id: 'var-1',
      key: 'API_URL',
      value: 'https://example.com',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1');
    await getConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    // FIX VERIFIED: findConfigVariableById includes projectId
    expect(mockFindById).toHaveBeenCalledWith('var-1', 'tenant-1', 'proj-1');
  });
});

// ===========================================================================
// FIX 6: POST — empty value rejected
// ===========================================================================

describe('POST /config-variables — empty value validation', () => {
  it('should reject empty string value', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'EMPTY_VAR',
      value: '',
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    // FIX VERIFIED: value requires min(1)
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// FIX 7: PATCH — empty body rejected
// ===========================================================================

describe('PATCH /config-variables/:varId — empty body rejected', () => {
  it('should reject a PATCH with no actual field changes', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'PATCH', {});
    const res = await updateConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    // FIX VERIFIED: requires at least one of value, description, variableNamespaceIds
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Boundary tests — key length, value length, description length
// ===========================================================================

describe('POST /config-variables — key boundary conditions', () => {
  it('should reject key with leading/trailing whitespace', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: '  MY_KEY  ',
      value: 'val',
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);
  });

  it('should reject key at exactly max length + 1', async () => {
    const longKey = 'A' + 'B'.repeat(100); // 101 chars
    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: longKey,
      value: 'val',
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);
  });

  it('should accept key at exactly max length', async () => {
    const maxKey = 'A' + 'B'.repeat(99); // 100 chars
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    mockCreateVar.mockResolvedValue({
      _id: 'var-max',
      key: maxKey,
      value: 'v',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      toObject: () => ({
        _id: 'var-max',
        key: maxKey,
        value: 'v',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    });
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: maxKey,
      value: 'v',
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(201);
  });
});

describe('POST /config-variables — value length boundaries', () => {
  it('should reject value exceeding max length', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'BIG_VAL',
      value: 'X'.repeat(4097),
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);
  });

  it('should accept value at exactly max length', async () => {
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    const maxVal = 'X'.repeat(4096);
    mockCreateVar.mockResolvedValue({
      _id: 'var-bigval',
      key: 'BIG_VAL',
      value: maxVal,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      toObject: () => ({
        _id: 'var-bigval',
        key: 'BIG_VAL',
        value: maxVal,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    });
    mockNamespaceFindOne.mockReturnValue(makeChainableQuery(null));

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'BIG_VAL',
      value: maxVal,
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(201);
  });
});

describe('POST /config-variables — description length boundary', () => {
  it('should reject description exceeding 500 characters', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'DESC_VAR',
      value: 'val',
      description: 'D'.repeat(501),
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// FIX 8: PATCH — variableNamespaceIds validated through Zod
// ===========================================================================

describe('PATCH /config-variables/:varId — namespace IDs type safety', () => {
  it('should reject non-string elements in variableNamespaceIds', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables/var-1', 'PATCH', {
      value: 'val',
      variableNamespaceIds: [123, null, { injection: true }],
    });
    const res = await updateConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    // FIX VERIFIED: Zod validates variableNamespaceIds as z.array(z.string().min(1))
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// FIX 9: POST — extra fields rejected via .strict()
// ===========================================================================

describe('POST /config-variables — extra fields rejected', () => {
  it('should reject unknown fields in the request body', async () => {
    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'MY_KEY',
      value: 'val',
      secretMode: true,
      environment: 'production',
    });
    const res = await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    // FIX VERIFIED: .strict() rejects unknown fields
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// FIX 10: Structured logger instead of console.error
// ===========================================================================

describe('GET /config-variables — logging compliance', () => {
  it('should use structured logger, not console.error', async () => {
    mockFindByProject.mockRejectedValue(new Error('DB connection failed'));
    mockMembershipFind.mockReturnValue(makeChainableQuery([]));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeRequest('/api/projects/proj-1/config-variables');
    await listConfigVars(req, { params: Promise.resolve({ id: 'proj-1' }) });

    // FIX VERIFIED: console.error is NOT called — structured logger used
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe('POST /config-variables — logging compliance', () => {
  it('should use structured logger, not console.error on unexpected errors', async () => {
    mockFindByKey.mockResolvedValue(null);
    mockCountVars.mockResolvedValue(0);
    mockCreateVar.mockRejectedValue(new Error('Unexpected DB failure'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeRequest('/api/projects/proj-1/config-variables', 'POST', {
      key: 'FAIL_VAR',
      value: 'val',
    });
    await createConfigVar(req, { params: Promise.resolve({ id: 'proj-1' }) });

    // FIX VERIFIED: console.error is NOT called
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ===========================================================================
// FIX 11: Auth consistency — all routes use requireProjectMemberOrAdmin
// ===========================================================================

describe('Auth consistency across config-variable routes', () => {
  it('GET single should use requireProjectMemberOrAdmin', async () => {
    // Make requireProjectMemberOrAdmin fail (simulating restricted user)
    const forbiddenResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    mockRequireProjectMemberOrAdmin.mockResolvedValue(forbiddenResponse);
    mockIsAccessError.mockImplementation((val: unknown) => {
      return val instanceof Response && val.status === 403;
    });

    mockFindById.mockResolvedValue({
      id: 'var-1',
      key: 'SECRET',
      value: 'hidden',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });

    const req = makeRequest('/api/projects/proj-1/config-variables/var-1');
    const res = await getConfigVar(req, {
      params: Promise.resolve({ id: 'proj-1', varId: 'var-1' }),
    });

    // FIX VERIFIED: GET single now uses requireProjectMemberOrAdmin
    expect(res.status).toBe(403);
  });
});
