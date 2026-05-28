import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

type AuditRow = Record<string, unknown>;

const adminAuditRows: AuditRow[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesQuery(row: AuditRow, query: AuditRow): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === 'createdAt' && isRecord(value)) {
      const rowDate = new Date(String(row.createdAt));
      const minDate = value.$gte instanceof Date ? value.$gte : undefined;
      const maxDate = value.$lte instanceof Date ? value.$lte : undefined;
      if (minDate && rowDate < minDate) return false;
      if (maxDate && rowDate > maxDate) return false;
      return true;
    }

    return row[key] === value;
  });
}

const { mockQueryAdminAuditLogsFromClickHouse } = vi.hoisted(() => ({
  mockQueryAdminAuditLogsFromClickHouse: vi.fn(),
}));

vi.mock('../lib/with-admin-route', () => ({
  withAdminRoute:
    (_options: unknown, handler: (ctx: any) => Promise<Response>) =>
    async (request: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) => {
      try {
        return await handler({
          request,
          params: routeCtx?.params ? await routeCtx.params : {},
          token: 'admin-token',
          user: {
            userId: 'admin-user',
            email: 'admin@example.com',
            role: 'VIEWER',
            ipAddress: '127.0.0.1',
            isSuperAdmin: false,
          },
        });
      } catch {
        return Response.json(
          {
            success: false,
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          },
          { status: 500 },
        );
      }
    },
}));

