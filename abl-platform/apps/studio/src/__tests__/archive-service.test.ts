import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClickHouseAuditQuery,
  mockIsInMemoryAuditTestBackendEnabled,
  mockQueryInMemoryAuditTestLogs,
  mockGetClickHouseClient,
  mockArchiveManifestCreate,
} = vi.hoisted(() => ({
  mockClickHouseAuditQuery: vi.fn(),
  mockIsInMemoryAuditTestBackendEnabled: vi.fn(),
  mockQueryInMemoryAuditTestLogs: vi.fn(),
  mockGetClickHouseClient: vi.fn(),
  mockArchiveManifestCreate: vi.fn(),
}));

vi.mock('@abl/compiler/platform/stores', () => {
  class ClickHouseAuditReader {
    query(params: unknown) {
      return mockClickHouseAuditQuery(params);
    }

    async close(): Promise<void> {}
  }

  return {
    ClickHouseAuditReader,
    isInMemoryAuditTestBackendEnabled: (...args: unknown[]) =>
      mockIsInMemoryAuditTestBackendEnabled(...args),
    queryInMemoryAuditTestLogs: (...args: unknown[]) => mockQueryInMemoryAuditTestLogs(...args),
  };
});

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ArchiveManifest: {
    create: (...args: unknown[]) => mockArchiveManifestCreate(...args),
  },
}));

const olderAuditLog = {
  id: 'audit-1',
  tenantId: 'tenant-1',
  timestamp: new Date('2026-04-05T10:00:00.000Z'),
  eventType: 'login' as const,
  actor: 'user-1',
  actorType: 'user' as const,
  resourceType: 'session' as const,
  resourceId: 'session-1',
  environment: 'production' as const,
  action: 'login',
  metadata: { traceId: 'trace-1' },
};

const newerAuditLog = {
  id: 'audit-2',
  tenantId: 'tenant-1',
  timestamp: new Date('2026-04-09T10:00:00.000Z'),
  eventType: 'login' as const,
  actor: 'user-2',
  actorType: 'user' as const,
  resourceType: 'session' as const,
  resourceId: 'session-2',
  environment: 'production' as const,
  action: 'login',
  metadata: { traceId: 'trace-2' },
};

describe('archive service shared audit export', () => {
  let archiveDir: string;
  let envSnapshot: Record<
    'ARCHIVE_PROVIDER' | 'ARCHIVE_PATH' | 'ARCHIVE_STORE',
    string | undefined
  >;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    envSnapshot = {
      ARCHIVE_PROVIDER: process.env.ARCHIVE_PROVIDER,
      ARCHIVE_PATH: process.env.ARCHIVE_PATH,
      ARCHIVE_STORE: process.env.ARCHIVE_STORE,
    };

    archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-audit-archive-'));
    process.env.ARCHIVE_PROVIDER = 'local';
    process.env.ARCHIVE_STORE = 'local';
    process.env.ARCHIVE_PATH = archiveDir;

    mockIsInMemoryAuditTestBackendEnabled.mockReturnValue(false);
    mockGetClickHouseClient.mockReturnValue({});
    mockArchiveManifestCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
      toObject: () => ({
        _id: 'manifest-1',
        createdAt: new Date('2026-04-20T00:00:00.000Z'),
        ...doc,
      }),
    }));
  });

  afterEach(async () => {
    process.env.ARCHIVE_PROVIDER = envSnapshot.ARCHIVE_PROVIDER;
    process.env.ARCHIVE_PATH = envSnapshot.ARCHIVE_PATH;
    process.env.ARCHIVE_STORE = envSnapshot.ARCHIVE_STORE;

    await fs.rm(archiveDir, { recursive: true, force: true });
  });

  it('archives shared audit rows from ClickHouse instead of Mongo', async () => {
    const olderThan = new Date('2026-04-10T00:00:00.000Z');
    mockClickHouseAuditQuery
      .mockResolvedValueOnce({ logs: [newerAuditLog], total: 2 })
      .mockResolvedValueOnce({ logs: [olderAuditLog], total: 2 });

    const { archiveAuditLogs } = await import('@/services/archive/archive-service');
    const manifest = await archiveAuditLogs({
      tenantId: 'tenant-1',
      type: 'audit_logs',
      olderThan,
      batchSize: 1,
    });

    expect(mockClickHouseAuditQuery).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-1',
      startTime: new Date(0),
      endTime: olderThan,
      limit: 1,
      offset: 0,
    });
    expect(mockClickHouseAuditQuery).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-1',
      startTime: new Date(0),
      endTime: olderThan,
      limit: 1,
      offset: 1,
    });
    expect(mockArchiveManifestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        type: 'audit_logs',
        recordCount: 2,
        dateRangeStart: olderAuditLog.timestamp,
        dateRangeEnd: newerAuditLog.timestamp,
      }),
    );
    expect(manifest).toEqual(
      expect.objectContaining({
        id: 'manifest-1',
        tenantId: 'tenant-1',
        type: 'audit_logs',
        recordCount: 2,
        createdAt: new Date('2026-04-20T00:00:00.000Z'),
      }),
    );
    expect(manifest?.path).toContain('tenant-1/archives/audit_logs/');
  });

  it('uses the in-memory audit backend for pipeline harness tests', async () => {
    const olderThan = new Date('2026-04-10T00:00:00.000Z');
    mockIsInMemoryAuditTestBackendEnabled.mockReturnValue(true);
    mockQueryInMemoryAuditTestLogs.mockResolvedValue({ logs: [olderAuditLog], total: 1 });

    const { archiveAuditLogs } = await import('@/services/archive/archive-service');
    const manifest = await archiveAuditLogs({
      tenantId: 'tenant-1',
      type: 'audit_logs',
      olderThan,
      batchSize: 50,
    });

    expect(mockQueryInMemoryAuditTestLogs).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      startTime: new Date(0),
      endTime: olderThan,
      limit: 50,
      offset: 0,
    });
    expect(mockClickHouseAuditQuery).not.toHaveBeenCalled();
    expect(manifest).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        type: 'audit_logs',
        recordCount: 1,
      }),
    );
  });
});
