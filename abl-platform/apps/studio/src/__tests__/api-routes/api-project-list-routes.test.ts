/**
 * Tests for Studio project list routes.
 *
 * Covers:
 *   GET /api/projects - List projects with entry-agent metadata for UI hydration
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TENANT_ROLE_PERMISSIONS } from '@agent-platform/shared/rbac';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockGetUserProjectsWithCounts = vi.fn();
const mockCreateProject = vi.fn();
const mockLogAuditEvent = vi.fn();

vi.mock('@abl/compiler/platform/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  requireTenantAuth: mockRequireTenantAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/project-service', () => ({
  createProject: mockCreateProject,
  getUserProjectsWithCounts: mockGetUserProjectsWithCounts,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
  AuditActions: {
    PROJECT_CREATED: 'PROJECT_CREATED',
  },
}));

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  tenantId: 'tenant-1',
  permissions: [],
};

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
}

describe('GET /api/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue(testUser);
    mockRequireTenantAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockGetUserProjectsWithCounts.mockResolvedValue([
      {
        id: 'proj-1',
        name: 'Project One',
        slug: 'project-one',
        description: 'Primary project',
        entryAgentName: 'billing_agent',
        createdAt: '2026-04-01T10:00:00.000Z',
        updatedAt: '2026-04-01T11:00:00.000Z',
        _count: { agents: 3 },
      },
      {
        id: 'proj-2',
        name: 'Project Two',
        slug: 'project-two',
        description: null,
        entryAgentName: null,
        createdAt: '2026-04-01T09:00:00.000Z',
        updatedAt: '2026-04-01T10:30:00.000Z',
        _count: { agents: 1 },
      },
    ]);
  });

  it('includes entryAgentName in list responses so currentProject rehydrates correctly', async () => {
    const { GET } = await import('@/app/api/projects/route');

    const response = await GET(makeRequest('http://localhost:3000/api/projects'));

    expect(mockGetUserProjectsWithCounts).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      projects: [
        {
          id: 'proj-1',
          name: 'Project One',
          slug: 'project-one',
          description: 'Primary project',
          entryAgentName: 'billing_agent',
          createdAt: '2026-04-01T10:00:00.000Z',
          updatedAt: '2026-04-01T11:00:00.000Z',
          agentCount: 3,
        },
        {
          id: 'proj-2',
          name: 'Project Two',
          slug: 'project-two',
          description: null,
          entryAgentName: null,
          createdAt: '2026-04-01T09:00:00.000Z',
          updatedAt: '2026-04-01T10:30:00.000Z',
          agentCount: 1,
        },
      ],
    });
  });
});

describe('POST /api/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTenantAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockCreateProject.mockResolvedValue({
      id: 'proj-3',
      name: 'Project Three',
      slug: 'project-three',
      description: null,
      ownerId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: '2026-04-20T09:00:00.000Z',
      updatedAt: '2026-04-20T09:00:00.000Z',
    });
  });

  it('rejects project creation when the caller lacks project:create', async () => {
    const { POST } = await import('@/app/api/projects/route');

    const response = await POST(
      new NextRequest(new URL('http://localhost:3000/api/projects'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Project Three', slug: 'project-three' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('allows project creation for workspace MEMBER defaults', async () => {
    mockRequireTenantAuth.mockResolvedValue({
      ...testUser,
      role: 'MEMBER',
      permissions: [...TENANT_ROLE_PERMISSIONS.MEMBER],
    });

    const { POST } = await import('@/app/api/projects/route');

    const response = await POST(
      new NextRequest(new URL('http://localhost:3000/api/projects'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Project Three', slug: 'project-three' }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreateProject).toHaveBeenCalledWith({
      name: 'Project Three',
      slug: 'project-three',
      ownerId: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'PROJECT_CREATED',
        metadata: expect.objectContaining({
          projectId: 'proj-3',
          resourceType: 'project',
          resourceId: 'proj-3',
          name: 'Project Three',
        }),
      }),
    );
  });

  it('returns a product-facing duplicate-name message when project creation collides on slug', async () => {
    mockRequireTenantAuth.mockResolvedValue({
      ...testUser,
      role: 'MEMBER',
      permissions: [...TENANT_ROLE_PERMISSIONS.MEMBER],
    });
    const duplicateError = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { slug: 1, name: 1 },
    });
    mockCreateProject.mockRejectedValueOnce(duplicateError);

    const { POST } = await import('@/app/api/projects/route');

    const response = await POST(
      new NextRequest(new URL('http://localhost:3000/api/projects'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Project Three', slug: 'project-three' }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      errors: [
        {
          msg: 'Project with the same name already exists',
          code: 'NAME_CONFLICT',
        },
      ],
    });
  });
});