vi.mock('../lib/admin-clickhouse-audit-reader', () => ({
  queryAdminAuditLogsFromClickHouse: (...args: unknown[]) =>
    mockQueryAdminAuditLogsFromClickHouse(...args),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

describe('GET /api/audit', () => {
  beforeEach(() => {
    adminAuditRows.length = 0;
    vi.clearAllMocks();
    vi.resetModules();
    mockQueryAdminAuditLogsFromClickHouse.mockImplementation(
      async (filters?: {
        actor?: string;
        action?: string;
        from?: Date;
        to?: Date;
        limit?: number;
      }) => {
        const query: AuditRow = {};
        if (filters?.actor) query.userId = filters.actor;
        if (filters?.action) query.action = filters.action;
        if (filters?.from || filters?.to) {
          query.createdAt = {
            ...(filters.from && { $gte: filters.from }),
            ...(filters.to && { $lte: filters.to }),
          };
        }

        const filtered = adminAuditRows
          .filter((row) => matchesQuery(row, query))
          .sort((left, right) => {
            const leftTime = new Date(String(left.createdAt)).getTime();
            const rightTime = new Date(String(right.createdAt)).getTime();
            return rightTime - leftTime;
          })
          .slice(0, filters?.limit ?? 50);

        return filtered.map((row) => {
          const metadata = isRecord(row.metadata)
            ? row.metadata
            : typeof row.metadata === 'string'
              ? (JSON.parse(row.metadata) as Record<string, unknown>)
              : {};

          return {
            timestamp: new Date(String(row.createdAt)),
            actor: String(row.userId ?? 'unknown'),
            actorRole: typeof metadata.actorRole === 'string' ? metadata.actorRole : 'unknown',
            action: String(row.action ?? 'config_view'),
            target:
              typeof metadata.target === 'string'
                ? metadata.target
                : String(row.resourceId ?? metadata.resourceId ?? ''),
            environment:
              typeof row.environment === 'string'
                ? row.environment
                : typeof metadata.environment === 'string'
                  ? metadata.environment
                  : undefined,
            ipAddress: typeof row.ip === 'string' ? row.ip : undefined,
            metadata: Object.fromEntries(
              Object.entries(metadata).filter(
                ([key]) =>
                  ![
                    'eventType',
                    'actorType',
                    'tenantId',
                    'projectId',
                    'resourceType',
                    'resourceId',
                    'environment',
                    'traceId',
                    'source',
                    'schemaVersion',
                    'metadataEncoding',
                    'retentionClass',
                    'expiresAt',
                  ].includes(key),
              ),
            ),
          };
        });
      },
    );
  });

  test('decodes legacy string metadata and applies actor/action filters', async () => {
    adminAuditRows.push(
      {
        _id: 'audit-1',
        userId: 'admin-1',
        action: 'secret_rotate',
        ip: '10.0.0.1',
        metadata: JSON.stringify({
          target: 'secrets/prod/api-key',
          actorRole: 'ADMIN',
          environment: 'production',
          note: 'legacy',
        }),
        createdAt: new Date('2026-04-15T09:00:00Z'),
      },
      {
        _id: 'audit-2',
        userId: 'admin-2',
        action: 'config_view',
        ip: '10.0.0.2',
        metadata: JSON.stringify({
          target: 'config/runtime',
          actorRole: 'VIEWER',
        }),
        createdAt: new Date('2026-04-15T08:00:00Z'),
      },
    );

    const { GET } = await import('../app/api/audit/route');
    const response = await GET(
      makeRequest('http://localhost:3003/api/audit?actor=admin-1&action=secret_rotate&limit=10'),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      actor: 'admin-1',
      action: 'secret_rotate',
      actorRole: 'ADMIN',
      target: 'secrets/prod/api-key',
      environment: 'production',
      ipAddress: '10.0.0.1',
      metadata: {
        target: 'secrets/prod/api-key',
        actorRole: 'ADMIN',
        note: 'legacy',
      },
    });
  });

  test('decodes canonical object metadata rows safely', async () => {
    adminAuditRows.push({
      _id: 'audit-3',
      userId: 'admin-3',
      tenantId: 'tenant-1',
      action: 'secret_rotate',
      ip: '10.0.0.3',
      metadata: {
        target: 'secrets/staging/agent-key',
        actorRole: 'OPERATOR',
        note: 'canonical',
        eventType: 'secret_rotate',
        actorType: 'admin',
        tenantId: 'tenant-1',
        resourceType: 'secret',
        resourceId: 'secrets/staging/agent-key',
        environment: 'staging',
        source: 'admin',
        schemaVersion: 2,
        metadataEncoding: 'object',
        retentionClass: 'crud',
      },
      eventType: 'secret_rotate',
      actorType: 'admin',
      resourceType: 'secret',
      resourceId: 'secrets/staging/agent-key',
      environment: 'staging',
      source: 'admin',
      schemaVersion: 2,
      metadataEncoding: 'object',
      retentionClass: 'crud',
      createdAt: new Date('2026-04-15T10:00:00Z'),
    });

    const { GET } = await import('../app/api/audit/route');
    const response = await GET(makeRequest('http://localhost:3003/api/audit?limit=10'), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      actor: 'admin-3',
      action: 'secret_rotate',
      actorRole: 'OPERATOR',
      target: 'secrets/staging/agent-key',
      environment: 'staging',
      metadata: {
        target: 'secrets/staging/agent-key',
        actorRole: 'OPERATOR',
        note: 'canonical',
      },
    });
  });

  test('returns empty results safely when no audit rows match', async () => {
    const { GET } = await import('../app/api/audit/route');
    const response = await GET(makeRequest('http://localhost:3003/api/audit?limit=5'), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toEqual([]);
    expect(body.count).toBe(0);
  });

  test('queries audit logs through the ClickHouse reader', async () => {
    mockQueryAdminAuditLogsFromClickHouse.mockResolvedValue([
      {
        timestamp: new Date('2026-04-15T11:00:00Z'),
        actor: 'admin-clickhouse',
        actorRole: 'ADMIN',
        action: 'secret_rotate',
        target: 'secrets/prod/api-key',
        environment: 'production',
        ipAddress: '10.0.0.9',
        metadata: { note: 'clickhouse' },
      },
    ]);

    const { GET } = await import('../app/api/audit/route');
    const response = await GET(
      makeRequest('http://localhost:3003/api/audit?actor=admin-clickhouse&limit=10'),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      actor: 'admin-clickhouse',
      action: 'secret_rotate',
      actorRole: 'ADMIN',
      target: 'secrets/prod/api-key',
      environment: 'production',
      metadata: { note: 'clickhouse' },
    });
  });

  test('returns an empty result set when ClickHouse reads fail', async () => {
    adminAuditRows.push({
      _id: 'audit-strict',
      userId: 'admin-strict',
      action: 'secret_rotate',
      ip: '10.0.0.10',
      metadata: JSON.stringify({
        target: 'secrets/prod/strict-key',
        actorRole: 'ADMIN',
      }),
      createdAt: new Date('2026-04-15T13:00:00Z'),
    });
    mockQueryAdminAuditLogsFromClickHouse.mockRejectedValue(new Error('clickhouse unavailable'));

    const { GET } = await import('../app/api/audit/route');
    const response = await GET(makeRequest('http://localhost:3003/api/audit?limit=10'), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toEqual([]);
    expect(body.count).toBe(0);
  });
});
