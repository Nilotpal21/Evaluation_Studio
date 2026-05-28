/**
 * Lightweight Kafka admin wrapper used by `/diagnose`. Keeps kafkajs
 * imported lazily so services with Kafka off (dev, non-event-sourcing
 * branches) don't pay module-load cost. A single call uses one admin
 * client and disconnects it afterward — never reused across requests.
 */

import { Kafka, type Admin } from 'kafkajs';
import { createLogger } from '@abl/compiler/platform';
import { resolveKafkaAuth } from '@agent-platform/config';
import { classifyProbeError } from './error-classifier.js';

const log = createLogger('workflow-engine:diagnose:kafka');

export interface KafkaDiagnosticsInput {
  brokers: string[];
  topicsToCheck: string[];
  timeoutMs?: number;
}

export interface KafkaDiagnosticsResult {
  ok: boolean;
  brokers: string[];
  latencyMs: number;
  topics: Record<string, KafkaTopicInfo>;
  error?: string;
}

export interface KafkaTopicInfo {
  exists: boolean;
  partitionCount?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Connect an admin client, fetch metadata for the requested topics, and
 * disconnect. A topic that does not exist is reported as `exists: false`
 * with no partition count — kafkajs throws `UNKNOWN_TOPIC_OR_PARTITION`
 * when asked to describe a missing topic, so we fetch all topics via
 * `listTopics()` first and only describe the ones that are present.
 */
export async function probeKafkaFromProducer(
  input: KafkaDiagnosticsInput,
): Promise<KafkaDiagnosticsResult> {
  const start = performance.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const kafka = new Kafka({
    clientId: 'diagnose-admin',
    brokers: input.brokers,
    requestTimeout: timeoutMs,
    ...resolveKafkaAuth(),
  });
  let admin: Admin | undefined;
  try {
    admin = kafka.admin();
    await withTimeout(admin.connect(), timeoutMs, 'kafka.admin.connect');

    const listed = await withTimeout(admin.listTopics(), timeoutMs, 'kafka.admin.listTopics');
    const topicsPresent = input.topicsToCheck.filter((name) => listed.includes(name));

    const topics: Record<string, KafkaTopicInfo> = {};
    for (const name of input.topicsToCheck) {
      topics[name] = { exists: listed.includes(name) };
    }

    if (topicsPresent.length > 0) {
      const metadata = await withTimeout(
        admin.fetchTopicMetadata({ topics: topicsPresent }),
        timeoutMs,
        'kafka.admin.fetchTopicMetadata',
      );
      for (const t of metadata.topics) {
        topics[t.name] = { exists: true, partitionCount: t.partitions.length };
      }
    }

    return {
      ok: true,
      brokers: input.brokers,
      latencyMs: Math.round(performance.now() - start),
      topics,
    };
  } catch (err) {
    // Raw error is logged here so operators can correlate via request-id /
    // timestamp; the `/diagnose` response body surfaces only the sanitized
    // classifier so provider-specific credential or hostname hints don't
    // leak even to callers on the internal network.
    log.warn('diagnose.kafka_probe_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      brokers: input.brokers,
      latencyMs: Math.round(performance.now() - start),
      topics: Object.fromEntries(input.topicsToCheck.map((name) => [name, { exists: false }])),
      error: classifyProbeError(err),
    };
  } finally {
    if (admin) {
      try {
        await admin.disconnect();
      } catch (disconnectErr) {
        log.debug('diagnose.kafka_admin_disconnect_failed', {
          error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        });
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}
