import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  mockIsDatabaseAvailable,
  mockGetClickHouseClient,
  mockCreateRuntimeAuditPipelineStore,
  mockPipelineEmitAuditEvent,
} = vi.hoisted(() => ({
  mockIsDatabaseAvailable: vi.fn(() => false),
  mockGetClickHouseClient: vi.fn(() => ({ kind: 'clickhouse-client' })),
  mockPipelineEmitAuditEvent: vi.fn(),
  mockCreateRuntimeAuditPipelineStore: vi.fn(() => ({
    kind: 'pipeline-store',
    emitAuditEvent: (...args: unknown[]) => mockPipelineEmitAuditEvent(...args),
    close: vi.fn(async () => {}),
    getPipelineStatus: vi.fn(() => ({
      healthy: true,
      started: true,
      bufferedMessages: 0,
      inFlightProducerDrains: 0,
      inFlightMaterializations: 0,
      publishedMessages: 3,
      materializedMessages: 3,
      failedProducerDrains: 0,
      failedMaterializations: 0,
      lastProducedAt: new Date('2026-04-21T10:00:00.000Z'),
      lastMaterializedAt: new Date('2026-04-21T10:01:00.000Z'),
      lastErrorAt: null,
      lastError: null,
    })),
  })),
}));

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: (...args: unknown[]) => mockIsDatabaseAvailable(...args),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: unknown[]) => mockGetClickHouseClient(...args),
}));

vi.mock('../services/audit/runtime-audit-pipeline-factory.js', () => ({
  createRuntimeAuditPipelineStore: (...args: unknown[]) =>
    mockCreateRuntimeAuditPipelineStore(...args),
}));

import {
  _resetAuditStore,
  getAuditStore,
  getAuditAlertConfigFromEnv,
  getAuditStoreStatus,
  initializeAuditStore,
  shutdownAuditStore,
  writeAuditEvent,
} from '../services/audit-store-singleton.js';

