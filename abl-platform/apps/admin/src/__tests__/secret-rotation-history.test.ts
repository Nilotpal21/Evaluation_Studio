import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockQueryAdminAuditLogsFromClickHouse } = vi.hoisted(() => ({
  mockQueryAdminAuditLogsFromClickHouse: vi.fn(),
}));

vi.mock('../lib/with-admin-route', () => ({
  withAdminRoute:
    (_options: unknown, handler: (ctx: any) => Promise<Response>) =>
    async (request: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
      handler({
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
      }),
}));

vi.mock('../lib/admin-clickhouse-audit-reader', () => ({
  queryAdminAuditLogsFromClickHouse: (...args: unknown[]) =>
    mockQueryAdminAuditLogsFromClickHouse(...args),
}));

vi.mock('../lib/vault-client', () => ({
  getVaultClient: vi.fn(),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

describe('GET /api/secrets/rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockQueryAdminAuditLogsFromClickHouse.mockResolvedValue([]);
  });

  test('returns secret rotation history from the audit query service', async () => {
    mockQueryAdminAuditLogsFromClickHouse.mockResolvedValue([
      {
        timestamp: new Date('2026-04-15T10:00:00Z'),
        actor: 'admin-2',
        actorRole: 'OPERATOR',
        action: 'secret_rotate',
        target: 'secrets/staging/agent-key',
        environment: 'staging',
        ipAddress: '10.0.0.11',
        metadata: { note: 'canonical' },
      },
      {
        timestamp: new Date('2026-04-15T09:00:00Z'),
        actor: 'admin-1',
        actorRole: 'ADMIN',
        action: 'secret_rotate',
        target: 'secrets/prod/api-key',
        environment: 'production',
        ipAddress: '10.0.0.10',
        metadata: { note: 'legacy' },
      },
    ]);

    const { GET } = await import('../app/api/secrets/rotation/route');
    const response = await GET(makeRequest('http://localhost:3003/api/secrets/rotation'), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mockQueryAdminAuditLogsFromClickHouse).toHaveBeenCalledWith({
      action: 'secret_rotate',
      limit: 50,
    });
    expect(body.rotations).toEqual([
      {
        secret: 'secrets/staging/agent-key',
        actor: 'admin-2',
        timestamp: '2026-04-15T10:00:00.000Z',
        environment: 'staging',
        ipAddress: '10.0.0.11',
      },
      {
        secret: 'secrets/prod/api-key',
        actor: 'admin-1',
        timestamp: '2026-04-15T09:00:00.000Z',
        environment: 'production',
        ipAddress: '10.0.0.10',
      },
    ]);
  });
});
