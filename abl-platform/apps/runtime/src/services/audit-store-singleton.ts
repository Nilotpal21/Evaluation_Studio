/**
 * Audit Store Singleton
 *
 * Central audit store accessor with migration-aware initialization:
 * strict Kafka -> ClickHouse pipeline > InMemory.
 *
 * Call initializeAuditStore() at server startup after DB and ClickHouse init.
 * Use getAuditStore() everywhere else for fire-and-forget audit writes.
 */

import type { AlertConfig, AuditStore } from '@abl/compiler/platform/stores/audit-store.js';
import {
  toAuditLogFromAuditEvent,
  type AuditEvent,
  type AuditTransportStatus,
} from '@abl/compiler/platform/stores/audit-pipeline.js';
import { isDatabaseAvailable } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import { resolveRuntimeAuditTopicsFromEnv } from './audit/runtime-audit-policy-resolver.js';

const log = createLogger('audit-store-singleton');

let _auditStore: AuditStore | null = null;
let _initialized = false;
let _auditStoreBackend: AuditStoreBackend = 'uninitialized';

export type AuditStoreBackend = 'uninitialized' | 'pipeline' | 'memory';

export interface AuditStoreStatus {
  initialized: boolean;
  backend: AuditStoreBackend;
  healthy: boolean | null;
  pipeline: AuditTransportStatus | null;
}

export interface InitializeAuditStoreOptions {
  clickhouseReady: boolean;
  clickhouseTenantId?: string;
  alertConfig?: AlertConfig;
  clickhouseInitFailure?: {
    message: string;
    name?: string;
    stack?: string;
  } | null;
}

interface AuditEventEmitterLike {
  emitAuditEvent(event: AuditEvent): void;
}

interface AuditEventSinkLike {
  write(event: AuditEvent): Promise<void>;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  return fallback;
}

function isInMemoryAuditFallbackAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
}

function getAuditStartupDiagnostics(
  opts: InitializeAuditStoreOptions,
  env: Record<string, string | undefined> = process.env,
) {
  const topics = resolveRuntimeAuditTopicsFromEnv(env);

  return {
    clickhouseReady: opts.clickhouseReady,
    clickhouseInitFailure: opts.clickhouseInitFailure ?? null,
    databaseAvailable: isDatabaseAvailable(),
    nodeEnv: env.NODE_ENV,
    inMemoryFallbackAllowed: isInMemoryAuditFallbackAllowed(env),
    auditPipelineEnabled: env.AUDIT_PIPELINE_ENABLED,
    auditKafkaBrokersConfigured: Boolean(env.AUDIT_KAFKA_BROKERS || env.EVENT_KAFKA_BROKERS),
    auditKafkaClientId: env.AUDIT_KAFKA_CLIENT_ID,
    auditKafkaGroupId: env.AUDIT_KAFKA_GROUP_ID,
    auditTopics: {
      shared: topics.shared,
      kms: topics.kms,
      pii: topics.pii,
      connector: topics.connector,
      crawl: topics.crawl,
      arch: topics.arch,
      archPayload: topics.arch_payload,
      omnichannel: topics.omnichannel,
    },
  };
}

export function getAuditAlertConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AlertConfig | undefined {
  const enabled = parseBooleanEnv(env.AUDIT_LOG_ALERTS_ENABLED, false);
  if (!enabled) {
    return undefined;
  }

  const webhookUrl = env.AUDIT_LOG_ALERT_WEBHOOK_URL?.trim() || undefined;
  const slackWebhook = env.AUDIT_LOG_ALERT_SLACK_WEBHOOK?.trim() || undefined;
  const criticalEvents = (env.AUDIT_LOG_ALERT_CRITICAL_EVENTS ?? '')
    .split(',')
    .map((eventType) => eventType.trim())
    .filter(
      (eventType): eventType is AlertConfig['criticalEvents'][number] => eventType.length > 0,
    );

  return {
    enabled: true,
    webhookUrl,
    slackWebhook,
    criticalEvents,
  };
}

