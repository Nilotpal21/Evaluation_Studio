/**
 * Workflow-engine `/diagnose` handler. Reports feature-flag snapshot +
 * dependency reachability + pipeline wiring state. Deliberately accepts
 * every probe as an injected function so unit tests can exercise the
 * full branching matrix without touching real Mongo / Redis / Kafka /
 * ClickHouse. See __tests__/diagnose-handler.test.ts.
 */

import type { RequestHandler } from 'express';
import { snapshotFlags, WORKFLOW_ENGINE_FLAGS, type FlagSnapshot } from './flag-catalog.js';
import type { KafkaDiagnosticsResult } from './kafka-diagnostics.js';

export interface DiagnoseAuditLogger {
  info(event: string, fields: Record<string, unknown>): void;
}

export interface ProbeOutcome {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface WorkflowEngineDiagnoseDeps {
  getServiceBuildInfo(): unknown;
  probeMongo(): Promise<ProbeOutcome>;
  probeRedis(): Promise<ProbeOutcome>;
  /** Optional — returns null when ClickHouse is not configured or dual-read is off. */
  probeClickHouse(): Promise<ProbeOutcome | null>;
  /** Optional — returns null when Kafka/outbox is off. */
  probeKafka(): Promise<KafkaDiagnosticsResult | null>;
  /** Pipeline wiring signal — reflects the module-level state in index.ts. */
  getOutboxPollerState(): OutboxPollerState;
  env?: NodeJS.ProcessEnv;
  /** Optional audit logger — emits one `info` event per invocation. */
  auditLogger?: DiagnoseAuditLogger;
}

export interface OutboxPollerState {
  /** True when `poller.start()` succeeded and shutdown has not begun. */
  running: boolean;
  /** The configured poll interval in ms. Null when the poller isn't wired. */
  pollIntervalMs: number | null;
  /** Current count of outbox rows with `publishedAt=null`. Null if unknown. */
  unpublishedRows: number | null;
}

export interface DiagnoseResponseBody {
  service: 'workflow-engine';
  build: unknown;
  flags: FlagSnapshot[];
  dependencies: {
    mongodb: ProbeOutcome;
    redis: ProbeOutcome;
    clickhouse?: ProbeOutcome;
    kafka?: KafkaDiagnosticsResult;
  };
  pipeline: {
    outboxPoller: OutboxPollerState;
    kafkaTopics?: KafkaDiagnosticsResult['topics'];
  };
}

export function createDiagnoseHandler(deps: WorkflowEngineDiagnoseDeps): RequestHandler {
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

    const body: DiagnoseResponseBody = {
      service: 'workflow-engine',
      build: deps.getServiceBuildInfo(),
      flags: snapshotFlags(WORKFLOW_ENGINE_FLAGS, env),
      dependencies: {
        mongodb: mongo,
        redis,
        ...(clickhouse ? { clickhouse } : {}),
        ...(kafka ? { kafka } : {}),
      },
      pipeline: {
        outboxPoller: deps.getOutboxPollerState(),
        ...(kafka ? { kafkaTopics: kafka.topics } : {}),
      },
    };

    res.status(200).json(body);
  };
}
