import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { mockRequireAuth, mockQueryStudioAuditLogsFromClickHouse, mockLogAuditEvent } = vi.hoisted(
  () => ({
    mockRequireAuth: vi.fn(),
    mockQueryStudioAuditLogsFromClickHouse: vi.fn(),
    mockLogAuditEvent: vi.fn(),
  }),
);

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/api-response', () => {
  const ErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  };
  return {
    ErrorCode,
    errorJson: (message: string | string[], status: number, code = 'INTERNAL_ERROR') => {
      const messages = Array.isArray(message) ? message : [message];
      return NextResponse.json(
        { success: false, errors: messages.map((msg) => ({ msg, code })) },
        { status },
      );
    },
    handleApiError: () =>
      NextResponse.json(
        { success: false, errors: [{ msg: 'Internal server error', code: 'INTERNAL_ERROR' }] },
        { status: 500 },
      ),
  };
});

vi.mock('@/lib/studio-clickhouse-audit-reader', () => ({
  queryStudioAuditLogsFromClickHouse: (...args: unknown[]) =>
    mockQueryStudioAuditLogsFromClickHouse(...args),
}));

vi.mock('@/services/audit-service', () => ({
  AuditActions: {
    AUDIT_EXPORT_DOWNLOADED: 'audit_export_downloaded',
  },
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost'));
}

describe('GET /api/audit/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockRequireAuth.mockResolvedValue({
      id: 'admin-1',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({
      total: 1,
      logs: [
        {
          id: 'audit-1',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          timestamp: new Date('2026-05-08T10:00:00.000Z'),
          eventType: 'project_updated',
          action: '=project_updated',
          actor: 'user-1',
          actorType: 'user',
          resourceType: 'project',
          resourceId: 'project-1',
          environment: 'production',
          metadata: { source: 'runtime-store' },
          ipAddress: '10.0.0.1',
          traceId: 'trace-1',
        },
      ],
    });
    mockLogAuditEvent.mockResolvedValue(undefined);
  });

  test('exports tenant-scoped CSV using workspace filters', async () => {
    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET(
      makeRequest(
        '/api/audit/export?scope=workspace&format=csv&from=2026-05-01T00:00:00.000Z&to=2026-05-08T00:00:00.000Z&actions=project_updated&projectId=project-1',
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'workspace',
        tenantId: 'tenant-1',
        userId: 'admin-1',
        actions: ['project_updated'],
        projectId: 'project-1',
        limit: 200,
        offset: 0,
      }),
    );
    const body = await res.text();
    expect(body).toContain('category,categoryLabel');
    expect(body).toContain(
      '"project_agent_configuration","Project, agent & workflow configuration"',
    );
    expect(body).toContain('"\'=project_updated"');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'audit_export_downloaded',
        metadata: expect.objectContaining({
          exportType: 'audit_logs',
          format: 'csv',
          recordCount: 1,
        }),
      }),
    );
  });

  test('conceals workspace export from non-admin users', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'member-1',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET(makeRequest('/api/audit/export?scope=workspace&format=json'));

    expect(res.status).toBe(404);
    expect(mockQueryStudioAuditLogsFromClickHouse).not.toHaveBeenCalled();
  });

  test('supports NDJSON export', async () => {
    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET(
      makeRequest(
        '/api/audit/export?scope=workspace&format=ndjson&from=2026-05-01T00:00:00.000Z&to=2026-05-08T00:00:00.000Z',
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const body = await res.text();
    expect(body.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({
        id: 'audit-1',
        category: 'project_agent_configuration',
        categoryLabel: 'Project, agent & workflow configuration',
      }),
    );
  });

  test('requires a bounded date range for export', async () => {
    const { GET } = await import('@/app/api/audit/export/route');
    const res = await GET(makeRequest('/api/audit/export?scope=workspace&format=csv'));

    expect(res.status).toBe(400);
    expect(mockQueryStudioAuditLogsFromClickHouse).not.toHaveBeenCalled();
  });
});
