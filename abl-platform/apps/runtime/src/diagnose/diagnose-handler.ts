/**
 * Runtime `/diagnose` handler. Mirrors workflow-engine shape but reports
 * the consumer-side pipeline: Kafka broker + consumer groups + topic
 * assignments, plus ClickHouse sink reachability. All probes are
 * injected so tests can cover every branch without mocking internal
 * packages.
 */

import type { RequestHandler } from 'express';
import { snapshotFlags, RUNTIME_FLAGS, type FlagSnapshot } from './flag-catalog.js';
import type { RuntimeKafkaDiagnosticsResult } from './kafka-diagnostics.js';

export interface DiagnoseAuditLogger {
  info(event: string, fields: Record<string, unknown>): void;
}

export interface ProbeOutcome {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface WorkflowEventsConsumerState {
  /** True when `start()` has been called on the consumer. */
  running: boolean;
  topics: string[];
  groupIds: string[];
}

export interface RuntimeDiagnoseDeps {
  getServiceBuildInfo(): unknown;
  probeMongo(): Promise<ProbeOutcome>;
  probeRedis(): Promise<ProbeOutcome>;
  probeClickHouse(): Promise<ProbeOutcome | null>;
  probeKafka(): Promise<RuntimeKafkaDiagnosticsResult | null>;
  /** Null when the workflow events consumer is not wired. */
  getConsumerState(): WorkflowEventsConsumerState | null;
  env?: NodeJS.ProcessEnv;
  /** Optional audit logger — emits one `info` event per invocation. */
  auditLogger?: DiagnoseAuditLogger;
}

export interface RuntimeDiagnoseResponseBody {
  service: 'runtime';
  build: unknown;
  flags: FlagSnapshot[];
  dependencies: {
    mongodb: ProbeOutcome;
    redis: ProbeOutcome;
    clickhouse?: ProbeOutcome;
    kafka?: RuntimeKafkaDiagnosticsResult;
  };
  pipeline: {
    workflowEventsConsumer: WorkflowEventsConsumerState | null;
    kafkaTopics?: RuntimeKafkaDiagnosticsResult['topics'];
    consumerGroups?: RuntimeKafkaDiagnosticsResult['consumerGroups'];
  };
}

export function createRuntimeDiagnoseHandler(deps: RuntimeDiagnoseDeps): RequestHandler {
  return async (req, res) => {
    const env = deps.env ?? process.env;

    if (deps.auditLogger) {
      deps.auditLogger.info('diagnose.invoked', {
        ip:
          req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
          req.header('x-real-ip') ||
          req.socket.remoteAddress ||
          'unknown',
        userAgent: req.header('user-agent') ?? '',
        requestId: req.header('x-request-id') ?? '',
      });
    }

    const [mongo, redis, clickhouse, kafka] = await Promise.all([
      deps.probeMongo(),
      deps.probeRedis(),
      deps.probeClickHouse(),
      deps.probeKafka(),
    ]);

    const body: RuntimeDiagnoseResponseBody = {
      service: 'runtime',
      build: deps.getServiceBuildInfo(),
      flags: snapshotFlags(RUNTIME_FLAGS, env),
      dependencies: {
        mongodb: mongo,
        redis,
        ...(clickhouse ? { clickhouse } : {}),
        ...(kafka ? { kafka } : {}),
      },
      pipeline: {
        workflowEventsConsumer: deps.getConsumerState(),
        ...(kafka ? { kafkaTopics: kafka.topics } : {}),
        ...(kafka ? { consumerGroups: kafka.consumerGroups } : {}),
      },
    };

    res.status(200).json(body);
  };
}
