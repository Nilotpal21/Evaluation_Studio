/**
 * Audit log API — behavioral tests
 *
 * Tests scope-based filtering (personal vs workspace), admin gating,
 * date range, and pagination. Auth and DB are mocked at the boundary.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── External boundary mocks ────────────────────────────────────────────

const { mockRequireAuth, mockQueryStudioAuditLogsFromClickHouse } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockQueryStudioAuditLogsFromClickHouse: vi.fn(async () => ({ logs: [], total: 0 })),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('@/lib/ensure-db', () => ({ ensureDb: vi.fn() }));

// Forward api-response to real implementations (NextResponse-based, no external deps)
vi.mock('@/lib/api-response', () => {
  const ErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  };
  return {
    ErrorCode,
    errorJson: (message: string | string[], status: number, code = 'INTERNAL_ERROR') => {
      const msgs = Array.isArray(message) ? message : [message];
      return NextResponse.json(
        { success: false, errors: msgs.map((msg: string) => ({ msg, code })) },
        { status },
      );
    },
    handleApiError: (_error: unknown, context: string) =>
      NextResponse.json(
        { success: false, errors: [{ msg: 'Internal server error', code: 'INTERNAL_ERROR' }] },
        { status: 500 },
      ),
  };
});

// ─── In-memory audit log store ──────────────────────────────────────────

const auditLogs: any[] = [];

vi.mock('@/lib/studio-clickhouse-audit-reader', () => ({
  queryStudioAuditLogsFromClickHouse: (...args: unknown[]) =>
    mockQueryStudioAuditLogsFromClickHouse(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost'));
}

function seedLog(overrides: Partial<any> = {}) {
  const log = {
    id: `log-${auditLogs.length + 1}`,
    userId: 'user-1',
    tenantId: 'tenant-1',
    action: 'project.create',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    metadata: null,
    createdAt: new Date('2026-04-01T10:00:00Z'),
    ...overrides,
  };
  auditLogs.push(log);
  return log;
}

function filterAuditLogs(options: {
  scope: 'personal' | 'workspace';
  personalScopeMode: 'tenant-safe';
  userId: string;
  tenantId?: string;
  action?: string;
  from?: string | null;
  to?: string | null;
  limit: number;
  offset: number;
}) {
  const startTime = options.from ? new Date(options.from) : null;
  const endTime = options.to ? new Date(options.to) : null;

  const filtered = auditLogs
    .filter((log) => {
      if (options.scope === 'workspace') {
        if (log.tenantId !== options.tenantId) {
          return false;
        }
      } else {
        if (log.userId !== options.userId) {
          return false;
        }
        if (log.tenantId !== options.tenantId) {
          return false;
        }
      }

      if (options.action && log.action !== options.action) {
        return false;
      }

      const createdAt = new Date(log.createdAt);
      if (startTime && createdAt < startTime) {
        return false;
      }
      if (endTime && createdAt > endTime) {
        return false;
      }

      return true;
    })
    .sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );

  const paged = filtered.slice(options.offset, options.offset + options.limit);

  return {
    total: filtered.length,
    logs: paged.map((log) => ({
      id: log.id,
      tenantId: log.tenantId,
      actor: log.userId,
      action: log.action,
      metadata: log.metadata,
      ipAddress: log.ip ?? null,
      timestamp: new Date(log.createdAt),
    })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('GET /api/audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogs.length = 0;
    mockQueryStudioAuditLogsFromClickHouse.mockImplementation(async (options) =>
      filterAuditLogs(options as Parameters<typeof filterAuditLogs>[0]),
    );
  });

  test('returns 401 when not authenticated', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ success: false, errors: [{ msg: 'Unauthorized' }] }, { status: 401 }),
    );

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit'));

    expect(res.status).toBe(401);
  });

  test('personal scope: returns only the authenticated user logs', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({ userId: 'user-1', action: 'project.create' });
    seedLog({ userId: 'user-2', action: 'project.delete' }); // other user — should not appear

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].action).toBe('project.create');
    expect(body.scope).toBe('personal');
    expect(body.personalScopeMode).toBe('tenant-safe');
  });

  test('personal scope stays tenant-scoped by default', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1', action: 'project.create' });
    seedLog({ userId: 'user-1', tenantId: 'tenant-2', action: 'project.update' });
    seedLog({ userId: 'user-2', tenantId: 'tenant-1', action: 'project.delete' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.personalScopeMode).toBe('tenant-safe');
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].tenantId).toBe('tenant-1');
  });

  test('personal scope keeps tenant-safe filtering when requested explicitly', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1', action: 'project.create' });
    seedLog({ userId: 'user-1', tenantId: 'tenant-2', action: 'project.update' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?personalScopeMode=tenant-safe'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.personalScopeMode).toBe('tenant-safe');
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].tenantId).toBe('tenant-1');
  });

  test('workspace scope: admin sees all tenant logs', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1', action: 'project.create' });
    seedLog({ userId: 'user-2', tenantId: 'tenant-1', action: 'project.delete' });
    seedLog({ userId: 'user-3', tenantId: 'tenant-2', action: 'user.login' }); // other tenant

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(2);
    expect(body.scope).toBe('workspace');
    // Both tenant-1 logs present
    const actions = body.logs.map((l: any) => l.action).sort();
    expect(actions).toEqual(['project.create', 'project.delete']);
  });

  test('workspace scope: OWNER also has access', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Owner',
      tenantId: 'tenant-1',
      role: 'OWNER',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1', action: 'billing.update' });
    seedLog({ userId: 'user-2', tenantId: 'tenant-1', action: 'member.invite' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(2);
  });

  test('workspace scope: MEMBER gets 404 (concealment)', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Member',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    expect(res.status).toBe(404);
  });

  test('workspace scope: VIEWER gets 404 (concealment)', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Viewer',
      tenantId: 'tenant-1',
      role: 'VIEWER',
      permissions: [],
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    expect(res.status).toBe(404);
  });

  test('workspace scope: no tenant context gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'No Tenant',
      permissions: [],
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    expect(res.status).toBe(404);
  });

  test('action filter works in personal scope', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({ userId: 'user-1', action: 'project.create' });
    seedLog({ userId: 'user-1', action: 'agent.deploy' });
    seedLog({ userId: 'user-1', action: 'project.create' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?action=agent.deploy'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].action).toBe('agent.deploy');
  });

  test('action filter works in workspace scope', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1', action: 'project.create' });
    seedLog({ userId: 'user-2', tenantId: 'tenant-1', action: 'agent.deploy' });
    seedLog({ userId: 'user-3', tenantId: 'tenant-1', action: 'project.create' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace&action=project.create'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(2);
    body.logs.forEach((l: any) => expect(l.action).toBe('project.create'));
  });

  test('response includes userId and tenantId fields', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });

    seedLog({ userId: 'user-2', tenantId: 'tenant-1', action: 'session.start' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    const body = await res.json();
    expect(body.logs[0].userId).toBe('user-2');
    expect(body.logs[0].tenantId).toBe('tenant-1');
  });

  test('legacy string metadata is parsed safely in responses', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({
      userId: 'user-1',
      metadata: JSON.stringify({ target: 'project-1', safe: 'value' }),
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit'));

    const body = await res.json();
    expect(body.logs[0].metadata).toEqual({ target: 'project-1', safe: 'value' });
  });

  test('canonical object metadata is returned without re-parsing', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    seedLog({
      userId: 'user-1',
      metadata: { target: 'project-2', safe: 'value', schemaVersion: 2 },
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit'));

    const body = await res.json();
    expect(body.logs[0].metadata).toEqual({ target: 'project-2', safe: 'value', schemaVersion: 2 });
  });

  test('pagination: limit and offset work', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    for (let i = 0; i < 10; i++) {
      seedLog({
        userId: 'user-1',
        action: `action-${i}`,
        createdAt: new Date(`2026-04-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      });
    }

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?limit=3&offset=2'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(3);
    expect(body.total).toBe(10);
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(2);
  });

  test('limit capped at 200', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?limit=999'));

    const body = await res.json();
    expect(body.limit).toBe(200);
  });

  test('default scope is personal when omitted', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });

    seedLog({ userId: 'user-1', tenantId: 'tenant-1', action: 'my.action' });
    seedLog({ userId: 'user-2', tenantId: 'tenant-1', action: 'other.action' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit'));

    const body = await res.json();
    // Even though user is admin, default scope is personal
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].userId).toBe('user-1');
    expect(body.scope).toBe('personal');
  });

  test('queries audit logs through the ClickHouse reader', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({
      total: 1,
      logs: [
        {
          id: 'audit-clickhouse-1',
          tenantId: 'tenant-1',
          actor: 'user-2',
          action: 'workspace_created',
          metadata: { workspaceName: 'Acme' },
          ipAddress: '10.0.0.5',
          timestamp: new Date('2026-04-21T10:00:00.000Z'),
        },
      ],
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace&action=workspace_created'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'workspace',
        personalScopeMode: 'tenant-safe',
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'workspace_created',
        actions: ['workspace_created'],
        from: null,
        to: null,
        limit: 50,
        offset: 0,
      }),
    );
    expect(body.logs).toEqual([
      expect.objectContaining({
        id: 'audit-clickhouse-1',
        userId: 'user-2',
        tenantId: 'tenant-1',
        action: 'workspace_created',
        category: 'workspace_governance',
        categoryLabel: 'Workspace governance',
        ip: '10.0.0.5',
        metadata: { workspaceName: 'Acme' },
      }),
    ]);
    expect(body.total).toBe(1);
  });

  test('passes comprehensive workspace explorer filters to the reader', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(
      makeRequest(
        '/api/audit?scope=workspace&from=2026-05-01T00:00:00.000Z&to=2026-05-08T00:00:00.000Z&q=project&categories=auth_access&actions=login,logout&actor=user-2&actorTypes=user,admin&projectId=project-1&resourceTypes=session&resourceId=session-1&traceId=trace-1&sources=studio&environments=production&success=failure&ipAddress=10.0.&metadataKey=requestId&metadataValue=req-1',
      ),
    );

    expect(res.status).toBe(200);
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'workspace',
        tenantId: 'tenant-1',
        query: 'project',
        categories: ['auth_access'],
        actions: ['login', 'logout'],
        actor: 'user-2',
        actorTypes: ['user', 'admin'],
        projectId: 'project-1',
        resourceTypes: ['session'],
        resourceId: 'session-1',
        traceId: 'trace-1',
        sources: ['studio'],
        environments: ['production'],
        success: 'failure',
        ipAddress: '10.0.',
        metadataKey: 'requestId',
        metadataValue: 'req-1',
      }),
    );
  });

  test('rejects unbounded global search', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace&q=project'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  test('fails closed when ClickHouse reads fail', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Admin',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      permissions: [],
    });
    mockQueryStudioAuditLogsFromClickHouse.mockRejectedValue(new Error('clickhouse unavailable'));
    seedLog({ userId: 'user-1', action: 'project.create' });

    const { GET } = await import('../../app/api/audit/route');
    const res = await GET(makeRequest('/api/audit?scope=workspace'));

    expect(res.status).toBe(500);
  });
});
