import type { RequestHandler } from 'express';
import type { ServiceChangeCompatibilityResult } from '@agent-platform/database';

export interface RuntimeReadinessDependencies {
  isShuttingDown(): boolean;
  getHeapUsedMb(): number;
  getHeapLimitMb(): number;
  isMongoReady(): Promise<boolean>;
  pingRedis(): Promise<void>;
  loadCompatibility(): Promise<ServiceChangeCompatibilityResult | null>;
  onHardFail?(result: ServiceChangeCompatibilityResult): void;
  /**
   * Optional gate for the workflow events consumer (ABLP-2). Returns true
   * when the consumer is running and its Kafka queues are reachable. Only
   * consulted when provided — callers skip this check entirely (by leaving
   * it unset) when `WORKFLOW_CH_SINK_ENABLED !== 'true'`.
   */
  isWorkflowConsumerHealthy?(): boolean | Promise<boolean>;
  /**
   * Optional gate for ClickHouse reachability from the runtime (ABLP-2).
   * Same opt-in semantics as `isWorkflowConsumerHealthy`.
   */
  isWorkflowClickHouseHealthy?(): boolean | Promise<boolean>;
}

function buildCompatibilityPayload(result: ServiceChangeCompatibilityResult) {
  return {
    service: result.service,
    environment: result.environment,
    enforcementMode: result.enforcementMode,
    outcome: result.outcome,
    shouldExit: result.shouldExit,
    blockers: result.blockingIssues,
    warnings: result.warningIssues,
  };
}

export function createRuntimeReadinessHandler(
  dependencies: RuntimeReadinessDependencies,
): RequestHandler {
  return async (_req, res) => {
    if (dependencies.isShuttingDown()) {
      return res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
    }

    const heapUsedMB = dependencies.getHeapUsedMb();
    const heapLimitMB = dependencies.getHeapLimitMb();
    if (heapUsedMB > heapLimitMB) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'memory_pressure',
        heapUsedMB: Math.round(heapUsedMB),
        heapLimitMB,
      });
    }

    const mongoReady = await dependencies.isMongoReady();
    if (!mongoReady) {
      return res.status(503).json({ status: 'not_ready', reason: 'mongodb_unavailable' });
    }

    try {
      await dependencies.pingRedis();
    } catch {
      return res.status(503).json({ status: 'not_ready', reason: 'redis_unavailable' });
    }

    if (dependencies.isWorkflowConsumerHealthy) {
      let consumerHealthy = false;
      try {
        consumerHealthy = await dependencies.isWorkflowConsumerHealthy();
      } catch {
        consumerHealthy = false;
      }
      if (!consumerHealthy) {
        return res
          .status(503)
          .json({ status: 'not_ready', reason: 'workflow_consumer_not_healthy' });
      }
    }

    if (dependencies.isWorkflowClickHouseHealthy) {
      let chHealthy = false;
      try {
        chHealthy = await dependencies.isWorkflowClickHouseHealthy();
      } catch {
        chHealthy = false;
      }
      if (!chHealthy) {
        return res
          .status(503)
          .json({ status: 'not_ready', reason: 'workflow_clickhouse_not_healthy' });
      }
    }

    let compatibility: ServiceChangeCompatibilityResult | null = null;
    try {
      compatibility = await dependencies.loadCompatibility();
    } catch {
      return res.status(503).json({ status: 'not_ready', reason: 'change_gate_unavailable' });
    }

    if (compatibility && !compatibility.ready) {
      if (compatibility.shouldExit) {
        dependencies.onHardFail?.(compatibility);
      }

      return res.status(503).json({
        status: 'not_ready',
        reason: 'change_incompatible',
        changeManagement: buildCompatibilityPayload(compatibility),
      });
    }

    const responseBody: {
      status: 'ready';
      changeManagement?: ReturnType<typeof buildCompatibilityPayload>;
    } = { status: 'ready' };

    if (
      compatibility &&
      (compatibility.warningIssues.length > 0 || compatibility.outcome !== 'ready')
    ) {
      responseBody.changeManagement = buildCompatibilityPayload(compatibility);
    }

    return res.json(responseBody);
  };
}
