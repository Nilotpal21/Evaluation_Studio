/**
 * Variable Namespaces Route Tests
 *
 * Tests CRUD operations for variable namespaces (organizational grouping for env/config variables).
 * Covers:
 * - GET / (list namespaces with auto-provisioning)
 * - POST / (create namespace with validation)
 * - PUT /reorder (reorder namespaces)
 * - PUT /:variableNamespaceId (update namespace)
 * - DELETE /:variableNamespaceId (delete namespace, move orphaned members to default)
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { makeTenantContext, injectTenantContext } from '../../helpers/auth-context.js';
import type { ClientSession } from 'mongoose';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────

const mockCreateVariableNamespace = vi.fn();
const mockFindVariableNamespaces = vi.fn();
const mockFindVariableNamespaceById = vi.fn();
const mockFindDefaultVariableNamespace = vi.fn();
const mockUpdateVariableNamespace = vi.fn();
const mockDeleteVariableNamespace = vi.fn();
const mockCountVariableNamespaces = vi.fn();
const mockReorderVariableNamespaces = vi.fn();
const mockGetVariableNamespaceMemberCounts = vi.fn();

vi.mock('../../../repos/variable-namespace-repo.js', () => ({
  createVariableNamespace: (...args: any[]) => mockCreateVariableNamespace(...args),
  findVariableNamespaces: (...args: any[]) => mockFindVariableNamespaces(...args),
  findVariableNamespaceById: (...args: any[]) => mockFindVariableNamespaceById(...args),
  findDefaultVariableNamespace: (...args: any[]) => mockFindDefaultVariableNamespace(...args),
  updateVariableNamespace: (...args: any[]) => mockUpdateVariableNamespace(...args),
  deleteVariableNamespace: (...args: any[]) => mockDeleteVariableNamespace(...args),
  countVariableNamespaces: (...args: any[]) => mockCountVariableNamespaces(...args),
  reorderVariableNamespaces: (...args: any[]) => mockReorderVariableNamespaces(...args),
  getVariableNamespaceMemberCounts: (...args: any[]) =>
    mockGetVariableNamespaceMemberCounts(...args),
}));

const mockFindMembershipsByVariableNamespace = vi.fn();
const mockFindVariableNamespaceMembershipsByVariable = vi.fn();
const mockAddVariableNamespaceMemberships = vi.fn();
const mockDeleteAllMembershipsForVariableNamespace = vi.fn();

vi.mock('../../../repos/variable-namespace-membership-repo.js', () => ({
  findMembershipsByVariableNamespace: (...args: any[]) =>
    mockFindMembershipsByVariableNamespace(...args),
  findVariableNamespaceMembershipsByVariable: (...args: any[]) =>
    mockFindVariableNamespaceMembershipsByVariable(...args),
  addVariableNamespaceMemberships: (...args: any[]) => mockAddVariableNamespaceMemberships(...args),
  deleteAllMembershipsForVariableNamespace: (...args: any[]) =>
    mockDeleteAllMembershipsForVariableNamespace(...args),
}));

vi.mock('../../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-A' }),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  MAX_VARIABLE_NAMESPACES_PER_PROJECT: 25,
  DEFAULT_VARIABLE_NAMESPACE_NAME: 'default',
  DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME: 'Default',
}));

// Mock requireProjectPermission — let all permissions pass for basic tests
vi.mock('../../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn(async () => true),
}));

// Mock mongoose session for transaction tests
const mockSession = {
  withTransaction: vi.fn(async (fn: any) => await fn()),
  endSession: vi.fn(),
};

vi.mock('mongoose', () => ({
  default: {
    startSession: vi.fn(async () => mockSession),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

async function createTestServer(tenantRole: 'OWNER' | 'ADMIN' | 'VIEWER' = 'OWNER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-A', 'user-1', tenantRole);
  app.use(injectTenantContext(ctx));

  const routerModule = await import('../../../routes/variable-namespaces.js');
  app.use('/api/projects/:projectId/namespaces', routerModule.default);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const BASE = '/api/projects/proj-1/namespaces';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Variable Namespaces Route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =======================================================================
  // GET / — List namespaces
  // =======================================================================

  describe('GET / — list namespaces', () => {
    test('returns namespaces enriched with member counts', async () => {
      mockFindVariableNamespaces.mockResolvedValue([
        { _id: 'ns-1', name: 'default', displayName: 'Default', isDefault: true, order: 0 },
        { _id: 'ns-2', name: 'staging', displayName: 'Staging', isDefault: false, order: 1 },
      ]);
      mockGetVariableNamespaceMemberCounts.mockResolvedValue({
        'ns-1': { env: 5, config: 3 },
        'ns-2': { env: 2, config: 1 },
      });

      const { status, body } = await request(baseUrl, 'GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.namespaces).toHaveLength(2);
      expect(body.namespaces[0].memberCounts).toEqual({ env: 5, config: 3 });
      expect(body.namespaces[1].memberCounts).toEqual({ env: 2, config: 1 });
      expect(mockGetVariableNamespaceMemberCounts).toHaveBeenCalledWith('tenant-A', 'proj-1', [
        'ns-1',
        'ns-2',
      ]);
    });

    test('auto-provisions default namespace when none exist', async () => {
      mockFindVariableNamespaces
        .mockResolvedValueOnce([]) // First call returns empty
        .mockResolvedValueOnce([
          // Second call after auto-provision
          { _id: 'ns-default', name: 'default', displayName: 'Default', isDefault: true, order: 0 },
        ]);
      mockCreateVariableNamespace.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
        order: 0,
      });
      mockGetVariableNamespaceMemberCounts.mockResolvedValue({
        'ns-default': { env: 0, config: 0 },
      });

      const { status, body } = await request(baseUrl, 'GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.namespaces).toHaveLength(1);
      expect(body.namespaces[0].name).toBe('default');
      expect(body.namespaces[0].isDefault).toBe(true);
      expect(mockCreateVariableNamespace).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
        order: 0,
        createdBy: 'system:auto-provision',
      });
    });

    test('handles auto-provision race condition gracefully', async () => {
      mockFindVariableNamespaces
        .mockResolvedValueOnce([]) // First call returns empty
        .mockResolvedValueOnce([
          // Third call after race condition
          { _id: 'ns-default', name: 'default', displayName: 'Default', isDefault: true, order: 0 },
        ]);
      // Simulate race condition: another request created it
      mockCreateVariableNamespace.mockRejectedValue(new Error('Duplicate key error'));
      mockGetVariableNamespaceMemberCounts.mockResolvedValue({
        'ns-default': { env: 0, config: 0 },
      });

      const { status, body } = await request(baseUrl, 'GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.namespaces).toHaveLength(1);
      expect(body.namespaces[0].name).toBe('default');
      // Should have called findVariableNamespaces three times: initial, after create attempt, final
      expect(mockFindVariableNamespaces).toHaveBeenCalledTimes(2);
    });

    test('returns empty member counts when no namespaces', async () => {
      mockFindVariableNamespaces.mockResolvedValue([]);
      mockCreateVariableNamespace.mockRejectedValue(new Error('Creation failed'));

      const { status, body } = await request(baseUrl, 'GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.namespaces).toHaveLength(0);
      expect(mockGetVariableNamespaceMemberCounts).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // POST / — Create namespace
  // =======================================================================

  describe('POST / — create namespace', () => {
    test('creates namespace with valid input, returns 201', async () => {
      mockCountVariableNamespaces.mockResolvedValue(2);
      mockCreateVariableNamespace.mockResolvedValue({
        _id: 'ns-new',
        name: 'production',
        displayName: 'Production',
        description: 'Production environment',
        icon: 'rocket',
        color: '#ff5733',
        order: 2,
        isDefault: false,
        createdBy: 'user-1',
      });

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: {
          name: 'production',
          displayName: 'Production',
          description: 'Production environment',
          icon: 'rocket',
          color: '#ff5733',
        },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.namespace.name).toBe('production');
      expect(body.namespace.order).toBe(2);
      expect(body.namespace.isDefault).toBe(false);
      expect(mockCreateVariableNamespace).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        name: 'production',
        displayName: 'Production',
        description: 'Production environment',
        icon: 'rocket',
        color: '#ff5733',
        order: 2,
        isDefault: false,
        createdBy: 'user-1',
      });
    });

    test('rejects missing name (400)', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { displayName: 'Test' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('name is required');
    });

    test('rejects missing displayName (400)', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'test' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('displayName is required');
    });

    test('rejects invalid name format - uppercase (400)', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'Production', displayName: 'Production' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('lowercase');
    });

    test('rejects invalid name format - special chars (400)', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'prod_test', displayName: 'Production' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('lowercase');
    });

    test('rejects invalid name format - starts with number (400)', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: '1production', displayName: 'Production' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('start with a letter');
    });

    test("rejects name 'default' (400)", async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'default', displayName: 'Default' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('reserved');
    });

    test('rejects invalid hex color (400)', async () => {
      mockCountVariableNamespaces.mockResolvedValue(0);
      const validationError = new Error(
        'VariableNamespace validation failed: color: Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
      );
      validationError.name = 'ValidationError';
      (validationError as any).errors = {
        color: {
          message:
            'Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
        },
      };
      mockCreateVariableNamespace.mockRejectedValueOnce(validationError);

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'test', displayName: 'Test', color: 'red' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('hex color');
    });

    test('accepts a semantic namespace color token (201)', async () => {
      mockCountVariableNamespaces.mockResolvedValue(0);
      mockCreateVariableNamespace.mockResolvedValue({
        _id: 'ns-token',
        name: 'team-alpha',
        displayName: 'Team Alpha',
        color: 'accent',
        order: 0,
        isDefault: false,
        createdBy: 'user-1',
      });

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'team-alpha', displayName: 'Team Alpha', color: 'accent' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.namespace.color).toBe('accent');
      expect(mockCreateVariableNamespace).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'accent' }),
      );
    });

    test('rejects invalid hex color - missing # (400)', async () => {
      mockCountVariableNamespaces.mockResolvedValue(0);
      const validationError = new Error(
        'VariableNamespace validation failed: color: Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
      );
      validationError.name = 'ValidationError';
      (validationError as any).errors = {
        color: {
          message:
            'Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
        },
      };
      mockCreateVariableNamespace.mockRejectedValueOnce(validationError);

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'test', displayName: 'Test', color: 'ff5733' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('hex color');
    });

    test('rejects when MAX_VARIABLE_NAMESPACES_PER_PROJECT exceeded (400)', async () => {
      mockCountVariableNamespaces.mockResolvedValue(25);

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'overflow', displayName: 'Overflow' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Maximum of 25');
    });

    test('sets isDefault: false and order based on count', async () => {
      mockCountVariableNamespaces.mockResolvedValue(5);
      mockCreateVariableNamespace.mockResolvedValue({
        _id: 'ns-new',
        name: 'test',
        displayName: 'Test',
        order: 5,
        isDefault: false,
      });

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'test', displayName: 'Test' },
      });

      expect(status).toBe(201);
      expect(body.namespace.isDefault).toBe(false);
      expect(body.namespace.order).toBe(5);
      expect(mockCreateVariableNamespace).toHaveBeenCalledWith(
        expect.objectContaining({ order: 5, isDefault: false }),
      );
    });

    test('accepts valid name with hyphens and numbers', async () => {
      mockCountVariableNamespaces.mockResolvedValue(1);
      mockCreateVariableNamespace.mockResolvedValue({
        _id: 'ns-new',
        name: 'prod-v2-test',
        displayName: 'Prod V2 Test',
        order: 1,
        isDefault: false,
      });

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: { name: 'prod-v2-test', displayName: 'Prod V2 Test' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
    });

    test('accepts null values for optional fields', async () => {
      mockCountVariableNamespaces.mockResolvedValue(1);
      mockCreateVariableNamespace.mockResolvedValue({
        _id: 'ns-new',
        name: 'minimal',
        displayName: 'Minimal',
        description: null,
        icon: null,
        color: null,
        order: 1,
        isDefault: false,
      });

      const { status, body } = await request(baseUrl, 'POST', BASE, {
        body: {
          name: 'minimal',
          displayName: 'Minimal',
          description: null,
          icon: null,
          color: null,
        },
      });

      expect(status).toBe(201);
      expect(body.namespace.description).toBeNull();
      expect(body.namespace.icon).toBeNull();
      expect(body.namespace.color).toBeNull();
    });
  });

  // =======================================================================
  // PUT /reorder — Reorder namespaces
  // =======================================================================

  describe('PUT /reorder — reorder namespaces', () => {
    test('reorders namespaces with valid order array', async () => {
      mockReorderVariableNamespaces.mockResolvedValue(undefined);

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/reorder`, {
        body: {
          order: [
            { namespaceId: 'ns-1', order: 0 },
            { namespaceId: 'ns-2', order: 1 },
            { namespaceId: 'ns-3', order: 2 },
          ],
        },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockReorderVariableNamespaces).toHaveBeenCalledWith('tenant-A', 'proj-1', [
        { namespaceId: 'ns-1', order: 0 },
        { namespaceId: 'ns-2', order: 1 },
        { namespaceId: 'ns-3', order: 2 },
      ]);
    });

    test('rejects non-array order (400)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/reorder`, {
        body: { order: 'invalid' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('order must be an array');
    });

    test('rejects items without namespaceId (400)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/reorder`, {
        body: {
          order: [{ order: 0 }],
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('namespaceId');
    });

    test('rejects items without order field (400)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/reorder`, {
        body: {
          order: [{ namespaceId: 'ns-1' }],
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('order');
    });

    test('rejects items with non-number order (400)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/reorder`, {
        body: {
          order: [{ namespaceId: 'ns-1', order: '0' }],
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('order (number)');
    });
  });

  // =======================================================================
  // PUT /:variableNamespaceId — Update namespace
  // =======================================================================

  describe('PUT /:variableNamespaceId — update namespace', () => {
    test('updates namespace fields', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-1',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });
      mockUpdateVariableNamespace.mockResolvedValue({
        _id: 'ns-1',
        name: 'staging',
        displayName: 'Staging Environment',
        description: 'Updated description',
        color: '#00ff00',
      });

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-1`, {
        body: {
          displayName: 'Staging Environment',
          description: 'Updated description',
          color: '#00ff00',
        },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.namespace.displayName).toBe('Staging Environment');
      expect(mockUpdateVariableNamespace).toHaveBeenCalledWith(
        'ns-1',
        'tenant-A',
        expect.objectContaining({
          displayName: 'Staging Environment',
          description: 'Updated description',
          color: '#00ff00',
          updatedBy: 'user-1',
        }),
      );
    });

    test('returns 404 when namespace not found', async () => {
      mockFindVariableNamespaceById.mockResolvedValue(null);

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-nonexistent`, {
        body: { displayName: 'New Name' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Variable namespace not found');
    });

    test('rejects updating displayName of default namespace (400)', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
      });

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-default`, {
        body: { displayName: 'New Default Name' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Cannot update displayName of the default');
    });

    test('allows updating other fields of default namespace', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
      });
      mockUpdateVariableNamespace.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        description: 'Updated description',
        color: '#cccccc',
        isDefault: true,
      });

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-default`, {
        body: { description: 'Updated description', color: '#cccccc' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockUpdateVariableNamespace).toHaveBeenCalled();
    });

    test('rejects invalid color (400)', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-1',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });
      const validationError = new Error(
        'Validation failed: color: Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
      );
      validationError.name = 'ValidationError';
      (validationError as any).errors = {
        color: {
          message:
            'Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
        },
      };
      mockUpdateVariableNamespace.mockRejectedValueOnce(validationError);

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-1`, {
        body: { color: 'blue' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('hex color');
    });

    test('rejects invalid displayName length - too short (400)', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-1',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-1`, {
        body: { displayName: '' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('1-100 characters');
    });

    test('rejects invalid displayName length - too long (400)', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-1',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-1`, {
        body: { displayName: 'a'.repeat(101) },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('1-100 characters');
    });

    test('accepts displayName at max length (100 chars)', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-1',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });
      mockUpdateVariableNamespace.mockResolvedValue({
        _id: 'ns-1',
        displayName: 'a'.repeat(100),
      });

      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ns-1`, {
        body: { displayName: 'a'.repeat(100) },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // =======================================================================
  // DELETE /:variableNamespaceId — Delete namespace
  // =======================================================================

  describe('DELETE /:variableNamespaceId — delete namespace', () => {
    test('deletes namespace and moves orphaned members to default', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-staging',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });
      mockFindDefaultVariableNamespace.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
      });
      mockFindMembershipsByVariableNamespace.mockResolvedValue([
        { variableId: 'var-1', variableType: 'env' },
        { variableId: 'var-2', variableType: 'config' },
      ]);
      // var-1 has other memberships (won't be moved)
      mockFindVariableNamespaceMembershipsByVariable
        .mockResolvedValueOnce([{ namespaceId: 'ns-staging' }, { namespaceId: 'ns-prod' }])
        // var-2 is orphaned (will be moved to default)
        .mockResolvedValueOnce([{ namespaceId: 'ns-staging' }]);

      mockAddVariableNamespaceMemberships.mockResolvedValue(undefined);
      mockDeleteAllMembershipsForVariableNamespace.mockResolvedValue(undefined);
      mockDeleteVariableNamespace.mockResolvedValue(undefined);

      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ns-staging`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.movedToDefault).toBe(1);
      expect(mockAddVariableNamespaceMemberships).toHaveBeenCalledWith(
        'tenant-A',
        'proj-1',
        'ns-default',
        [{ variableId: 'var-2', variableType: 'config' }],
      );
      expect(mockDeleteAllMembershipsForVariableNamespace).toHaveBeenCalledWith('ns-staging');
      expect(mockDeleteVariableNamespace).toHaveBeenCalledWith('ns-staging', 'tenant-A');
    });

    test('returns 404 when namespace not found', async () => {
      mockFindVariableNamespaceById.mockResolvedValue(null);

      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ns-nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Variable namespace not found');
    });

    test('rejects deleting default namespace (400)', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
      });

      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ns-default`);

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Cannot delete the default');
    });

    test('returns 500 when default namespace not found', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-staging',
        name: 'staging',
        displayName: 'Staging',
        isDefault: false,
      });
      mockFindDefaultVariableNamespace.mockResolvedValue(null);

      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ns-staging`);

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Default variable namespace not found');
    });

    test('deletes namespace with no members', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-empty',
        name: 'empty',
        displayName: 'Empty',
        isDefault: false,
      });
      mockFindDefaultVariableNamespace.mockResolvedValue({
        _id: 'ns-default',
        name: 'default',
        displayName: 'Default',
        isDefault: true,
      });
      mockFindMembershipsByVariableNamespace.mockResolvedValue([]);
      mockDeleteAllMembershipsForVariableNamespace.mockResolvedValue(undefined);
      mockDeleteVariableNamespace.mockResolvedValue(undefined);

      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ns-empty`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.movedToDefault).toBe(0);
      expect(mockAddVariableNamespaceMemberships).not.toHaveBeenCalled();
    });

    test('deletes namespace with cleanup even without transaction', async () => {
      mockFindVariableNamespaceById.mockResolvedValue({
        _id: 'ns-staging',
        name: 'staging',
        isDefault: false,
      });
      mockFindDefaultVariableNamespace.mockResolvedValue({
        _id: 'ns-default',
        isDefault: true,
      });
      mockFindMembershipsByVariableNamespace.mockResolvedValue([]);
      mockDeleteAllMembershipsForVariableNamespace.mockResolvedValue(undefined);
      mockDeleteVariableNamespace.mockResolvedValue(undefined);

      const { status } = await request(baseUrl, 'DELETE', `${BASE}/ns-staging`);

      expect(status).toBe(200);
      expect(mockDeleteAllMembershipsForVariableNamespace).toHaveBeenCalledWith('ns-staging');
      expect(mockDeleteVariableNamespace).toHaveBeenCalledWith('ns-staging', 'tenant-A');
    });
  });
});

// =========================================================================
// AUTHORIZATION TESTS
// =========================================================================

describe('Variable Namespaces Route — Authorization', () => {
  describe('RBAC — permission denied', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // Override requireProjectPermission to deny
      const rbac = await import('../../../middleware/rbac.js');
      (rbac.requireProjectPermission as any).mockImplementation(
        async (_req: any, res: any, _perm: string) => {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return false;
        },
      );

      const app = express();
      app.use(express.json());

      const ctx = makeTenantContext('tenant-A', 'viewer-user', 'VIEWER');
      app.use(injectTenantContext(ctx));

      const routerModule = await import('../../../routes/variable-namespaces.js');
      app.use('/api/projects/:projectId/namespaces', routerModule.default);

      await new Promise<void>((resolve) => {
        const srv = http.createServer(app);
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          server = srv;
          resolve();
        });
      });
    });

    afterAll(async () => {
      server?.close();
      // Restore default permission pass-through
      const rbac = await import('../../../middleware/rbac.js');
      (rbac.requireProjectPermission as any).mockImplementation(async () => true);
    });

    test('GET / returns 403 without namespace:read', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/namespaces`);
      expect(res.status).toBe(403);
    });

    test('POST / returns 403 without namespace:create', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/namespaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', displayName: 'Test' }),
      });
      expect(res.status).toBe(403);
    });

    test('PUT /reorder returns 403 without namespace:update', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/namespaces/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: [] }),
      });
      expect(res.status).toBe(403);
    });

    test('PUT /:id returns 403 without namespace:update', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/namespaces/ns-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Updated' }),
      });
      expect(res.status).toBe(403);
    });

    test('DELETE /:id returns 403 without namespace:delete', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/namespaces/ns-1`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);
    });
  });
});
