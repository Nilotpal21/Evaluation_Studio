import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireTenantAuth,
  mockRequireAdminRole,
  mockRequireProjectAccess,
  mockQueryArchAuditLogs,
  mockQueryArchAuditTimeline,
} = vi.hoisted(() => ({
  mockRequireTenantAuth: vi.fn(),
  mockRequireAdminRole: vi.fn(),
  mockRequireProjectAccess: vi.fn(),
  mockQueryArchAuditLogs: vi.fn(),
  mockQueryArchAuditTimeline: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/arch-ai', () => ({
  AUDIT_LOG_CATEGORIES: ['llm_call', 'system_event'],
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  requireAdminRole: (...args: unknown[]) => mockRequireAdminRole(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/arch-clickhouse-audit-reader', () => ({
  normalizeArchAuditCategories: (raw: string | undefined) =>
    raw ? raw.split(',').filter((value) => value === 'llm_call' || value === 'system_event') : [],
  normalizeArchAuditSeverities: (raw: string | undefined) =>
    raw ? raw.split(',').filter((value) => value === 'info' || value === 'warning') : [],
  queryArchAuditLogs: (...args: unknown[]) => mockQueryArchAuditLogs(...args),
  queryArchAuditTimeline: (...args: unknown[]) => mockQueryArchAuditTimeline(...args),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

describe('Arch audit API scope modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });
    mockRequireAdminRole.mockResolvedValue(null);
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'project-1', tenantId: 'tenant-1', name: 'Project 1', slug: 'project-1' },
      accessPath: 'membership',
    });
    mockQueryArchAuditLogs.mockResolvedValue({ entries: [], total: 0 });
    mockQueryArchAuditTimeline.mockResolvedValue([]);
  });

  test('list endpoint uses project access instead of workspace admin role when projectId is provided', async () => {
    const { GET } = await import('@/app/api/arch-ai/audit-logs/route');

    const response = await GET(
      makeRequest('http://localhost/api/arch-ai/audit-logs?projectId=project-1'),
    );

    expect(response.status).toBe(200);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: 'user-1', tenantId: 'tenant-1' }),
    );
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
    expect(mockQueryArchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
      }),
    );
  });

  test('list endpoint keeps workspace audit mode admin-gated without projectId', async () => {
    const { GET } = await import('@/app/api/arch-ai/audit-logs/route');

    const response = await GET(makeRequest('http://localhost/api/arch-ai/audit-logs'));

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockRequireProjectAccess).not.toHaveBeenCalled();
    expect(mockQueryArchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: undefined,
      }),
    );
  });

  test('timeline endpoint threads project scope to the reader', async () => {
    const { GET } = await import('@/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route');

    const response = await GET(
      makeRequest(
        'http://localhost/api/arch-ai/audit-logs/sessions/session-1/timeline?projectId=project-1',
      ),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
    expect(mockQueryArchAuditTimeline).toHaveBeenCalledWith('tenant-1', 'session-1', 'project-1');
  });
});