export async function initializeAuditStore(opts: InitializeAuditStoreOptions): Promise<void> {
  if (_initialized) return;

  const resolvedAlertConfig = opts.alertConfig ?? getAuditAlertConfigFromEnv();
  log.info('Audit store initialization starting', getAuditStartupDiagnostics(opts));
  if (opts.clickhouseReady) {
    try {
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();
      const { createRuntimeAuditPipelineStore } =
        await import('./audit/runtime-audit-pipeline-factory.js');

      _auditStore = await createRuntimeAuditPipelineStore({
        client,
        tenantId: opts.clickhouseTenantId,
        alertConfig: resolvedAlertConfig,
      });
      _initialized = true;
      _auditStoreBackend = 'pipeline';
      log.info('Audit store initialized with Kafka -> ClickHouse pipeline backend', {
        alertingEnabled: resolvedAlertConfig?.enabled === true,
        tenantScoped: Boolean(opts.clickhouseTenantId),
      });
      return;
    } catch (err) {
      if (!isInMemoryAuditFallbackAllowed()) {
        log.error(
          'Kafka -> ClickHouse audit pipeline init failed; shared audit fallback is disabled',
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        throw err;
      }
      log.warn(
        'Kafka -> ClickHouse audit pipeline init failed; falling back to in-memory audit store',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  if (!opts.clickhouseReady && !isInMemoryAuditFallbackAllowed()) {
    log.error(
      'Shared audit Kafka -> ClickHouse pipeline is unavailable; refusing to boot',
      getAuditStartupDiagnostics(opts),
    );
    throw new Error('Shared audit Kafka -> ClickHouse pipeline is unavailable');
  }

  if (!opts.clickhouseReady && isDatabaseAvailable()) {
    log.warn(
      'Shared audit Kafka -> ClickHouse pipeline is unavailable in test mode; runtime will use in-memory audit storage',
    );
  }

  // In-memory fallback (test only)
  const { InMemoryAuditStore } = await import('@abl/compiler/platform/stores/audit-store.js');
  _auditStore = new InMemoryAuditStore({ type: 'memory' });
  _initialized = true;
  _auditStoreBackend = 'memory';
  log.info('Audit store initialized with in-memory backend');
}

export function getAuditStore(): AuditStore | null {
  return _auditStore;
}

function hasAuditEventEmitter(store: AuditStore): store is AuditStore & AuditEventEmitterLike {
  return 'emitAuditEvent' in store && typeof store.emitAuditEvent === 'function';
}

function hasAuditEventSink(store: AuditStore): store is AuditStore & AuditEventSinkLike {
  return 'write' in store && typeof store.write === 'function';
}

function getPipelineTransportStatus(store: AuditStore | null): AuditTransportStatus | null {
  if (!store || _auditStoreBackend !== 'pipeline') {
    return null;
  }

  const maybeStore = store as AuditStore & {
    getPipelineStatus?: () => AuditTransportStatus | null;
  };
  return maybeStore.getPipelineStatus?.() ?? null;
}

export function getAuditStoreStatus(): AuditStoreStatus {
  const pipeline = getPipelineTransportStatus(_auditStore);
  return {
    initialized: _initialized,
    backend: _auditStoreBackend,
    healthy:
      _auditStoreBackend === 'pipeline' ? (pipeline?.healthy ?? false) : _auditStore ? true : null,
    pipeline,
  };
}

export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  if (!_auditStore) {
    throw new Error('Audit store is not initialized');
  }

  if (hasAuditEventEmitter(_auditStore)) {
    _auditStore.emitAuditEvent(event);
    return;
  }

  if (hasAuditEventSink(_auditStore)) {
    await _auditStore.write(event);
    return;
  }

  const auditLog = toAuditLogFromAuditEvent(event);
  await _auditStore.log({
    tenantId: auditLog.tenantId,
    projectId: auditLog.projectId,
    eventType: auditLog.eventType,
    actor: auditLog.actor,
    actorType: auditLog.actorType,
    resourceType: auditLog.resourceType,
    resourceId: auditLog.resourceId,
    environment: auditLog.environment,
    action: auditLog.action,
    oldValue: auditLog.oldValue,
    newValue: auditLog.newValue,
    metadata: auditLog.metadata,
    ipAddress: auditLog.ipAddress,
    traceId: auditLog.traceId,
    schemaVersion: auditLog.schemaVersion,
    source: auditLog.source,
    metadataEncoding: auditLog.metadataEncoding,
    retentionClass: auditLog.retentionClass,
    expiresAt: auditLog.expiresAt,
  });
}

export async function shutdownAuditStore(): Promise<void> {
  if (!_auditStore) {
    _initialized = false;
    _auditStoreBackend = 'uninitialized';
    return;
  }

  try {
    await _auditStore.close();
  } finally {
    _auditStore = null;
    _initialized = false;
    _auditStoreBackend = 'uninitialized';
  }
}

/** Test helper — reset singleton state */
export function _resetAuditStore(): void {
  _auditStore = null;
  _initialized = false;
  _auditStoreBackend = 'uninitialized';
}
