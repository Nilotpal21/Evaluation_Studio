import { createLogger } from '@abl/compiler/platform';
import { randomUUID } from 'crypto';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import { EvalRun, Tenant } from '@agent-platform/database/models';
import { resolveClickHouseDatabaseName } from '@agent-platform/database/clickhouse-schemas/database';
import {
  normalizeEvalKnownSource,
  resolveEvalConversationTtlDays,
  resolveEvalRetentionContract,
  type TenantSettingsWithEvalRetention,
} from '@agent-platform/database';

const log = createLogger('eval-retention-cleanup');
const RETAINED_ARCHIVE_FIELDS = ['summary', 'status', 'archivedAt', 'archivedReason'] as const;

type EvalRetentionCleanupTraceEventType =
  | 'eval.retention.cleanup_started'
  | 'eval.retention.run_archived'
  | 'eval.retention.run_hard_deleted'
  | 'eval.retention.cleanup_error'
  | 'eval.retention.cleanup_complete';

export interface EvalRetentionCleanupTraceEvent {
  type: EvalRetentionCleanupTraceEventType;
  timestamp: Date;
  durationMs?: number;
  data: Record<string, unknown>;
}

export interface EvalRetentionTraceSink {
  appendEvent(traceId: string, event: EvalRetentionCleanupTraceEvent): void | Promise<void>;
}

interface ClickHouseInsertClient {
  insert(params: {
    table: string;
    values: Record<string, unknown>[];
    format: 'JSONEachRow';
  }): Promise<unknown>;
}

export interface EvalRetentionCleanupOptions {
  traceSink?: EvalRetentionTraceSink | null;
}

let configuredTraceSink: EvalRetentionTraceSink | null = null;

export interface EvalRetentionCleanupSummary {
  tenantsScanned: number;
  runsArchived: number;
  runsDeleted: number;
  errors: string[];
}

interface TenantRetentionRow {
  _id: string;
  settings?: TenantSettingsWithEvalRetention | null;
}

interface ExpiredEvalRunRow {
  _id: string;
}

function expirationCutoff(now: Date, ttlDays: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - ttlDays);
  return cutoff;
}

export function setEvalRetentionTraceSink(traceSink: EvalRetentionTraceSink | null): void {
  configuredTraceSink = traceSink;
}

export function createEvalRetentionClickHouseTraceSink(
  client: ClickHouseInsertClient,
  options?: { database?: string },
): EvalRetentionTraceSink {
  const database = resolveClickHouseDatabaseName(options?.database);

  return {
    async appendEvent(traceId, event) {
      const tenantId = typeof event.data.tenantId === 'string' ? event.data.tenantId : '';
      const errorMessage =
        typeof event.data.errorMessage === 'string' ? event.data.errorMessage : '';
      const errorType = typeof event.data.errorCode === 'string' ? event.data.errorCode : '';

      await client.insert({
        table: `${database}.platform_events`,
        values: [
          {
            tenant_id: tenantId,
            project_id: '',
            event_id: randomUUID(),
            event_type: event.type,
            category: 'eval',
            timestamp: toClickHouseDateTime(event.timestamp),
            session_id: '',
            trace_id: traceId,
            span_id: '',
            parent_span_id: '',
            agent_name: 'eval-retention-cleanup',
            deployment_id: '',
            known_source: 'eval',
            channel: 'pipeline-engine',
            actor_id: 'system:eval-retention-cleanup',
            actor_type: 'system',
            duration_ms: event.durationMs ?? 0,
            has_error: event.type === 'eval.retention.cleanup_error' ? 1 : 0,
            error_message: errorMessage,
            error_type: errorType,
            data: JSON.stringify(event.data),
            metadata: JSON.stringify({ source: 'eval-retention-cleanup' }),
            custom_dimensions: {
              component: 'eval-retention-cleanup',
              tenant_id: tenantId,
            },
            _enc: '',
          },
        ],
        format: 'JSONEachRow',
      });
    },
  };
}

