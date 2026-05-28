/**
 * Tests for Organization & Workspace API Routes
 *
 * Covers:
 *   POST /api/organizations                              - Create organization
 *   GET  /api/organizations/:orgId/workspaces            - List org workspaces
 *   POST /api/organizations/:orgId/workspaces            - Link / create workspace
 *   GET  /api/workspaces/:tenantId/members               - List workspace members
 *   GET  /api/workspaces/:tenantId/invitations           - List invitations
 *   POST /api/workspaces/:tenantId/invitations           - Create invitation
 *   DELETE /api/workspaces/:tenantId/invitations/:id     - Revoke invitation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRemoveUserFromTenantProjects = vi.fn();
const mockRevokeAllUserTokens = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/auth-service')>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(),
    revokeAllUserTokens: (...args: unknown[]) => mockRevokeAllUserTokens(...args),
  };
});

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockCreateOrganization = vi.fn();
vi.mock('@/services/organization-service', () => ({
  createOrganization: mockCreateOrganization,
  getOrganizationWorkspaces: vi.fn(() => []),
  linkWorkspaceToOrg: vi.fn(),
}));

const mockCreateWorkspace = vi.fn();
vi.mock('@/services/workspace-service', () => ({
  createWorkspace: mockCreateWorkspace,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: vi.fn(),
  AuditActions: {
    ORGANIZATION_CREATED: 'ORGANIZATION_CREATED',
    WORKSPACE_LINKED_TO_ORG: 'WORKSPACE_LINKED_TO_ORG',
    WORKSPACE_CREATED: 'WORKSPACE_CREATED',
    INVITATION_SENT: 'INVITATION_SENT',
    INVITATION_REVOKED: 'INVITATION_REVOKED',
    INVITATION_RESENT: 'INVITATION_RESENT',
    MEMBER_ROLE_CHANGED: 'MEMBER_ROLE_CHANGED',
    MEMBER_REMOVED: 'MEMBER_REMOVED',
  },
}));

const mockFindOrgMember = vi.fn();
vi.mock('@/repos/org-repo', () => ({
  findOrgMember: mockFindOrgMember,
}));

const mockFindTenantMember = vi.fn();
const mockFindTenantMembers = vi.fn();
const mockFindInvitations = vi.fn();
const mockCreateInvitation = vi.fn();
const mockFindInvitationById = vi.fn();
const mockDeleteInvitation = vi.fn();
const mockUpdateTenant = vi.fn();
const mockUpdateTenantMember = vi.fn();
const mockDeleteTenantMember = vi.fn();

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: mockFindTenantMember,
  findTenantMembers: mockFindTenantMembers,
  findInvitations: mockFindInvitations,
  createInvitation: mockCreateInvitation,
  findInvitationById: mockFindInvitationById,
  deleteInvitation: mockDeleteInvitation,
  updateTenant: mockUpdateTenant,
  updateTenantMember: mockUpdateTenantMember,
  deleteTenantMember: mockDeleteTenantMember,
  findTenantById: vi.fn(),
  findTenantMemberByUserIdAndRoles: vi.fn(),
}));

vi.mock('@/repos/project-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/repos/project-repo')>();
  return {
    ...actual,
    removeUserFromTenantProjects: (...args: unknown[]) => mockRemoveUserFromTenantProjects(...args),
  };
});

const mockCreateInvitationService = vi.fn();
vi.mock('@/services/invitation-service', () => ({
  createInvitation: mockCreateInvitationService,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

class MockAppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  constructor(message: string, opts: { code: string; statusCode?: number }) {
    super(message);
    this.name = 'AppError';
    this.code = opts.code;
    this.statusCode = opts.statusCode ?? 500;
  }
}

vi.mock('@agent-platform/shared/errors', () => ({
  AppError: MockAppError,
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: Function) => handler,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  role: 'member',
};

function makeRequest(url: string, body?: unknown, method = 'POST'): NextRequest {
  const opts: Record<string, unknown> = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRemoveUserFromTenantProjects.mockResolvedValue(0);
  mockRevokeAllUserTokens.mockResolvedValue(undefined);
});

// ===========================================================================
// POST /api/organizations
// ===========================================================================

describe('POST /api/organizations', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/organizations/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(
      makeRequest('/api/organizations', { name: 'Org', billingEmail: 'b@c.com' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing name', async () => {
    const res = await handler(makeRequest('/api/organizations', { billingEmail: 'b@c.com' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('name');
  });

  it('returns 400 for name too short', async () => {
    const res = await handler(
      makeRequest('/api/organizations', { name: 'A', billingEmail: 'b@c.com' }),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('between 2 and 100 characters');
  });

  it('returns 400 for missing billingEmail', async () => {
    const res = await handler(makeRequest('/api/organizations', { name: 'My Org' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Billing email');
  });

  it('returns 400 for invalid billingEmail', async () => {
    const res = await handler(
      makeRequest('/api/organizations', { name: 'My Org', billingEmail: 'not-email' }),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid billing email');
  });

  it('creates organization successfully', async () => {
    mockCreateOrganization.mockResolvedValue({
      id: 'org-1',
      name: 'My Org',
      slug: 'my-org',
    });

    const res = await handler(
      makeRequest('/api/organizations', {
        name: 'My Org',
        billingEmail: 'billing@myorg.com',
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.organization.name).toBe('My Org');
  });

  it('passes slug and linkWorkspaceId', async () => {
    mockCreateOrganization.mockResolvedValue({
      id: 'org-2',
      name: 'Test',
      slug: 'custom-slug',
    });

    await handler(
      makeRequest('/api/organizations', {
        name: 'Test',
        slug: 'custom-slug',
        billingEmail: 'b@c.com',
        linkWorkspaceId: 'ws-1',
      }),
    );

    expect(mockCreateOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'custom-slug',
        initialTenantId: 'ws-1',
        ownerId: 'user-1',
        billingEmail: 'b@c.com',
      }),
    );
  });

  it('returns 400 on service error', async () => {
    mockCreateOrganization.mockRejectedValue(new Error('Duplicate slug'));

    const res = await handler(
      makeRequest('/api/organizations', {
        name: 'Org',
        billingEmail: 'b@c.com',
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// GET /api/organizations/:orgId/workspaces
// ===========================================================================

describe('GET /api/organizations/:orgId/workspaces', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/organizations/[orgId]/workspaces/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/organizations/org-1/workspaces', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ orgId: 'org-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when not a member of the organization', async () => {
    mockFindOrgMember.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/organizations/org-1/workspaces', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ orgId: 'org-1' }) });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Not a member');
  });

  it('returns workspaces list on success', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_MEMBER' });
    const { getOrganizationWorkspaces } = await import('@/services/organization-service');
    vi.mocked(getOrganizationWorkspaces).mockResolvedValue([
      { id: 'ws-1', name: 'Workspace 1' },
    ] as any);

    const req = new NextRequest(
      new URL('/api/organizations/org-1/workspaces', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ orgId: 'org-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].name).toBe('Workspace 1');
  });

  it('returns 500 on service error', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_MEMBER' });
    const { getOrganizationWorkspaces } = await import('@/services/organization-service');
    vi.mocked(getOrganizationWorkspaces).mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(
      new URL('/api/organizations/org-1/workspaces', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ orgId: 'org-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/organizations/:orgId/workspaces
// ===========================================================================

describe('POST /api/organizations/:orgId/workspaces', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/organizations/[orgId]/workspaces/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(
      makeRequest('/api/organizations/org-1/workspaces', { name: 'New WS' }),
      { params: Promise.resolve({ orgId: 'org-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_MEMBER' });

    const res = await handler(makeRequest('/api/organizations/org-1/workspaces', { name: 'WS' }), {
      params: Promise.resolve({ orgId: 'org-1' }),
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Insufficient permissions');
  });

  it('returns 400 when neither tenantId nor name provided', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_OWNER' });

    const res = await handler(makeRequest('/api/organizations/org-1/workspaces', {}), {
      params: Promise.resolve({ orgId: 'org-1' }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('tenantId');
  });

  it('links existing workspace successfully', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_ADMIN' });
    const { linkWorkspaceToOrg } = await import('@/services/organization-service');
    vi.mocked(linkWorkspaceToOrg).mockResolvedValue(undefined as any);

    const res = await handler(
      makeRequest('/api/organizations/org-1/workspaces', { tenantId: 'ws-existing' }),
      { params: Promise.resolve({ orgId: 'org-1' }) },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.linked).toBe('ws-existing');
  });

  it('creates new workspace under org successfully', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_OWNER' });
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-new', name: 'New Workspace' });
    mockUpdateTenant.mockResolvedValue(undefined);

    const res = await handler(
      makeRequest('/api/organizations/org-1/workspaces', { name: 'New Workspace' }),
      { params: Promise.resolve({ orgId: 'org-1' }) },
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.workspace.name).toBe('New Workspace');
  });

  it('returns 400 on service error', async () => {
    mockFindOrgMember.mockResolvedValue({ role: 'ORG_OWNER' });
    mockCreateWorkspace.mockRejectedValue(new Error('Duplicate name'));

    const res = await handler(makeRequest('/api/organizations/org-1/workspaces', { name: 'Dup' }), {
      params: Promise.resolve({ orgId: 'org-1' }),
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// GET /api/workspaces/:tenantId/members
// ===========================================================================

describe('GET /api/workspaces/:tenantId/members', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/workspaces/[tenantId]/members/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/workspaces/t-1/members', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ tenantId: 't-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Insufficient permissions');
  });

  it('returns 403 when no membership found', async () => {
    mockFindTenantMember.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 404 when route tenantId does not match user tenantId', async () => {
    const req = new NextRequest(
      new URL('/api/workspaces/other-tenant/members', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'other-tenant' }) });
    expect(res.status).toBe(404);
  });

  it('returns members list on success', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockFindTenantMembers.mockResolvedValue([
      {
        id: 'm-1',
        userId: 'u-1',
        user: { email: 'user@test.com', name: 'User' },
        role: 'MEMBER',
        createdAt: new Date('2024-01-01'),
      },
    ]);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].email).toBe('user@test.com');
    expect(body.members[0].role).toBe('MEMBER');
  });

  it('returns 500 on service error', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
    mockFindTenantMembers.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/workspaces/:tenantId/invitations
// ===========================================================================

describe('GET /api/workspaces/:tenantId/invitations', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/workspaces/[tenantId]/invitations/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/workspaces/t-1/invitations', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 't-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'VIEWER' });

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns invitations list on success', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockFindInvitations.mockResolvedValue([
      { id: 'inv-1', email: 'new@test.com', role: 'MEMBER', status: 'PENDING' },
    ]);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].email).toBe('new@test.com');
  });

  it('returns 500 on service error', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
    mockFindInvitations.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ tenantId: 'tenant-1' }) });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/workspaces/:tenantId/invitations
// ===========================================================================

describe('POST /api/workspaces/:tenantId/invitations', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/workspaces/[tenantId]/invitations/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(
      makeRequest('/api/workspaces/t-1/invitations', { email: 'new@test.com' }),
      { params: Promise.resolve({ tenantId: 't-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations', { email: 'new@test.com' }),
      { params: Promise.resolve({ tenantId: 'tenant-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing email', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

    const res = await handler(makeRequest('/api/workspaces/tenant-1/invitations', {}), {
      params: Promise.resolve({ tenantId: 'tenant-1' }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 400 for invalid role', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations', {
        email: 'new@test.com',
        role: 'SUPERADMIN',
      }),
      { params: Promise.resolve({ tenantId: 'tenant-1' }) },
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid enum value');
  });

  it('creates invitation successfully', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockCreateInvitationService.mockResolvedValue({
      id: 'inv-new',
      tenantId: 'tenant-1',
      email: 'new@test.com',
      role: 'MEMBER',
      status: 'PENDING',
      token: 'tok-123',
      invitedBy: 'user-1',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations', { email: 'new@test.com' }),
      { params: Promise.resolve({ tenantId: 'tenant-1' }) },
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.invitation.email).toBe('new@test.com');
    expect(body.invitation.role).toBe('MEMBER');
  });

  it('creates invitation with specified role', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
    mockCreateInvitationService.mockResolvedValue({
      id: 'inv-2',
      email: 'admin@test.com',
      role: 'ADMIN',
      status: 'PENDING',
    });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations', {
        email: 'admin@test.com',
        role: 'ADMIN',
      }),
      { params: Promise.resolve({ tenantId: 'tenant-1' }) },
    );
    expect(res.status).toBe(201);

    expect(mockCreateInvitationService).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
    );
  });

  it('returns 400 on service error', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockCreateInvitationService.mockRejectedValue(
      new MockAppError('Duplicate email', { code: 'DUPLICATE_INVITATION', statusCode: 400 }),
    );

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations', { email: 'dup@test.com' }),
      { params: Promise.resolve({ tenantId: 'tenant-1' }) },
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// DELETE /api/workspaces/:tenantId/invitations/:invitationId
// ===========================================================================

describe('DELETE /api/workspaces/:tenantId/invitations/:invitationId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/workspaces/[tenantId]/invitations/[invitationId]/route');
    handler = mod.DELETE;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when no membership found', async () => {
    mockFindTenantMember.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when invitation not found', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockFindInvitationById.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-999', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-999' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when invitation belongs to different tenant', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    // With tenant-scoped query, a different-tenant invitation is simply not found
    mockFindInvitationById.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when route tenantId does not match user tenantId', async () => {
    const req = new NextRequest(
      new URL('/api/workspaces/other-tenant/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'other-tenant', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(404);
  });

  it('revokes invitation successfully', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
    mockFindInvitationById.mockResolvedValue({
      id: 'inv-1',
      tenantId: 'tenant-1',
      email: 'revoked@test.com',
    });
    mockDeleteInvitation.mockResolvedValue(undefined);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockDeleteInvitation).toHaveBeenCalledWith('inv-1', 'tenant-1');
  });

  it('returns 500 on service error', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockFindInvitationById.mockResolvedValue({
      id: 'inv-1',
      tenantId: 'tenant-1',
      email: 'x@y.com',
    });
    mockDeleteInvitation.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/invitations/inv-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }),
    });
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// PATCH /api/workspaces/:tenantId/members/:userId
// ===========================================================================

describe('PATCH /api/workspaces/:tenantId/members/:userId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/workspaces/[tenantId]/members/[userId]/route');
    handler = mod.PATCH;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-2', { role: 'VIEWER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-2', { role: 'VIEWER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when changing own role', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-1', { role: 'VIEWER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-1' }) },
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Cannot change your own role');
  });

  it('returns 400 for invalid role', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-2', { role: 'SUPERADMIN' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when target member not found', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'ADMIN' }) // actor
      .mockResolvedValueOnce(null); // target

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-999', { role: 'VIEWER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-999' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when assigning role higher than own', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'ADMIN' }) // actor (level 40)
      .mockResolvedValueOnce({ role: 'MEMBER' }); // target

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-2', { role: 'OWNER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('higher than your own');
  });

  it('returns 403 when ADMIN tries to change equal-level member', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'ADMIN' }) // actor (level 40)
      .mockResolvedValueOnce({ role: 'ADMIN' }); // target (level 40)

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-2', { role: 'MEMBER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Cannot change the role');
  });

  it('updates role successfully when OWNER changes ADMIN to MEMBER', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'OWNER' }) // actor
      .mockResolvedValueOnce({ role: 'ADMIN' }); // target
    mockUpdateTenantMember.mockResolvedValue(undefined);

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/members/user-2', { role: 'MEMBER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.role).toBe('MEMBER');
    expect(mockUpdateTenantMember).toHaveBeenCalledWith('tenant-1', 'user-2', { role: 'MEMBER' });
  });

  it('returns 404 when route tenantId does not match user tenantId', async () => {
    const res = await handler(
      makeRequest('/api/workspaces/other-tenant/members/user-2', { role: 'VIEWER' }, 'PATCH'),
      { params: Promise.resolve({ tenantId: 'other-tenant', userId: 'user-2' }) },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// DELETE /api/workspaces/:tenantId/members/:userId
// ===========================================================================

describe('DELETE /api/workspaces/:tenantId/members/:userId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/workspaces/[tenantId]/members/[userId]/route');
    handler = mod.DELETE;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-2', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-2', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when removing self', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-1', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-1' }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Cannot remove yourself');
  });

  it('returns 404 when target member not found', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'ADMIN' }) // actor
      .mockResolvedValueOnce(null); // target

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-999', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-999' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 403 when removing OWNER', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'ADMIN' }) // actor
      .mockResolvedValueOnce({ role: 'OWNER' }); // target

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-2', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }),
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Cannot remove the workspace owner');
  });

  it('returns 403 when ADMIN removes equal-level member', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'ADMIN' }) // actor
      .mockResolvedValueOnce({ role: 'ADMIN' }); // target

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-2', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }),
    });
    expect(res.status).toBe(403);
  });

  it('removes member successfully', async () => {
    mockFindTenantMember
      .mockResolvedValueOnce({ role: 'OWNER' }) // actor
      .mockResolvedValueOnce({ role: 'MEMBER' }); // target
    mockRemoveUserFromTenantProjects.mockResolvedValue(3);
    mockDeleteTenantMember.mockResolvedValue(undefined);

    const req = new NextRequest(
      new URL('/api/workspaces/tenant-1/members/user-2', 'http://localhost:3000'),
      { method: 'DELETE' },
    );
    const res = await handler(req, {
      params: Promise.resolve({ tenantId: 'tenant-1', userId: 'user-2' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.projectMembershipsRemoved).toBe(3);
    expect(mockRemoveUserFromTenantProjects).toHaveBeenCalledWith('tenant-1', 'user-2');
    expect(mockRevokeAllUserTokens).toHaveBeenCalledWith('user-2');
    expect(mockDeleteTenantMember).toHaveBeenCalledWith('tenant-1', 'user-2');
  });
});

// ===========================================================================
// POST /api/workspaces/:tenantId/invitations/:invitationId/resend
// ===========================================================================

describe('POST /api/workspaces/:tenantId/invitations/:invitationId/resend', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod =
      await import('@/app/api/workspaces/[tenantId]/invitations/[invitationId]/resend/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations/inv-1/resend', undefined, 'POST'),
      { params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when not admin', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'MEMBER' });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations/inv-1/resend', undefined, 'POST'),
      { params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when invitation not found', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockFindInvitationById.mockResolvedValue(null);

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations/inv-999/resend', undefined, 'POST'),
      { params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-999' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when invitation already accepted', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'ADMIN' });
    mockFindInvitationById.mockResolvedValue({
      id: 'inv-1',
      email: 'test@test.com',
      role: 'MEMBER',
      status: 'accepted',
    });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations/inv-1/resend', undefined, 'POST'),
      { params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }) },
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('already been accepted');
  });

  it('resends invitation successfully', async () => {
    mockFindTenantMember.mockResolvedValue({ role: 'OWNER' });
    mockFindInvitationById.mockResolvedValue({
      id: 'inv-1',
      email: 'resend@test.com',
      role: 'MEMBER',
      status: 'pending',
    });
    mockDeleteInvitation.mockResolvedValue(undefined);
    mockCreateInvitationService.mockResolvedValue({
      id: 'inv-new',
      email: 'resend@test.com',
      role: 'MEMBER',
      status: 'pending',
      expiresAt: new Date(),
    });

    const res = await handler(
      makeRequest('/api/workspaces/tenant-1/invitations/inv-1/resend', undefined, 'POST'),
      { params: Promise.resolve({ tenantId: 'tenant-1', invitationId: 'inv-1' }) },
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.invitation.email).toBe('resend@test.com');
    expect(mockDeleteInvitation).toHaveBeenCalledWith('inv-1', 'tenant-1');
    expect(mockCreateInvitationService).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        email: 'resend@test.com',
        role: 'MEMBER',
      }),
    );
  });

  it('returns 404 when route tenantId does not match user tenantId', async () => {
    const res = await handler(
      makeRequest('/api/workspaces/other-tenant/invitations/inv-1/resend', undefined, 'POST'),
      { params: Promise.resolve({ tenantId: 'other-tenant', invitationId: 'inv-1' }) },
    );
    expect(res.status).toBe(404);
  });
});
