import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireTenantAuth,
  mockRequireAdminRole,
  mockIsAuthError,
  mockFindTenantMembership,
  mockFindArchiveManifestById,
  mockFindArchiveManifests,
  mockCreateArchiveManifest,
  mockCountAuditLogs,
  mockDeleteArchiveManifest,
  mockGetDownloadUrlForTenant,
  mockDeleteForTenant,
  mockCountSessionDocuments,
  mockArchiveAuditLogs,
  mockLogAuditEvent,
} = vi.hoisted(() => ({
  mockRequireTenantAuth: vi.fn(),
  mockRequireAdminRole: vi.fn(),
  mockIsAuthError: vi.fn(() => false),
  mockFindTenantMembership: vi.fn(),
  mockFindArchiveManifestById: vi.fn(),
  mockFindArchiveManifests: vi.fn(),
  mockCreateArchiveManifest: vi.fn(),
  mockCountAuditLogs: vi.fn(),
  mockDeleteArchiveManifest: vi.fn(),
  mockGetDownloadUrlForTenant: vi.fn(),
  mockDeleteForTenant: vi.fn(),
  mockCountSessionDocuments: vi.fn(),
  mockArchiveAuditLogs: vi.fn(),
  mockLogAuditEvent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: mockRequireTenantAuth,
  requireAdminRole: mockRequireAdminRole,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/repos/auth-repo', () => ({
  findTenantMembership: mockFindTenantMembership,
}));

vi.mock('@/repos/archive-repo', () => ({
  findArchiveManifestById: mockFindArchiveManifestById,
  findArchiveManifests: mockFindArchiveManifests,
  createArchiveManifest: mockCreateArchiveManifest,
  countAuditLogs: mockCountAuditLogs,
  deleteArchiveManifest: mockDeleteArchiveManifest,
}));

vi.mock('@/services/archive/archive-service', () => ({
  archiveAuditLogs: (...args: unknown[]) => mockArchiveAuditLogs(...args),
  getArchiveStore: vi.fn(() => ({
    getDownloadUrlForTenant: mockGetDownloadUrlForTenant,
    deleteForTenant: mockDeleteForTenant,
  })),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    ARCHIVE_CREATED: 'archive_created',
    ARCHIVE_DOWNLOADED: 'archive_downloaded',
    ARCHIVE_DELETED: 'archive_deleted',
  },
}));

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    countDocuments: (...args: unknown[]) => mockCountSessionDocuments(...args),
  },
}));

import { GET as listArchivesRoute } from '@/app/api/archives/route';
import { POST as auditExportRoute } from '@/app/api/archives/audit-export/route';
import { GET as getDownloadRoute } from '@/app/api/archives/[id]/download/route';
import { DELETE as deleteArchiveRoute } from '@/app/api/archives/[id]/route';
import { POST as sessionsArchiveRoute } from '@/app/api/archives/sessions/route';
import { POST as tracesArchiveRoute } from '@/app/api/archives/traces/route';

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  role: 'admin',
  permissions: [],
};

function makeRequest(url: string, method = 'GET', body?: unknown): NextRequest {
  const headers = new Headers({
    Authorization: 'Bearer test-jwt',
  });

  let encodedBody: string | undefined;
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    encodedBody = JSON.stringify(body);
  }

  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    headers,
    body: encodedBody,
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantAuth.mockResolvedValue(testUser);
  mockRequireAdminRole.mockResolvedValue(null);
  mockIsAuthError.mockReturnValue(false);
  mockFindTenantMembership.mockResolvedValue({
    tenantId: testUser.tenantId,
    role: 'ADMIN',
  });
  mockFindArchiveManifests.mockResolvedValue([]);
  mockCreateArchiveManifest.mockImplementation(async (manifest: Record<string, unknown>) => ({
    id: 'manifest-1',
    ...manifest,
  }));
  mockCountAuditLogs.mockResolvedValue(2);
  mockArchiveAuditLogs.mockResolvedValue({
    id: 'manifest-1',
    tenantId: 'tenant-1',
    type: 'audit_logs',
    recordCount: 2,
    sizeBytes: 128,
    format: 'ndjson.gz',
    path: 'tenant-1/archives/audit_logs/123.ndjson.gz',
    region: 'local',
    checksum: 'checksum-1',
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
  });
  mockCountSessionDocuments.mockResolvedValue(2);
  mockLogAuditEvent.mockReset();
});

describe('archive list route', () => {
  it('scopes archive list queries to the current tenant context', async () => {
    mockFindArchiveManifests.mockResolvedValue([{ id: 'archive-1' }]);

    const response = await listArchivesRoute(
      makeRequest('/api/archives?type=sessions&limit=2&cursor=cursor-1'),
    );

    expect(response.status).toBe(200);
    expect(mockFindTenantMembership).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockFindArchiveManifests).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', type: 'sessions' },
      {
        take: 3,
        skip: 1,
        cursor: { id: 'cursor-1' },
        orderBy: { createdAt: 'desc' },
      },
    );

    const body = await response.json();
    expect(body).toEqual({
      archives: [{ id: 'archive-1' }],
    });
  });
});

