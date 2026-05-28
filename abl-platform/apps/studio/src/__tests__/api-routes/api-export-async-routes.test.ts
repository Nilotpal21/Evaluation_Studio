/**
 * Tests for Async Export API Route
 *
 * Covers:
 *   POST /api/projects/:id/export/async — Queue async export job
 *   GET  /api/projects/:id/export/async?jobId=xxx — Poll job status
 *   Auth, permission, threshold, and forceAsync checks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockCanProjectPermissionContextPerform = vi.fn();
const mockResolveProjectPermissionContext = vi.fn();
const mockResolveStudioProjectPermissionAliases = vi.fn();
const mockHasPermission = vi.fn();
const mockHasAnyPermission = vi.fn();

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('../../lib/project-permission', () => ({
  canProjectPermissionContextPerform: (...args: unknown[]) =>
    mockCanProjectPermissionContextPerform(...args),
  resolveProjectPermissionContext: (...args: unknown[]) =>
    mockResolveProjectPermissionContext(...args),
  resolveStudioProjectPermissionAliases: (...args: unknown[]) =>
    mockResolveStudioProjectPermissionAliases(...args),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-jwt-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

// Database models
const mockProjectAgentCountDocuments = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  ProjectAgent: {
    countDocuments: mockProjectAgentCountDocuments,
  },
}));

// Export queue service
const mockEnqueueExportJob = vi.fn();
const mockGetExportJobStatus = vi.fn();
const mockShouldUseAsyncExport = vi.fn();

vi.mock('@/services/export-queue', () => ({
  enqueueExportJob: mockEnqueueExportJob,
  getExportJobStatus: mockGetExportJobStatus,
  shouldUseAsyncExport: mockShouldUseAsyncExport,
  ASYNC_EXPORT_THRESHOLD: 100,
}));

vi.mock('@/services/export-worker', () => ({
  ensureExportWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: Function) => handler,
}));

vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  hasAnyPermission: (...args: unknown[]) => mockHasAnyPermission(...args),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn(),
  findProjectById: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['project:export'],
};

const testProject = {
  id: 'proj-1',
  _id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'user-1',
  tenantId: 'tenant-1',
};

function makePostRequest(url: string, body?: unknown): NextRequest {
  const opts: any = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

function hasPermissionMatch(granted: string[] = [], required: string): boolean {
  return granted.some((permission) => {
    if (permission === required || permission === '*:*') {
      return true;
    }

    const [grantedResource, grantedAction] = permission.split(':');
    const [requiredResource, requiredAction] = required.split(':');

    if (!grantedResource || !grantedAction || !requiredResource || !requiredAction) {
      return false;
    }

    return (
      (grantedResource === requiredResource || grantedResource === '*') &&
      (grantedAction === requiredAction || grantedAction === '*')
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
  mockResolveStudioProjectPermissionAliases.mockReturnValue(null);
  mockResolveProjectPermissionContext.mockResolvedValue({
    project: testProject,
    accessLevel: 'project_member',
    role: 'viewer',
    customRolePermissions: [],
  });
  mockCanProjectPermissionContextPerform.mockReturnValue(true);
  mockProjectAgentCountDocuments.mockResolvedValue(200);
  mockShouldUseAsyncExport.mockReturnValue(true);
  mockEnqueueExportJob.mockResolvedValue('export-proj-1-123456');
  mockHasPermission.mockImplementation(hasPermissionMatch);
  mockHasAnyPermission.mockImplementation((granted: string[] = [], permissions: string[]) =>
    permissions.some((permission) => hasPermissionMatch(granted, permission)),
  );
});

// ===========================================================================
// POST /api/projects/:id/export/async
// ===========================================================================

describe('POST /api/projects/:id/export/async', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/export/async/route');
    handler = mod.POST;
  });

  it('queues job and returns jobId + statusUrl', async () => {
    const req = makePostRequest('/api/projects/proj-1/export/async', {});
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.async).toBe(true);
    expect(body.jobId).toBe('export-proj-1-123456');
    expect(body.statusUrl).toContain('/api/projects/proj-1/export/async?jobId=');

    expect(mockEnqueueExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        dslFormat: 'source',
      }),
    );
  });

  it('queues canonical YAML export mode when explicitly requested', async () => {
    const req = makePostRequest('/api/projects/proj-1/export/async', { dslFormat: 'yaml' });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    expect(mockEnqueueExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        dslFormat: 'yaml',
      }),
    );
  });

  it('returns 200 suggesting sync for small projects', async () => {
    mockProjectAgentCountDocuments.mockResolvedValue(10);
    mockShouldUseAsyncExport.mockReturnValue(false);

    const req = makePostRequest('/api/projects/proj-1/export/async', {});
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.async).toBe(false);
    expect(body.message).toContain('sync export');
  });

  it('always queues when forceAsync=true', async () => {
    mockProjectAgentCountDocuments.mockResolvedValue(5);
    // shouldUseAsyncExport returns true when forceAsync is true
    mockShouldUseAsyncExport.mockReturnValue(true);

    const req = makePostRequest('/api/projects/proj-1/export/async', { forceAsync: true });
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.async).toBe(true);
    expect(body.jobId).toBeDefined();

    expect(mockShouldUseAsyncExport).toHaveBeenCalledWith(5, true);
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makePostRequest('/api/projects/proj-1/export/async', {});
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 without PROJECT_EXPORT permission', async () => {
    mockRequireAuth.mockResolvedValue({ ...testUser, id: 'member-1', permissions: [] });
    mockRequireProjectAccess.mockResolvedValue({
      project: { ...testProject, ownerId: 'owner-1' },
      accessPath: 'membership',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['project:export']);
    mockCanProjectPermissionContextPerform.mockReturnValue(false);

    const req = makePostRequest('/api/projects/proj-1/export/async', {});
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(403);
    expect(mockResolveProjectPermissionContext).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'member-1' }),
      {
        project: { ...testProject, ownerId: 'owner-1' },
      },
    );
  });
});

// ===========================================================================
// GET /api/projects/:id/export/async?jobId=xxx
// ===========================================================================

describe('GET /api/projects/:id/export/async', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/export/async/route');
    handler = mod.GET;
  });

  it('returns job status when jobId is provided', async () => {
    mockGetExportJobStatus.mockResolvedValue({
      id: 'export-proj-1-123456',
      status: 'processing',
      progress: 45,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      createdAt: '2026-03-08T00:00:00Z',
    });

    const req = new NextRequest(
      new URL(
        '/api/projects/proj-1/export/async?jobId=export-proj-1-123456',
        'http://localhost:3000',
      ),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('processing');
    expect(body.progress).toBe(45);
  });

  it('returns 400 when jobId is missing', async () => {
    const req = new NextRequest(
      new URL('/api/projects/proj-1/export/async', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('jobId');
  });

  it('returns 404 when job not found', async () => {
    mockGetExportJobStatus.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/projects/proj-1/export/async?jobId=nonexistent', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain('not found');
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL(
        '/api/projects/proj-1/export/async?jobId=export-proj-1-123456',
        'http://localhost:3000',
      ),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });
});
