/**
 * ClickHouse Store Factory
 *
 * Creates and configures all ClickHouse store instances for the runtime.
 * Handles initialization of the ClickHouse schema and provides a unified
 * interface for obtaining store instances with proper dependency injection.
 *
 * Usage:
 *   const factory = await createClickHouseStoreFactory({ tenantId });
 *   const messageStore = factory.messageStore;
 *   const metricsStore = factory.metricsStore;
 *   // ... use stores ...
 *   await factory.close();
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  getClickHouseClient,
  closeClickHouseClient,
  type ClickHouseConfig,
} from '@agent-platform/database/clickhouse';
import { ClickHouseMessageStore } from './clickhouse-message-store.js';
import { ClickHouseMetricsStore } from './clickhouse-metrics-store.js';
import { ClickHouseAuditStore } from './clickhouse-audit-store.js';
import { ClickHouseFactStore } from './clickhouse-fact-store.js';

function isCanonicalAuditWriterEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RUNTIME_AUDIT_CANONICAL_WRITER_ENABLED === 'true';
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface ClickHouseStoreFactoryOptions {
  /** Tenant ID for data isolation */
  tenantId: string;
  /** Optional ClickHouse client config override */
  clickhouseConfig?: ClickHouseConfig;
}

export interface ClickHouseStoreFactory {
  /** ClickHouse client instance */
  readonly client: ClickHouseClient;
  /** Message store backed by the ClickHouse field-encryption pipeline */
  readonly messageStore: ClickHouseMessageStore;
  /** LLM metrics store (no encryption) */
  readonly metricsStore: ClickHouseMetricsStore;
  /** Audit store (no encryption, compliance) */
  readonly auditStore: ClickHouseAuditStore;
  /** Fact store (key-value with UPSERT semantics) */
  readonly factStore: ClickHouseFactStore;
  /** Close all store writers and the ClickHouse client */
  close(): Promise<void>;
}

// =============================================================================
// FACTORY
// =============================================================================

export async function createClickHouseStoreFactory(
  options: ClickHouseStoreFactoryOptions,
): Promise<ClickHouseStoreFactory> {
  const { tenantId, clickhouseConfig } = options;

  const client = getClickHouseClient(clickhouseConfig);

  const messageStore = new ClickHouseMessageStore({ type: 'clickhouse' }, { client, tenantId });

  const metricsStore = new ClickHouseMetricsStore({ type: 'clickhouse' }, { client, tenantId });

  const auditStore = new ClickHouseAuditStore(
    { type: 'clickhouse' },
    {
      client,
      tenantId,
      canonicalWriterEnabled: isCanonicalAuditWriterEnabled(),
    },
  );

  const factStore = new ClickHouseFactStore({ type: 'clickhouse' }, { client });

  return {
    client,
    messageStore,
    metricsStore,
    auditStore,
    factStore,
    async close() {
      await Promise.all([messageStore.close(), metricsStore.close(), auditStore.close()]);
      await closeClickHouseClient();
    },
  };
}
