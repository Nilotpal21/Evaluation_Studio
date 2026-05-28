/**
 * Lightweight Kafka admin wrapper for runtime `/diagnose`. Beyond topic
 * existence + partition count (same as workflow-engine), this also
 * describes the consumer groups runtime owns and reports per-member
 * partition assignment — lets operators see whether a pod has actually
 * joined the group and owns partitions, not just "the process is up".
 */

import { Kafka, type Admin, AssignerProtocol } from 'kafkajs';
import { createLogger } from '@abl/compiler/platform';
import { resolveKafkaAuth } from '@agent-platform/config';
import { classifyProbeError } from './error-classifier.js';

const log = createLogger('runtime:diagnose:kafka');

export interface RuntimeKafkaDiagnosticsInput {
  brokers: string[];
  topicsToCheck: string[];
  groupsToCheck: string[];
  timeoutMs?: number;
}

export interface RuntimeKafkaDiagnosticsResult {
  ok: boolean;
  brokers: string[];
  latencyMs: number;
  topics: Record<string, { exists: boolean; partitionCount?: number }>;
  consumerGroups: Record<string, ConsumerGroupInfo>;
  error?: string;
}

export interface ConsumerGroupInfo {
  state: string;
  protocol?: string;
  members: Array<{
    memberId: string;
    clientId: string;
    host?: string;
    assignments: Array<{ topic: string; partitions: number[] }>;
  }>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function probeKafkaFromConsumer(
  input: RuntimeKafkaDiagnosticsInput,
): Promise<RuntimeKafkaDiagnosticsResult> {
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

    // Topic metadata — same approach as workflow-engine diagnostics.
    const listed = await withTimeout(admin.listTopics(), timeoutMs, 'kafka.admin.listTopics');
    const topicsPresent = input.topicsToCheck.filter((name) => listed.includes(name));
    const topics: Record<string, { exists: boolean; partitionCount?: number }> = Object.fromEntries(
      input.topicsToCheck.map((name) => [name, { exists: false }]),
    );
    for (const name of topicsPresent) {
      topics[name] = { exists: true };
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

    // Consumer group describe — reports state + per-member assignments.
    // An empty `members` list means no runtime pod has joined the group —
    // the sink is wired but idle.
    const groupDescriptions = await withTimeout(
      admin.describeGroups(input.groupsToCheck),
      timeoutMs,
      'kafka.admin.describeGroups',
    );
    const consumerGroups: Record<string, ConsumerGroupInfo> = {};
    for (const group of groupDescriptions.groups) {
      consumerGroups[group.groupId] = {
        state: group.state,
        protocol: group.protocol,
        members: group.members.map((m) => ({
          memberId: m.memberId,
          clientId: m.clientId,
          host: m.clientHost,
          assignments: parseAssignments(m.memberAssignment),
        })),
      };
    }

    return {
      ok: true,
      brokers: input.brokers,
      latencyMs: Math.round(performance.now() - start),
      topics,
      consumerGroups,
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
      consumerGroups: Object.fromEntries(
        input.groupsToCheck.map((id) => [id, { state: 'unknown', members: [] }]),
      ),
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

/**
 * Decode a consumer's `memberAssignment` buffer via kafkajs's official
 * serializer. A nullable decode (malformed buffer) or a throw (unknown
 * format) returns an empty list — assignments are informational only,
 * so a failure here must not fail the whole probe.
 */
function parseAssignments(buf: Buffer): Array<{ topic: string; partitions: number[] }> {
  if (!buf || buf.length === 0) return [];
  try {
    const decoded = AssignerProtocol.MemberAssignment.decode(buf);
    if (!decoded) return [];
    return Object.entries(decoded.assignment).map(([topic, partitions]) => ({ topic, partitions }));
  } catch (err) {
    log.debug('diagnose.kafka_member_assignment_decode_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
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
