#!/usr/bin/env tsx
/**
 * Kafka topic seed entrypoint.
 *
 * Creates the platform's event topics on the configured broker. Idempotent —
 * topics that already exist are left alone (KafkaJS createTopics returns
 * `false` for those). Run during deploy (Dockerfile init/seed stage) or
 * manually via `pnpm seed:kafka`.
 *
 * Usage:
 *   pnpm tsx scripts/seed-kafka.ts            # create missing topics
 *   pnpm tsx scripts/seed-kafka.ts --status   # list topics, no changes
 *   pnpm tsx scripts/seed-kafka.ts --dry-run  # show what would be created
 *
 * Env vars:
 *   EVENT_KAFKA_BROKERS              comma-separated bootstrap brokers
 *   KAFKA_TOPIC_PARTITIONS              default partition count (default: 3)
 *   KAFKA_TOPIC_REPLICATION_FACTOR      default replication factor (default: 1)
 *   KAFKA_TOPIC_MIN_INSYNC_REPLICAS     min in-sync replicas (default: 1)
 *   KAFKA_TOPIC_RETENTION_MS            retention ms (default: 7d)
 *   KAFKA_TOPIC_COMPRESSION             codec (default: lz4)
 *   KAFKA_AUTH_ENABLED               "true" to activate SASL — see resolveKafkaAuth()
 */

import { Kafka, type ITopicConfig } from 'kafkajs';
import { resolveKafkaAuth } from '@agent-platform/config';

const PLATFORM_TOPICS = [
  // Session lifecycle
  'abl.session.created',
  'abl.session.ended',
  'abl.session.handoff',
  'abl.session.escalation',
  // Messages
  'abl.message.user',
  'abl.message.agent',
  // Tool calls
  'abl.tool.called',
  'abl.tool.completed',
  // Workflow
  'abl.workflow.execution',
  'abl.human.task',
  // Billing
  'abl.billing.usage.updated',
  // Audit
  'abl.audit.shared.v1',
  'abl.audit.kms.v1',
  'abl.audit.pii.v1',
  'abl.audit.connector.v1',
  'abl.audit.crawl.v1',
  'abl.audit.arch.v1',
  'abl.audit.omnichannel.v1',
];

interface CliFlags {
  status: boolean;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  return {
    status: argv.includes('--status'),
    dryRun: argv.includes('--dry-run'),
  };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" — must be a positive integer`);
  }
  return n;
}

function buildTopicConfigs(): ITopicConfig[] {
  const partitions = parseIntEnv('KAFKA_TOPIC_PARTITIONS', 3);
  const replicationFactor = parseIntEnv('KAFKA_TOPIC_REPLICATION_FACTOR', 1);
  const minInsyncReplicas = parseIntEnv('KAFKA_TOPIC_MIN_INSYNC_REPLICAS', 1);
  const retentionMs = process.env.KAFKA_TOPIC_RETENTION_MS ?? '604800000';
  const compression = process.env.KAFKA_TOPIC_COMPRESSION ?? 'lz4';

  return PLATFORM_TOPICS.map((topic) => ({
    topic,
    numPartitions: partitions,
    replicationFactor,
    configEntries: [
      { name: 'compression.type', value: compression },
      { name: 'retention.ms', value: retentionMs },
      { name: 'min.insync.replicas', value: String(minInsyncReplicas) },
    ],
  }));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const brokersRaw = process.env.EVENT_KAFKA_BROKERS;
  if (!brokersRaw) {
    throw new Error('EVENT_KAFKA_BROKERS is not set');
  }
  const brokers = brokersRaw
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0) {
    throw new Error('EVENT_KAFKA_BROKERS contains no valid broker addresses');
  }

  const auth = resolveKafkaAuth();
  const authMode = auth.sasl ? `SASL/${auth.sasl.mechanism}` : 'no-auth';
  console.log(`[seed-kafka] brokers=${brokers.join(',')} auth=${authMode}`);

  const kafka = new Kafka({
    clientId: 'seed-kafka',
    brokers,
    requestTimeout: 10_000,
    ...auth,
  });

  const admin = kafka.admin();
  await admin.connect();

  try {
    const existing = new Set(await admin.listTopics());

    if (flags.status) {
      console.log('[seed-kafka] existing topics:');
      for (const topic of [...existing].sort()) {
        const owned = PLATFORM_TOPICS.includes(topic) ? '✓' : ' ';
        console.log(`  ${owned} ${topic}`);
      }
      console.log('[seed-kafka] platform topics status:');
      for (const topic of PLATFORM_TOPICS) {
        console.log(`  ${existing.has(topic) ? '✓' : '✗'} ${topic}`);
      }
      return;
    }

    const desired = buildTopicConfigs();
    const missing = desired.filter((t) => !existing.has(t.topic));

    if (missing.length === 0) {
      console.log('[seed-kafka] all platform topics already exist — nothing to do');
      return;
    }

    if (flags.dryRun) {
      console.log(`[seed-kafka] dry-run: would create ${missing.length} topic(s):`);
      for (const t of missing) {
        console.log(
          `  + ${t.topic} (partitions=${t.numPartitions}, replication=${t.replicationFactor})`,
        );
      }
      return;
    }

    console.log(`[seed-kafka] creating ${missing.length} topic(s)...`);
    const created = await admin.createTopics({ topics: missing, waitForLeaders: true });
    if (!created) {
      console.log('[seed-kafka] createTopics returned false — topics likely already exist');
    } else {
      for (const t of missing) {
        console.log(`  + ${t.topic}`);
      }
      console.log(`[seed-kafka] done — created ${missing.length} topic(s)`);
    }
  } finally {
    await admin.disconnect();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[seed-kafka] failed: ${message}`);
  process.exit(1);
});