describe('AuditStoreSingleton', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    _resetAuditStore();
    vi.clearAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
    mockIsDatabaseAvailable.mockReturnValue(false);
    mockGetClickHouseClient.mockReturnValue({ kind: 'clickhouse-client' });
    mockCreateRuntimeAuditPipelineStore.mockReturnValue({
      kind: 'pipeline-store',
      emitAuditEvent: (...args: unknown[]) => mockPipelineEmitAuditEvent(...args),
      close: vi.fn(async () => {}),
      getPipelineStatus: vi.fn(() => ({
        healthy: true,
        started: true,
        bufferedMessages: 0,
        inFlightProducerDrains: 0,
        inFlightMaterializations: 0,
        publishedMessages: 3,
        materializedMessages: 3,
        failedProducerDrains: 0,
        failedMaterializations: 0,
        lastProducedAt: new Date('2026-04-21T10:00:00.000Z'),
        lastMaterializedAt: new Date('2026-04-21T10:01:00.000Z'),
        lastErrorAt: null,
        lastError: null,
      })),
    });
    mockPipelineEmitAuditEvent.mockReset();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('initializes with InMemory when no backends are available', async () => {
    await initializeAuditStore({ clickhouseReady: false });

    const store = getAuditStore();
    expect(store).toBeDefined();
    expect(store).not.toBeNull();
    expect(mockCreateRuntimeAuditPipelineStore).not.toHaveBeenCalled();
  });

  test('getAuditStore() returns null before initialization', () => {
    expect(getAuditStore()).toBeNull();
  });

  test('reports audit store status for the pipeline backend', async () => {
    await initializeAuditStore({
      clickhouseReady: true,
    });

    expect(getAuditStoreStatus()).toMatchObject({
      initialized: true,
      backend: 'pipeline',
      healthy: true,
      pipeline: {
        publishedMessages: 3,
        materializedMessages: 3,
      },
    });
  });

  test('passes ClickHouse client and tenant through pipeline initialization', async () => {
    await initializeAuditStore({
      clickhouseReady: true,
      clickhouseTenantId: 'tenant-a',
    });

    expect(mockCreateRuntimeAuditPipelineStore).toHaveBeenCalledWith({
      client: { kind: 'clickhouse-client' },
      tenantId: 'tenant-a',
      alertConfig: undefined,
    });
  });

  test('threads alert config into pipeline initialization', async () => {
    const alertConfig = {
      criticalEvents: ['permission.denied'],
      alertChannels: ['slack'],
    };

    await initializeAuditStore({
      clickhouseReady: true,
      clickhouseTenantId: 'tenant-a',
      alertConfig,
    });

    expect(mockCreateRuntimeAuditPipelineStore).toHaveBeenCalledWith({
      client: { kind: 'clickhouse-client' },
      tenantId: 'tenant-a',
      alertConfig,
    });
  });

  test('initializes the Kafka -> ClickHouse audit pipeline when ClickHouse is ready', async () => {
    await initializeAuditStore({
      clickhouseReady: true,
      clickhouseTenantId: 'tenant-a',
    });

    expect(mockCreateRuntimeAuditPipelineStore).toHaveBeenCalledWith({
      client: { kind: 'clickhouse-client' },
      tenantId: 'tenant-a',
      alertConfig: undefined,
    });
    expect(getAuditStore()).toMatchObject({ kind: 'pipeline-store' });
  });

  test('writes canonical audit events through the pipeline emitter when the pipeline backend is active', async () => {
    await initializeAuditStore({
      clickhouseReady: true,
    });

    await writeAuditEvent({
      auditId: 'audit-1',
      stream: 'shared',
      schemaVersion: 2,
      source: 'runtime-auth',
      eventType: 'auth.user.success',
      action: 'auth.user.success',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: null,
      resourceType: 'auth',
      resourceId: 'user-1',
      environment: 'production',
      traceId: null,
      ipAddress: null,
      userAgent: null,
      metadata: { requestId: 'req-1' },
      metadataEncoding: 'object',
      retentionClass: 'auth',
      expiresAt: null,
      timestamp: new Date('2026-04-22T10:00:00.000Z'),
      oldValue: null,
      newValue: null,
    });

    expect(mockPipelineEmitAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('does not fall back when pipeline initialization fails', async () => {
    // isInMemoryAuditFallbackAllowed() permits the in-memory fallback only when
    // NODE_ENV is 'test' or 'development'. The fail-closed assertion below
    // expects production behaviour, so explicitly disable the fallback gate.
    process.env.NODE_ENV = 'production';
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockCreateRuntimeAuditPipelineStore.mockRejectedValueOnce(new Error('kafka unavailable'));

    await expect(
      initializeAuditStore({
        clickhouseReady: true,
      }),
    ).rejects.toThrow('kafka unavailable');

    expect(getAuditStore()).toBeNull();
    expect(getAuditStoreStatus()).toMatchObject({
      initialized: false,
      backend: 'uninitialized',
      healthy: null,
      pipeline: null,
    });
  });

  test('fails closed when ClickHouse is unavailable outside test mode', async () => {
    process.env.NODE_ENV = 'production';
    mockIsDatabaseAvailable.mockReturnValue(true);

    await expect(
      initializeAuditStore({
        clickhouseReady: false,
      }),
    ).rejects.toThrow('Shared audit Kafka -> ClickHouse pipeline is unavailable');

    expect(getAuditStore()).toBeNull();
    expect(getAuditStoreStatus()).toMatchObject({
      initialized: false,
      backend: 'uninitialized',
      healthy: null,
      pipeline: null,
    });
  });

  test('uses in-memory backend when ClickHouse is unavailable even if Mongo is available', async () => {
    mockIsDatabaseAvailable.mockReturnValue(true);

    await initializeAuditStore({
      clickhouseReady: false,
    });

    expect(getAuditStoreStatus()).toMatchObject({
      initialized: true,
      backend: 'memory',
      healthy: true,
      pipeline: null,
    });
  });

  test('builds alert config from env when explicit config is absent', async () => {
    process.env.AUDIT_LOG_ALERTS_ENABLED = 'true';
    process.env.AUDIT_LOG_ALERT_WEBHOOK_URL = 'https://alerts.example.com/webhook';
    process.env.AUDIT_LOG_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.test/services/abc';
    process.env.AUDIT_LOG_ALERT_CRITICAL_EVENTS = 'permission.denied,rate_limit.hit';

    await initializeAuditStore({ clickhouseReady: true });

    expect(mockCreateRuntimeAuditPipelineStore).toHaveBeenCalledWith({
      client: { kind: 'clickhouse-client' },
      tenantId: undefined,
      alertConfig: {
        enabled: true,
        webhookUrl: 'https://alerts.example.com/webhook',
        slackWebhook: 'https://hooks.slack.test/services/abc',
        criticalEvents: ['permission.denied', 'rate_limit.hit'],
      },
    });

    delete process.env.AUDIT_LOG_ALERTS_ENABLED;
    delete process.env.AUDIT_LOG_ALERT_WEBHOOK_URL;
    delete process.env.AUDIT_LOG_ALERT_SLACK_WEBHOOK;
    delete process.env.AUDIT_LOG_ALERT_CRITICAL_EVENTS;
  });

  test('returns undefined audit alert config when alerts are disabled', () => {
    expect(getAuditAlertConfigFromEnv({ AUDIT_LOG_ALERTS_ENABLED: 'false' })).toBeUndefined();
  });

  test('only initializes once', async () => {
    await initializeAuditStore({ clickhouseReady: false });
    const store1 = getAuditStore();

    await initializeAuditStore({ clickhouseReady: true, clickhouseTenantId: 'tenant-a' });
    const store2 = getAuditStore();

    expect(store1).toBe(store2);
    expect(mockCreateRuntimeAuditPipelineStore).not.toHaveBeenCalled();
  });

  test('_resetAuditStore clears singleton state', async () => {
    await initializeAuditStore({ clickhouseReady: false });
    expect(getAuditStore()).not.toBeNull();

    _resetAuditStore();
    expect(getAuditStore()).toBeNull();
    expect(getAuditStoreStatus()).toMatchObject({
      initialized: false,
      backend: 'uninitialized',
      healthy: null,
      pipeline: null,
    });
  });

  test('shutdownAuditStore closes and clears the initialized store', async () => {
    const close = vi.fn(async () => {});
    mockCreateRuntimeAuditPipelineStore.mockReturnValueOnce({
      kind: 'pipeline-store',
      close,
    });

    await initializeAuditStore({
      clickhouseReady: true,
    });

    await shutdownAuditStore();

    expect(close).toHaveBeenCalledTimes(1);
    expect(getAuditStore()).toBeNull();
  });
});
