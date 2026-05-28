import { createLogger } from '@abl/compiler/platform';
import type { AlertConfig } from '@abl/compiler/platform/stores/audit-store.js';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  KafkaAuditTransport,
  getKafkaAuditTransportConfigFromEnv,
} from './kafka-audit-transport.js';
import { RuntimeClickHouseAuditSink } from './runtime-clickhouse-audit-sink.js';
import { RuntimeAuditMaterializer } from './runtime-audit-materializer.js';
import { RuntimeAuditPipelineStore } from './runtime-audit-pipeline-store.js';
import { TransportBackedAuditEmitter } from './transport-backed-audit-emitter.js';
import {
  createRuntimeAuditPolicyResolver,
  resolveRuntimeAuditTopicsFromEnv,
} from './runtime-audit-policy-resolver.js';
import { ClickHouseAuditStore } from '../stores/clickhouse-audit-store.js';

const log = createLogger('runtime-audit-pipeline-factory');

export interface RuntimeAuditPipelineFactoryOptions {
  client: ClickHouseClient;
  tenantId?: string;
  alertConfig?: AlertConfig;
}

export async function createRuntimeAuditPipelineStore(
  options: RuntimeAuditPipelineFactoryOptions,
): Promise<RuntimeAuditPipelineStore> {
  const topics = resolveRuntimeAuditTopicsFromEnv();
  const policyResolver = createRuntimeAuditPolicyResolver();
  const readerAndSink = new ClickHouseAuditStore(
    { type: 'clickhouse' },
    {
      client: options.client,
      tenantId: options.tenantId,
      canonicalWriterEnabled: true,
    },
    options.alertConfig,
  );
  const sink = new RuntimeClickHouseAuditSink({
    client: options.client,
    policyResolver,
    sharedSink: readerAndSink,
  });
  const materializer = new RuntimeAuditMaterializer(sink);
  const transportConfig = getKafkaAuditTransportConfigFromEnv();
  log.info('Runtime audit pipeline transport starting', {
    brokerCount: transportConfig.brokers.length,
    clientId: transportConfig.clientId,
    groupId: transportConfig.groupId,
    topics: transportConfig.topics,
    batchSize: transportConfig.batchSize,
    lingerMs: transportConfig.lingerMs,
    maxRetries: transportConfig.maxRetries,
    retryInitialMs: transportConfig.retryInitialMs,
    consumerConcurrency: transportConfig.consumerConcurrency,
    maxBufferedMessages: transportConfig.maxBufferedMessages,
    walEnabled: transportConfig.resilience?.enabled === true,
  });

  const transport = new KafkaAuditTransport(transportConfig, policyResolver);
  try {
    await transport.start(materializer);
  } catch (error) {
    log.error('Runtime audit pipeline transport failed to start', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      brokerCount: transportConfig.brokers.length,
      clientId: transportConfig.clientId,
      groupId: transportConfig.groupId,
      topics: transportConfig.topics,
    });
    throw error;
  }

  log.info('Runtime audit pipeline store initialized', {
    sharedTopic: topics.shared,
    kmsTopic: topics.kms,
    piiTopic: topics.pii,
    connectorTopic: topics.connector,
    crawlTopic: topics.crawl,
    archTopic: topics.arch,
    omnichannelTopic: topics.omnichannel,
  });

  return new RuntimeAuditPipelineStore(
    { type: 'clickhouse' },
    {
      emitter: new TransportBackedAuditEmitter(transport),
      reader: readerAndSink,
      materializer,
    },
    options.alertConfig,
  );
}