describe('archive creation routes', () => {
  it('uses the current tenant scope and canonical storage keys for session archives', async () => {
    const response = await sessionsArchiveRoute(
      makeRequest('/api/archives/sessions', 'POST', { olderThan: '2026-03-01T00:00:00.000Z' }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockCountSessionDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      createdAt: { $lt: new Date('2026-03-01T00:00:00.000Z') },
    });
    expect(mockCreateArchiveManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        type: 'sessions',
        storageKey: expect.stringMatching(/^tenant-1\/archives\/sessions\/\d+\.ndjson\.gz$/),
      }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'archive_created',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('uses the current tenant scope and canonical storage keys for trace archives', async () => {
    const response = await tracesArchiveRoute(makeRequest('/api/archives/traces', 'POST'));

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockCountSessionDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(mockCreateArchiveManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        type: 'traces',
        storageKey: expect.stringMatching(/^tenant-1\/archives\/traces\/\d+\.ndjson\.gz$/),
      }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'archive_created',
        metadata: expect.objectContaining({ archiveType: 'traces' }),
      }),
    );
  });

  it('uses the current tenant scope and canonical storage keys for audit exports', async () => {
    const response = await auditExportRoute(makeRequest('/api/archives/audit-export', 'POST'));

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockArchiveAuditLogs).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      type: 'audit_logs',
      olderThan: undefined,
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'archive_created',
        metadata: expect.objectContaining({ archiveType: 'audit_logs' }),
      }),
    );
  });
});

describe('archive download route', () => {
  it('uses tenant-safe download URLs', async () => {
    mockFindArchiveManifestById.mockResolvedValue({
      id: 'archive-1',
      storageKey: 'tenant-1/archives/sessions/archive-1.ndjson.gz',
    });
    mockGetDownloadUrlForTenant.mockResolvedValue('https://signed.example/archive-1');

    const response = await getDownloadRoute(
      makeRequest('/api/archives/archive-1/download'),
      makeParams('archive-1'),
    );

    expect(response.status).toBe(200);
    expect(mockFindTenantMembership).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockFindArchiveManifestById).toHaveBeenCalledWith('archive-1', 'tenant-1');
    expect(mockGetDownloadUrlForTenant).toHaveBeenCalledWith(
      'tenant-1',
      'tenant-1/archives/sessions/archive-1.ndjson.gz',
      3600,
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'archive_downloaded',
        metadata: expect.objectContaining({ resourceId: 'archive-1' }),
      }),
    );

    const body = await response.json();
    expect(body).toEqual({
      downloadUrl: 'https://signed.example/archive-1',
      expiresIn: 3600,
    });
  });

  it('returns 404 when the caller no longer has tenant membership', async () => {
    mockFindTenantMembership.mockResolvedValue(null);

    const response = await getDownloadRoute(
      makeRequest('/api/archives/archive-1/download'),
      makeParams('archive-1'),
    );

    expect(response.status).toBe(404);
    expect(mockFindArchiveManifestById).not.toHaveBeenCalled();
    expect(mockGetDownloadUrlForTenant).not.toHaveBeenCalled();
  });

  it('returns the auth response when tenant auth fails', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const response = await getDownloadRoute(
      makeRequest('/api/archives/archive-1/download'),
      makeParams('archive-1'),
    );

    expect(response.status).toBe(401);
  });
});

describe('archive delete route', () => {
  it('requires an admin role before deleting', async () => {
    const forbidden = NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    mockRequireAdminRole.mockResolvedValue(forbidden);

    const response = await deleteArchiveRoute(
      makeRequest('/api/archives/archive-1', 'DELETE'),
      makeParams('archive-1'),
    );

    expect(response.status).toBe(403);
    expect(mockFindArchiveManifestById).not.toHaveBeenCalled();
    expect(mockDeleteForTenant).not.toHaveBeenCalled();
  });

  it('deletes storage before removing the manifest', async () => {
    mockFindArchiveManifestById.mockResolvedValue({
      id: 'archive-1',
      storageKey: 'tenant-1/archives/sessions/archive-1.ndjson.gz',
    });
    mockDeleteForTenant.mockResolvedValue(undefined);
    mockDeleteArchiveManifest.mockResolvedValue({ id: 'archive-1' });

    const response = await deleteArchiveRoute(
      makeRequest('/api/archives/archive-1', 'DELETE'),
      makeParams('archive-1'),
    );

    expect(response.status).toBe(200);
    expect(mockDeleteForTenant).toHaveBeenCalledWith(
      'tenant-1',
      'tenant-1/archives/sessions/archive-1.ndjson.gz',
    );
    expect(mockDeleteArchiveManifest).toHaveBeenCalledWith('archive-1', 'tenant-1');
    expect(mockDeleteForTenant.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteArchiveManifest.mock.invocationCallOrder[0],
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'archive_deleted',
        metadata: expect.objectContaining({ resourceId: 'archive-1' }),
      }),
    );

    const body = await response.json();
    expect(body).toEqual({ deleted: true });
  });

  it('keeps the manifest when storage deletion fails', async () => {
    mockFindArchiveManifestById.mockResolvedValue({
      id: 'archive-1',
      storageKey: 'tenant-1/archives/sessions/archive-1.ndjson.gz',
    });
    mockDeleteForTenant.mockRejectedValue(new Error('disk failure'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await deleteArchiveRoute(
      makeRequest('/api/archives/archive-1', 'DELETE'),
      makeParams('archive-1'),
    );

    expect(response.status).toBe(500);
    expect(mockDeleteArchiveManifest).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