async function emitCleanupTraceEvent(
  traceSink: EvalRetentionTraceSink | null | undefined,
  traceId: string,
  event: EvalRetentionCleanupTraceEvent,
): Promise<void> {
  if (!traceSink) {
    return;
  }

  try {
    await traceSink.appendEvent(traceId, event);
  } catch (error) {
    log.warn('Eval retention trace event persistence failed', {
      traceId,
      eventType: event.type,
      tenantId: event.data.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildTenantTraceId(tenantId: string, now: Date): string {
  return `eval-retention:${tenantId}:${now.toISOString()}`;
}

function cleanupErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'EVAL_RETENTION_CLEANUP_ERROR';
}

export async function runEvalRetentionCleanup(
  now: Date = new Date(),
  options: EvalRetentionCleanupOptions = {},
) {
  const summary: EvalRetentionCleanupSummary = {
    tenantsScanned: 0,
    runsArchived: 0,
    runsDeleted: 0,
    errors: [],
  };

  const tenants = (await Tenant.find({ status: { $ne: 'archived' } })
    .select('_id settings')
    .lean()) as TenantRetentionRow[];

  for (const tenant of tenants) {
    summary.tenantsScanned++;
    const tenantId = String(tenant._id);
    const traceId = buildTenantTraceId(tenantId, now);
    const traceSink = options.traceSink ?? configuredTraceSink;
    const tenantStartMs = Date.now();
    let archivedCount = 0;
    let hardDeletedCount = 0;
    let errorCount = 0;

    try {
      const contract = resolveEvalRetentionContract(tenant.settings ?? null);
      const evalTtlDays = resolveEvalConversationTtlDays(
        contract,
        normalizeEvalKnownSource('eval'),
      );
      const syntheticTtlDays = resolveEvalConversationTtlDays(
        contract,
        normalizeEvalKnownSource('synthetic'),
      );
      const evalCutoff = expirationCutoff(now, evalTtlDays);
      const syntheticCutoff = expirationCutoff(now, syntheticTtlDays);

      const expiredFilter = {
        tenantId,
        archived: { $ne: true },
        status: { $in: ['completed', 'failed', 'cancelled'] },
        $or: [
          { knownSource: 'synthetic', createdAt: { $lt: syntheticCutoff } },
          { knownSource: { $ne: 'synthetic' }, createdAt: { $lt: evalCutoff } },
        ],
      };

      const expiredRuns = (await EvalRun.find(expiredFilter)
        .select('_id')
        .sort({ createdAt: 1, _id: 1 })
        .lean()) as ExpiredEvalRunRow[];

      await emitCleanupTraceEvent(traceSink, traceId, {
        type: 'eval.retention.cleanup_started',
        timestamp: new Date(),
        data: {
          tenantId,
          runsScannedTarget: expiredRuns.length,
          ttlThresholds: {
            evalTtlDays,
            syntheticTtlDays,
            evalCutoff: evalCutoff.toISOString(),
            syntheticCutoff: syntheticCutoff.toISOString(),
            hardDeleteExpiredRuns: contract.hardDeleteExpiredRuns,
          },
        },
      });

      for (const run of expiredRuns) {
        const runId = String(run._id);
        try {
          if (contract.hardDeleteExpiredRuns) {
            const result = await EvalRun.deleteOne({ _id: runId, tenantId });
            if ((result.deletedCount ?? 0) > 0) {
              hardDeletedCount++;
              summary.runsDeleted++;
              await emitCleanupTraceEvent(traceSink, traceId, {
                type: 'eval.retention.run_hard_deleted',
                timestamp: new Date(),
                data: {
                  tenantId,
                  runId,
                  deletedAt: now.toISOString(),
                },
              });
            }
            continue;
          }

          const result = await EvalRun.updateOne(
            { _id: runId, tenantId },
            {
              $set: {
                archived: true,
                archivedAt: now,
                archivedReason: 'retention_expired',
              },
              $unset: {
                regressionDetails: 1,
                baselineRunId: 1,
                preflightResult: 1,
              },
            },
          );

          if ((result.modifiedCount ?? 0) > 0) {
            archivedCount++;
            summary.runsArchived++;
            await emitCleanupTraceEvent(traceSink, traceId, {
              type: 'eval.retention.run_archived',
              timestamp: new Date(),
              data: {
                tenantId,
                runId,
                archivedAt: now.toISOString(),
                archivedReason: 'retention_expired',
                retainedFields: [...RETAINED_ARCHIVE_FIELDS],
              },
            });
          }
        } catch (error) {
          errorCount++;
          const message = error instanceof Error ? error.message : String(error);
          summary.errors.push(`${tenantId}/${runId}: ${message}`);
          log.warn('Eval retention cleanup failed for run', { tenantId, runId, error: message });
          await emitCleanupTraceEvent(traceSink, traceId, {
            type: 'eval.retention.cleanup_error',
            timestamp: new Date(),
            data: {
              tenantId,
              runId,
              errorCode: cleanupErrorCode(error),
              errorMessage: message,
            },
          });
        }
      }
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`${tenantId}: ${message}`);
      log.warn('Eval retention cleanup failed for tenant', { tenantId, error: message });
      await emitCleanupTraceEvent(traceSink, traceId, {
        type: 'eval.retention.cleanup_error',
        timestamp: new Date(),
        data: {
          tenantId,
          errorCode: cleanupErrorCode(error),
          errorMessage: message,
        },
      });
    } finally {
      await emitCleanupTraceEvent(traceSink, traceId, {
        type: 'eval.retention.cleanup_complete',
        timestamp: new Date(),
        durationMs: Date.now() - tenantStartMs,
        data: {
          tenantId,
          archivedCount,
          hardDeletedCount,
          errorCount,
          durationMs: Date.now() - tenantStartMs,
        },
      });
    }
  }

  return summary;
}
