import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  initClickHouseSchema,
  resolveClickHouseAuditRetentionConfig,
} from '../clickhouse-schemas/init.js';

function createMockClickHouseClient() {
  return {
    command: vi.fn().mockResolvedValue(undefined),
  };
}

function findCommandQuery(
  client: ReturnType<typeof createMockClickHouseClient>,
  pattern: string,
): string | undefined {
  return client.command.mock.calls
    .map(([arg]) => (arg as { query: string }).query)
    .find((query) => query.includes(pattern));
}

describe('ClickHouse audit retention schema', () => {
  const originalReplicated = process.env.CLICKHOUSE_REPLICATED;
  const originalTieredStorage = process.env.CLICKHOUSE_TIERED_STORAGE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDeploymentEnv = process.env.DEPLOYMENT_ENVIRONMENT;
  const originalRuntimeEnv = process.env.RUNTIME_ENV;
  const originalAppEnv = process.env.APP_ENV;
  const originalAuditEventsColdTtl = process.env.AUDIT_EVENTS_COLD_TTL_DAYS;
  const originalAuditEventsDeleteTtl = process.env.AUDIT_EVENTS_DELETE_TTL_DAYS;
  const originalKmsAuditWarmTtl = process.env.KMS_AUDIT_WARM_TTL_DAYS;
  const originalKmsAuditDeleteTtl = process.env.KMS_AUDIT_DELETE_TTL_DAYS;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEPLOYMENT_ENVIRONMENT;
    delete process.env.RUNTIME_ENV;
    delete process.env.APP_ENV;
    delete process.env.AUDIT_EVENTS_COLD_TTL_DAYS;
    delete process.env.AUDIT_EVENTS_DELETE_TTL_DAYS;
    delete process.env.KMS_AUDIT_WARM_TTL_DAYS;
    delete process.env.KMS_AUDIT_DELETE_TTL_DAYS;
  });

  afterEach(() => {
    if (originalReplicated === undefined) {
      delete process.env.CLICKHOUSE_REPLICATED;
    } else {
      process.env.CLICKHOUSE_REPLICATED = originalReplicated;
    }

    if (originalTieredStorage === undefined) {
      delete process.env.CLICKHOUSE_TIERED_STORAGE;
    } else {
      process.env.CLICKHOUSE_TIERED_STORAGE = originalTieredStorage;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalDeploymentEnv === undefined) {
      delete process.env.DEPLOYMENT_ENVIRONMENT;
    } else {
      process.env.DEPLOYMENT_ENVIRONMENT = originalDeploymentEnv;
    }

    if (originalRuntimeEnv === undefined) {
      delete process.env.RUNTIME_ENV;
    } else {
      process.env.RUNTIME_ENV = originalRuntimeEnv;
    }

    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }

    if (originalAuditEventsColdTtl === undefined) {
      delete process.env.AUDIT_EVENTS_COLD_TTL_DAYS;
    } else {
      process.env.AUDIT_EVENTS_COLD_TTL_DAYS = originalAuditEventsColdTtl;
    }

    if (originalAuditEventsDeleteTtl === undefined) {
      delete process.env.AUDIT_EVENTS_DELETE_TTL_DAYS;
    } else {
      process.env.AUDIT_EVENTS_DELETE_TTL_DAYS = originalAuditEventsDeleteTtl;
    }

    if (originalKmsAuditWarmTtl === undefined) {
      delete process.env.KMS_AUDIT_WARM_TTL_DAYS;
    } else {
      process.env.KMS_AUDIT_WARM_TTL_DAYS = originalKmsAuditWarmTtl;
    }

    if (originalKmsAuditDeleteTtl === undefined) {
      delete process.env.KMS_AUDIT_DELETE_TTL_DAYS;
    } else {
      process.env.KMS_AUDIT_DELETE_TTL_DAYS = originalKmsAuditDeleteTtl;
    }
  });

  test('uses production retention defaults when deployment environment resolves to production', () => {
    const config = resolveClickHouseAuditRetentionConfig({
      DEPLOYMENT_ENVIRONMENT: 'production',
    });

    expect(config).toEqual({
      deploymentEnvironment: 'production',
      auditEvents: {
        coldVolumeDays: 90,
        deleteDays: 730,
      },
      kmsAudit: {
        warmVolumeDays: 365,
        deleteDays: 1095,
      },
      archAudit: {
        deleteDays: 90,
      },
      omnichannelAudit: {
        deleteDays: 180,
      },
    });
  });

  test('uses staging retention defaults for preview-like environments', () => {
    const config = resolveClickHouseAuditRetentionConfig({
      APP_ENV: 'preview',
    });

    expect(config).toEqual({
      deploymentEnvironment: 'staging',
      auditEvents: {
        coldVolumeDays: 30,
        deleteDays: 180,
      },
      kmsAudit: {
        warmVolumeDays: 90,
        deleteDays: 365,
      },
      archAudit: {
        deleteDays: 90,
      },
      omnichannelAudit: {
        deleteDays: 90,
      },
    });
  });

  test('allows explicit TTL overrides on top of deployment defaults', () => {
    const config = resolveClickHouseAuditRetentionConfig({
      DEPLOYMENT_ENVIRONMENT: 'staging',
      AUDIT_EVENTS_COLD_TTL_DAYS: '14',
      AUDIT_EVENTS_DELETE_TTL_DAYS: '45',
      KMS_AUDIT_WARM_TTL_DAYS: '30',
      KMS_AUDIT_DELETE_TTL_DAYS: '120',
    });

    expect(config).toEqual({
      deploymentEnvironment: 'staging',
      auditEvents: {
        coldVolumeDays: 14,
        deleteDays: 45,
      },
      kmsAudit: {
        warmVolumeDays: 30,
        deleteDays: 120,
      },
      archAudit: {
        deleteDays: 90,
      },
      omnichannelAudit: {
        deleteDays: 90,
      },
    });
  });

  test('adds cold-storage and delete TTLs when tiered storage is enabled', async () => {
    process.env.CLICKHOUSE_REPLICATED = 'true';
    process.env.CLICKHOUSE_TIERED_STORAGE = 'true';
    process.env.DEPLOYMENT_ENVIRONMENT = 'production';
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);

    const createAuditEvents = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.audit_events',
    );
    const modifyAuditEventsTtl = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.audit_events MODIFY TTL',
    );

    expect(createAuditEvents).toContain("timestamp + INTERVAL 90 DAY TO VOLUME 'cold'");
    expect(createAuditEvents).toContain('timestamp + INTERVAL 730 DAY DELETE');
    expect(modifyAuditEventsTtl).toContain("timestamp + INTERVAL 90 DAY TO VOLUME 'cold'");
    expect(modifyAuditEventsTtl).toContain('timestamp + INTERVAL 730 DAY DELETE');
  });

  test('uses delete-only TTLs in non-replicated dev mode', async () => {
    process.env.CLICKHOUSE_REPLICATED = 'false';
    process.env.NODE_ENV = 'development';
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);

    const createAuditEvents = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.audit_events',
    );
    const modifyAuditEventsTtl = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.audit_events MODIFY TTL',
    );

    expect(createAuditEvents).not.toContain("TO VOLUME 'cold'");
    expect(createAuditEvents).toContain('timestamp + INTERVAL 30 DAY DELETE');
    expect(modifyAuditEventsTtl).toBe(
      'ALTER TABLE abl_platform.audit_events MODIFY TTL timestamp + INTERVAL 30 DAY DELETE',
    );
  });

  test('retains kms_audit_log rows for three years', async () => {
    process.env.CLICKHOUSE_REPLICATED = 'true';
    process.env.RUNTIME_ENV = 'production';
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);

    const createKmsAuditLog = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.kms_audit_log',
    );

    expect(createKmsAuditLog).toContain('toDateTime(timestamp) + INTERVAL 1095 DAY DELETE');
  });

  test('creates pii and arch audit tables with the expected TTL contracts', async () => {
    process.env.CLICKHOUSE_REPLICATED = 'true';
    process.env.RUNTIME_ENV = 'production';
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);

    const createPiiAuditLog = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.pii_audit_log',
    );
    const modifyPiiAuditTtl = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.pii_audit_log MODIFY TTL',
    );
    const createArchAuditLog = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.arch_audit_log',
    );
    const modifyArchAuditTtl = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.arch_audit_log MODIFY TTL',
    );

    expect(createPiiAuditLog).toContain('toDateTime(expire_at) DELETE');
    expect(modifyPiiAuditTtl).toBe(
      'ALTER TABLE abl_platform.pii_audit_log MODIFY TTL toDateTime(expire_at) DELETE',
    );
    expect(createArchAuditLog).toContain('toDateTime(timestamp) + INTERVAL 90 DAY DELETE');
    expect(modifyArchAuditTtl).toContain('toDateTime(timestamp) + INTERVAL 90 DAY DELETE');
  });

  test('applies staging retention to audit_events and kms_audit_log DDL', async () => {
    process.env.CLICKHOUSE_REPLICATED = 'true';
    process.env.CLICKHOUSE_TIERED_STORAGE = 'true';
    process.env.APP_ENV = 'staging';
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);

    const createAuditEvents = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.audit_events',
    );
    const modifyAuditEventsTtl = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.audit_events MODIFY TTL',
    );
    const createKmsAuditLog = findCommandQuery(
      client,
      'CREATE TABLE IF NOT EXISTS abl_platform.kms_audit_log',
    );
    const modifyKmsAuditTtl = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.kms_audit_log MODIFY TTL',
    );

    expect(createAuditEvents).toContain("timestamp + INTERVAL 30 DAY TO VOLUME 'cold'");
    expect(createAuditEvents).toContain('timestamp + INTERVAL 180 DAY DELETE');
    expect(modifyAuditEventsTtl).toContain("timestamp + INTERVAL 30 DAY TO VOLUME 'cold'");
    expect(modifyAuditEventsTtl).toContain('timestamp + INTERVAL 180 DAY DELETE');
    expect(createKmsAuditLog).toContain("toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm'");
    expect(createKmsAuditLog).toContain('toDateTime(timestamp) + INTERVAL 365 DAY DELETE');
    expect(modifyKmsAuditTtl).toContain("toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm'");
    expect(modifyKmsAuditTtl).toContain('toDateTime(timestamp) + INTERVAL 365 DAY DELETE');
  });

  test('runs ADD COLUMN project_id migration on messages table', async () => {
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);

    const addProjectId = findCommandQuery(
      client,
      'ALTER TABLE abl_platform.messages ADD COLUMN IF NOT EXISTS project_id',
    );
    expect(addProjectId).toBeDefined();
    expect(addProjectId).toContain("String DEFAULT ''");
  });

  test('project_id migration is idempotent — ADD COLUMN IF NOT EXISTS runs once per init call', async () => {
    const client = createMockClickHouseClient();

    await initClickHouseSchema(client as any);
    await initClickHouseSchema(client as any);

    const migrationQueries = client.command.mock.calls
      .map(([arg]) => (arg as { query: string }).query)
      .filter((q) => q.includes('messages ADD COLUMN IF NOT EXISTS project_id'));

    expect(migrationQueries.length).toBe(2);
  });
});
