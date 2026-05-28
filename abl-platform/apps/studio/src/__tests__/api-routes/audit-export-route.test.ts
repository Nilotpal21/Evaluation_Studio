import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { mockRequireTenantAuth, mockRequireAdminRole, mockArchiveAuditLogs, mockLogAuditEvent } =
  vi.hoisted(() => ({
    mockRequireTenantAuth: vi.fn(),
    mockRequireAdminRole: vi.fn(),
    mockArchiveAuditLogs: vi.fn(),
    mockLogAuditEvent: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  requireAdminRole: (...args: unknown[]) => mockRequireAdminRole(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/services/archive/archive-service', () => ({
  archiveAuditLogs: (...args: unknown[]) => mockArchiveAuditLogs(...args),
}));

vi.mock('@/services/audit-service', () => ({
  AuditActions: {
    ARCHIVE_CREATED: 'archive_created',
  },
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

function makeRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/archives/audit-export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockRequireTenantAuth.mockResolvedValue({
      id: 'admin-1',
      tenantId: 'tenant-1',
      permissions: ['workspace:admin'],
    });
    mockRequireAdminRole.mockResolvedValue(null);
    mockArchiveAuditLogs.mockResolvedValue({
      id: 'manifest-1',
      tenantId: 'tenant-1',
      type: 'audit_logs',
      recordCount: 12,
    });
    mockLogAuditEvent.mockResolvedValue(undefined);
  });

  test('enforces explicit tenant scoping for audit export', async () => {
    const olderThan = '2026-04-01T00:00:00.000Z';

    const { POST } = await import('@/app/api/archives/audit-export/route');
    const response = await POST(
      makeRequest('http://localhost/api/archives/audit-export', { olderThan }),
    );

    expect(response.status).toBe(200);
    expect(mockArchiveAuditLogs).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      type: 'audit_logs',
      olderThan: new Date(olderThan),
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({
          archiveType: 'audit_logs',
          recordCount: 12,
          resourceId: 'manifest-1',
        }),
      }),
    );
  });

  test('rejects non-admin callers before export work starts', async () => {
    mockRequireAdminRole.mockResolvedValue(
      NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 }),
    );

    const { POST } = await import('@/app/api/archives/audit-export/route');
    const response = await POST(makeRequest('http://localhost/api/archives/audit-export'));

    expect(response.status).toBe(403);
    expect(mockArchiveAuditLogs).not.toHaveBeenCalled();
  });

  test('returns a safe empty response when the tenant has no matching audit rows', async () => {
    mockArchiveAuditLogs.mockResolvedValue(null);

    const { POST } = await import('@/app/api/archives/audit-export/route');
    const response = await POST(makeRequest('http://localhost/api/archives/audit-export'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'No audit logs to archive' });
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });
});
