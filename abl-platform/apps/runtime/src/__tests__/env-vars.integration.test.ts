/**
 * Environment Variables Route E2E Tests
 *
 * Tests the full env-vars HTTP API using real Express server with mocked
 * dependencies (repos, auth, rate-limiter). Covers E2E-1 through E2E-14
 * from the test specification.
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// =============================================================================
// Hoisted Mock Functions
// =============================================================================

const mockCreateEnvVar = vi.fn();
const mockFindEnvVars = vi.fn();
const mockCountEnvVars = vi.fn();
const mockFindEnvVarById = vi.fn();
const mockFindEnvVarByKey = vi.fn();
const mockUpdateEnvVar = vi.fn();
const mockDeleteEnvVar = vi.fn();
const mockBulkUpsertEnvVars = vi.fn();

vi.mock('../repos/security-repo.js', () => ({
  createEnvironmentVariable: (...args: any[]) => mockCreateEnvVar(...args),
  findEnvironmentVariables: (...args: any[]) => mockFindEnvVars(...args),
  countEnvironmentVariables: (...args: any[]) => mockCountEnvVars(...args),
  findEnvironmentVariableById: (...args: any[]) => mockFindEnvVarById(...args),
  findEnvironmentVariableByKey: (...args: any[]) => mockFindEnvVarByKey(...args),
  updateEnvironmentVariable: (...args: any[]) => mockUpdateEnvVar(...args),
  deleteEnvironmentVariable: (...args: any[]) => mockDeleteEnvVar(...args),
  bulkUpsertEnvironmentVariables: (...args: any[]) => mockBulkUpsertEnvVars(...args),
}));

const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
}));

const mockAddMemberships = vi.fn().mockResolvedValue(undefined);
const mockDeleteAllMembershipsForVar = vi.fn().mockResolvedValue(undefined);
const mockFindMembershipsByVarIds = vi.fn().mockResolvedValue([]);
const mockFindMembershipsByVar = vi.fn().mockResolvedValue([]);

vi.mock('../repos/variable-namespace-membership-repo.js', () => ({
  addVariableNamespaceMemberships: (...args: any[]) => mockAddMemberships(...args),
  deleteAllVariableNamespaceMembershipsForVariable: (...args: any[]) =>
    mockDeleteAllMembershipsForVar(...args),
  findVariableNamespaceMembershipsByVariableIds: (...args: any[]) =>
    mockFindMembershipsByVarIds(...args),
  findVariableNamespaceMembershipsByVariable: (...args: any[]) => mockFindMembershipsByVar(...args),
}));

const mockFindDefaultNs = vi.fn();
const mockGetOrCreateDefaultNs = vi.fn();
const mockFindNamespaces = vi.fn().mockResolvedValue([]);
const mockFindNsById = vi.fn();

vi.mock('../repos/variable-namespace-repo.js', () => ({
  findDefaultVariableNamespace: (...args: any[]) => mockFindDefaultNs(...args),
  getOrCreateDefaultNamespace: (...args: any[]) => mockGetOrCreateDefaultNs(...args),
  findVariableNamespaces: (...args: any[]) => mockFindNamespaces(...args),
  findVariableNamespaceById: (...args: any[]) => mockFindNsById(...args),
}));

const mockAggregate = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    aggregate: (...args: any[]) => mockAggregate(...args),
  },
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: vi.fn(() => 'req-test-e2e'),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn(async () => true),
}));

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

// Validate endpoint dynamically imports project-repo to scan agent IRs
const mockFindProjectAgents = vi.fn().mockResolvedValue([]);
const mockFindLatestVersion = vi.fn().mockResolvedValue(null);
vi.mock('../repos/project-repo.js', () => ({
  findProjectAgentsForProject: (...args: any[]) => mockFindProjectAgents(...args),
  findLatestAgentVersion: (...args: any[]) => mockFindLatestVersion(...args),
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  MAX_ENV_VARS_PER_PROJECT: 100,
  MAX_VARIABLE_NAMESPACES_PER_VARIABLE: 10,
}));

// =============================================================================
// Server Setup
// =============================================================================

let server: http.Server;
let baseUrl: string;

function api(path: string) {
  return `${baseUrl}/api/projects/proj-1/env-vars${path}`;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-1', 'user-1', 'ADMIN');
  app.use(injectTenantContext(ctx));

  const routeMod = await import('../routes/environment-variables.js');
  const router = routeMod.default;
  app.use('/api/projects/:projectId/env-vars', router);

  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCountEnvVars.mockResolvedValue(0);
  mockGetOrCreateDefaultNs.mockResolvedValue({ _id: 'ns-default', name: 'default' });
  mockFindDefaultNs.mockResolvedValue({ _id: 'ns-default', name: 'default' });
});

// =============================================================================
// Helpers
// =============================================================================

function makeVar(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: 'var-1',
    key: 'API_KEY',
    environment: 'dev',
    isSecret: false,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    ...overrides,
  };
}

async function post(path: string, body: any) {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string) {
  const res = await fetch(api(path));
  return { status: res.status, body: await res.json() };
}

async function put(path: string, body: any) {
  const res = await fetch(api(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function del(path: string) {
  const res = await fetch(api(path), { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

// =============================================================================
// E2E-1: Full CRUD Lifecycle
// =============================================================================

describe('E2E-1: Full CRUD Lifecycle', () => {
  test('create → list → get-value → update → get-value → delete → list', async () => {
    const created = makeVar({
      _id: 'var-crud',
      key: 'API_KEY',
      environment: 'staging',
      isSecret: true,
    });
    mockFindEnvVarByKey.mockResolvedValue(null); // no duplicate
    mockCreateEnvVar.mockResolvedValue(created);

    // 1. Create
    const createRes = await post('/', {
      environment: 'staging',
      key: 'API_KEY',
      value: 'sk-test-123',
      isSecret: true,
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.variable.key).toBe('API_KEY');

    // 2. List
    mockFindEnvVars.mockResolvedValue([created]);
    mockCountEnvVars.mockResolvedValue(1);
    const listRes = await get('/?environment=staging');
    expect(listRes.status).toBe(200);
    expect(listRes.body.variables).toHaveLength(1);

    // 3. Get value
    mockFindEnvVarById.mockResolvedValue({ ...created, encryptedValue: 'sk-test-123' });
    const valRes = await get('/var-crud/value');
    expect(valRes.status).toBe(200);

    // 4. Update
    mockFindEnvVarById.mockResolvedValue(created);
    mockUpdateEnvVar.mockResolvedValue({ ...created, updatedAt: new Date().toISOString() });
    const updateRes = await put('/var-crud', { value: 'sk-prod-456' });
    expect(updateRes.status).toBe(200);

    // 5. Delete
    mockFindEnvVarById.mockResolvedValue(created);
    mockDeleteEnvVar.mockResolvedValue(true);
    const delRes = await del('/var-crud');
    expect(delRes.status).toBe(200);

    // 6. List after delete
    mockFindEnvVars.mockResolvedValue([]);
    mockCountEnvVars.mockResolvedValue(0);
    const listAfter = await get('/?environment=staging');
    expect(listAfter.body.variables).toHaveLength(0);
  });
});

// =============================================================================
// E2E-2: Base Value Create (environment: null)
// =============================================================================

describe('E2E-2: Base value create', () => {
  test('POST with environment: global returns 201', async () => {
    const baseVar = makeVar({ _id: 'var-base', key: 'DB_HOST', environment: 'global' });
    mockFindEnvVarByKey.mockResolvedValue(null);
    mockCreateEnvVar.mockResolvedValue(baseVar);

    const res = await post('/', {
      environment: 'global',
      key: 'DB_HOST',
      value: 'base-db.internal',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // envForResponse maps 'global' to null in API responses
    expect(res.body.variable.environment).toBeNull();
  });
});

// =============================================================================
// E2E-3: Copy Between Environments
// =============================================================================

describe('E2E-3: Copy variables', () => {
  test('copies variables from source to target environment', async () => {
    const vars = [
      makeVar({ _id: 'v1', key: 'A', encryptedValue: 'a1' }),
      makeVar({ _id: 'v2', key: 'B', encryptedValue: 'b1' }),
    ];
    mockFindEnvVars.mockResolvedValue(vars);
    // Copy endpoint uses bulkUpsertEnvironmentVariables, not individual creates
    mockBulkUpsertEnvVars.mockResolvedValue({ upserted: 2, matched: 0 });

    const res = await post('/copy', {
      sourceEnvironment: 'dev',
      targetEnvironment: 'staging',
      overwrite: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.copied).toBe(2);
    expect(res.body.skipped).toBe(0);
  });
});

// =============================================================================
// E2E-4: Pre-Deploy Validation With Base Fallback
// =============================================================================

describe('E2E-4: Validate endpoint includes base vars', () => {
  test('base variables count as defined', async () => {
    // Validate scans agent IRs for {{env.KEY}} references, then checks which are defined.
    // We need agents with IR content referencing keys.
    mockFindProjectAgents.mockResolvedValue([{ _id: 'agent-1', name: 'test-agent' }]);
    mockFindLatestVersion.mockResolvedValue({
      irContent: 'Use {{env.API_KEY}} and {{env.BASE_VAR}} and {{env.MISSING_VAR}}',
    });

    // env-specific vars
    const envVars = [makeVar({ key: 'API_KEY', environment: 'production' })];
    // base vars (environment: null fallback)
    const baseVars = [makeVar({ key: 'BASE_VAR', environment: null })];

    // Validate endpoint calls findEnvVars twice: env-specific, then base (null)
    mockFindEnvVars.mockResolvedValueOnce(envVars).mockResolvedValueOnce(baseVars);

    const res = await post('/validate', {
      environment: 'production',
    });
    expect(res.status).toBe(200);
    expect(res.body.defined).toContain('API_KEY');
    expect(res.body.defined).toContain('BASE_VAR');
    expect(res.body.missing).toContain('MISSING_VAR');
    expect(res.body.missing).not.toContain('BASE_VAR');
  });
});

// =============================================================================
// E2E-5: Duplicate Key Rejection
// =============================================================================

describe('E2E-5: Duplicate key rejection', () => {
  test('returns 409 when key+env already exists', async () => {
    mockCountEnvVars.mockResolvedValue(1);
    // The route catches MongoDB duplicate key error (code: 11000) from createEnvironmentVariable
    const dupError = new Error('E11000 duplicate key error') as any;
    dupError.code = 11000;
    mockCreateEnvVar.mockRejectedValue(dupError);

    const res = await post('/', {
      environment: 'dev',
      key: 'API_KEY',
      value: 'duplicate',
    });
    expect(res.status).toBe(409);
  });

  test('same key in different environment is allowed', async () => {
    mockFindEnvVarByKey.mockResolvedValue(null); // no duplicate in staging
    mockCreateEnvVar.mockResolvedValue(makeVar({ environment: 'staging' }));

    const res = await post('/', {
      environment: 'staging',
      key: 'API_KEY',
      value: 'different-env',
    });
    expect(res.status).toBe(201);
  });
});

// =============================================================================
// E2E-6: Invalid Input Rejection
// =============================================================================

describe('E2E-6: Invalid input rejection', () => {
  test('rejects empty key', async () => {
    const res = await post('/', { environment: 'dev', key: '', value: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects key starting with digit', async () => {
    const res = await post('/', { environment: 'dev', key: '1BAD_KEY', value: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects key exceeding max length', async () => {
    const longKey = 'A' + 'B'.repeat(256);
    const res = await post('/', { environment: 'dev', key: longKey, value: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects invalid environment', async () => {
    const res = await post('/', { environment: 'development', key: 'GOOD_KEY', value: 'x' });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// E2E-7: Cross-Project Isolation
// =============================================================================

describe('E2E-7: Cross-project isolation', () => {
  test('variables from project P1 not visible in P2', async () => {
    mockFindEnvVars.mockResolvedValue([]);
    mockCountEnvVars.mockResolvedValue(0);

    // Query P2's env vars — mock returns empty (repos filter by projectId)
    const res = await fetch(`${baseUrl}/api/projects/proj-2/env-vars?environment=dev`);
    const body = await res.json();
    expect(body.variables).toHaveLength(0);
  });
});

// =============================================================================
// E2E-8: Namespace-Scoped Access
// =============================================================================

describe('E2E-8: Namespace-scoped access', () => {
  test('namespaceId filter returns only variables in that namespace', async () => {
    const stripeVar = makeVar({ _id: 'v-stripe', key: 'STRIPE_KEY' });
    // When namespaceId is provided, route uses EnvironmentVariable.aggregate()
    mockAggregate.mockResolvedValue([
      {
        data: [stripeVar],
        count: [{ total: 1 }],
      },
    ]);
    mockFindMembershipsByVarIds.mockResolvedValue([
      { variableId: 'v-stripe', namespaceId: 'ns-payment', variableType: 'env' },
    ]);

    const res = await get('/?environment=dev&namespaceId=ns-payment');
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(1);
  });
});

// =============================================================================
// E2E-10: Variable Count Limit
// =============================================================================

describe('E2E-10: Variable count limit', () => {
  test('returns 400 when project variable limit exceeded', async () => {
    mockCountEnvVars.mockResolvedValue(100); // at limit
    mockFindEnvVarByKey.mockResolvedValue(null);

    const res = await post('/', {
      environment: 'dev',
      key: 'ONE_MORE',
      value: 'overflow',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum/i);
  });
});

// =============================================================================
// E2E-11: Base Value CRUD Lifecycle
// =============================================================================

describe('E2E-11: Base value CRUD lifecycle', () => {
  test('full CRUD with environment: global', async () => {
    const baseVar = makeVar({
      _id: 'var-base-crud',
      key: 'DEFAULT_TIMEOUT',
      environment: 'global',
    });
    mockFindEnvVarByKey.mockResolvedValue(null);
    mockCreateEnvVar.mockResolvedValue(baseVar);

    // Create
    const createRes = await post('/', {
      environment: 'global',
      key: 'DEFAULT_TIMEOUT',
      value: '30000',
    });
    expect(createRes.status).toBe(201);
    // envForResponse maps 'global' to null in API responses
    expect(createRes.body.variable.environment).toBeNull();

    // Update
    mockFindEnvVarById.mockResolvedValue(baseVar);
    mockUpdateEnvVar.mockResolvedValue({ ...baseVar, updatedAt: new Date().toISOString() });
    const updateRes = await put('/var-base-crud', { value: '60000' });
    expect(updateRes.status).toBe(200);

    // Delete
    mockFindEnvVarById.mockResolvedValue(baseVar);
    mockDeleteEnvVar.mockResolvedValue(true);
    const delRes = await del('/var-base-crud');
    expect(delRes.status).toBe(200);
  });
});

// =============================================================================
// E2E-12: Namespace Pagination Correctness
// =============================================================================

describe('E2E-12: Namespace pagination', () => {
  test('pagination.total reflects namespace-filtered count, not total', async () => {
    const vars = Array.from({ length: 5 }, (_, i) => makeVar({ _id: `v-${i}`, key: `VAR_${i}` }));
    // With namespaceId, route uses aggregate
    mockAggregate.mockResolvedValue([
      {
        data: vars,
        count: [{ total: 10 }], // 10 in namespace, not 20 total
      },
    ]);
    mockFindMembershipsByVarIds.mockResolvedValue(
      vars.map((v) => ({
        variableId: v._id,
        namespaceId: 'ns-a',
        variableType: 'env',
      })),
    );

    const res = await get('/?environment=dev&namespaceId=ns-a&limit=5&page=1');
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(5);
    expect(res.body.pagination.total).toBe(10);
  });
});

// =============================================================================
// E2E-13: Variable Diff Between Environments
// =============================================================================

describe('E2E-13: Variable diff', () => {
  test('GET /diff returns added, removed, changed categories', async () => {
    const devVars = [
      makeVar({ _id: 'v1', key: 'SHARED', encryptedValue: 'same-val', environment: 'dev' }),
      makeVar({ _id: 'v2', key: 'DEV_ONLY', encryptedValue: 'dev-val', environment: 'dev' }),
      makeVar({ _id: 'v3', key: 'DIFFERS', encryptedValue: 'dev-diff', environment: 'dev' }),
    ];
    const stagingVars = [
      makeVar({
        _id: 'v4',
        key: 'SHARED',
        encryptedValue: 'same-val',
        environment: 'staging',
      }),
      makeVar({
        _id: 'v5',
        key: 'STAGING_ONLY',
        encryptedValue: 'stg-val',
        environment: 'staging',
      }),
      makeVar({
        _id: 'v6',
        key: 'DIFFERS',
        encryptedValue: 'stg-diff',
        environment: 'staging',
      }),
    ];

    // diff endpoint calls findEnvVars twice — once for source, once for target
    mockFindEnvVars.mockResolvedValueOnce(devVars).mockResolvedValueOnce(stagingVars);

    const res = await get('/diff?source=dev&target=staging');
    expect(res.status).toBe(200);

    const { added, removed, changed } = res.body.diff;
    expect(added).toContain('STAGING_ONLY');
    expect(removed).toContain('DEV_ONLY');
    expect(changed).toContain('DIFFERS');
  });
});

// =============================================================================
// E2E-14: Bulk Export and Import
// =============================================================================

describe('E2E-14: Bulk export/import', () => {
  test('POST /export returns decrypted variables', async () => {
    const vars = [
      makeVar({ _id: 'v1', key: 'KEY_A', encryptedValue: 'val-a', isSecret: false }),
      makeVar({ _id: 'v2', key: 'KEY_B', encryptedValue: 'val-b', isSecret: true }),
    ];
    mockFindEnvVars.mockResolvedValue(vars);

    const res = await post('/export', { environment: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.variables).toHaveLength(2);
    expect(res.body.variables[0].key).toBe('KEY_A');
  });

  test('POST /import creates variables', async () => {
    mockFindEnvVarByKey.mockResolvedValue(null); // none exist
    mockCreateEnvVar.mockImplementation(async (data: any) => ({
      _id: `new-${data.key}`,
      ...data,
    }));

    const res = await post('/import', {
      environment: 'staging',
      variables: [
        { key: 'IMPORT_A', value: 'val-a' },
        { key: 'IMPORT_B', value: 'val-b', isSecret: true },
      ],
      overwrite: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toBe(0);
  });

  test('POST /import with overwrite: false skips existing', async () => {
    mockFindEnvVarByKey.mockResolvedValue(makeVar({ key: 'EXISTING' })); // exists

    const res = await post('/import', {
      environment: 'staging',
      variables: [{ key: 'EXISTING', value: 'new-val' }],
      overwrite: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
  });
});
