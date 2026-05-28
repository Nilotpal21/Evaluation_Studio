import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
  mockGetClickHouseClient,
  mockCloseClickHouseClient,
  mockClickHouseMessageStore,
  mockClickHouseMetricsStore,
  mockClickHouseAuditStore,
  mockClickHouseFactStore,
  mockMessageStoreClose,
  mockMetricsStoreClose,
  mockAuditStoreClose,
} = vi.hoisted(() => ({
  mockGetClickHouseClient: vi.fn(),
  mockCloseClickHouseClient: vi.fn().mockResolvedValue(undefined),
  mockClickHouseMessageStore: vi.fn(),
  mockClickHouseMetricsStore: vi.fn(),
  mockClickHouseAuditStore: vi.fn(),
  mockClickHouseFactStore: vi.fn(),
  mockMessageStoreClose: vi.fn().mockResolvedValue(undefined),
  mockMetricsStoreClose: vi.fn().mockResolvedValue(undefined),
  mockAuditStoreClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
  closeClickHouseClient: (...args: unknown[]) => mockCloseClickHouseClient(...args),
}));

vi.mock('../services/stores/clickhouse-message-store.js', () => ({
  ClickHouseMessageStore: vi.fn(function (...args: unknown[]) {
    mockClickHouseMessageStore(...args);
    return { close: mockMessageStoreClose };
  }),
}));

vi.mock('../services/stores/clickhouse-metrics-store.js', () => ({
  ClickHouseMetricsStore: vi.fn(function (...args: unknown[]) {
    mockClickHouseMetricsStore(...args);
    return { close: mockMetricsStoreClose };
  }),
}));

vi.mock('../services/stores/clickhouse-audit-store.js', () => ({
  ClickHouseAuditStore: vi.fn(function (...args: unknown[]) {
    mockClickHouseAuditStore(...args);
    return { close: mockAuditStoreClose };
  }),
}));

vi.mock('../services/stores/clickhouse-fact-store.js', () => ({
  ClickHouseFactStore: vi.fn(function (...args: unknown[]) {
    mockClickHouseFactStore(...args);
    return {};
  }),
}));

describe('createClickHouseStoreFactory', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.RUNTIME_AUDIT_CANONICAL_WRITER_ENABLED;
    mockGetClickHouseClient.mockReturnValue({ query: vi.fn(), close: vi.fn() });
  });

  test('passes canonical audit writer flag through to the audit store constructor', async () => {
    process.env.RUNTIME_AUDIT_CANONICAL_WRITER_ENABLED = 'true';
    const client = { query: vi.fn(), close: vi.fn() };
    mockGetClickHouseClient.mockReturnValue(client);

    const { createClickHouseStoreFactory } =
      await import('../services/stores/clickhouse-store-factory.js');

    await createClickHouseStoreFactory({ tenantId: 'tenant-1' });

    expect(mockClickHouseAuditStore).toHaveBeenCalledWith(
      { type: 'clickhouse' },
      expect.objectContaining({
        client,
        tenantId: 'tenant-1',
        canonicalWriterEnabled: true,
      }),
    );
  });

  test('closes store writers and the shared ClickHouse client', async () => {
    const { createClickHouseStoreFactory } =
      await import('../services/stores/clickhouse-store-factory.js');

    const factory = await createClickHouseStoreFactory({ tenantId: 'tenant-1' });
    await factory.close();

    expect(mockMessageStoreClose).toHaveBeenCalledTimes(1);
    expect(mockMetricsStoreClose).toHaveBeenCalledTimes(1);
    expect(mockAuditStoreClose).toHaveBeenCalledTimes(1);
    expect(mockCloseClickHouseClient).toHaveBeenCalledTimes(1);
  });
});
