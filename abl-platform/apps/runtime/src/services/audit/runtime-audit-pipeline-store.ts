import { createLogger } from '@abl/compiler/platform';
import type { AuditLog, Environment } from '@abl/compiler/platform/core/types';
import {
  createAuditEventFromAuditLog,
  type AuditEvent,
  type AuditEmitter,
  type AuditMaterializer,
  type AuditReader,
  type AuditTransportStatus,
} from '@abl/compiler/platform/stores/audit-pipeline.js';
import {
  AuditStore,
  type AlertConfig,
  type AuditStoreConfig,
  type AuditSummary,
  type QueryAuditParams,
} from '@abl/compiler/platform/stores/audit-store.js';

const log = createLogger('runtime-audit-pipeline-store');

export interface RuntimeAuditPipelineStoreOptions {
  emitter: AuditEmitter;
  reader: AuditReader;
  materializer?: AuditMaterializer;
}

export class RuntimeAuditPipelineStore extends AuditStore {
  constructor(
    config: AuditStoreConfig,
    private readonly options: RuntimeAuditPipelineStoreOptions,
    alertConfig?: AlertConfig,
  ) {
    super(config, alertConfig);
  }

  protected async append(auditLog: AuditLog): Promise<void> {
    try {
      this.options.emitter.emit(createAuditEventFromAuditLog(auditLog));
    } catch (err) {
      log.error('Failed to enqueue audit event into Kafka transport', {
        auditId: auditLog.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  emitAuditEvent(event: AuditEvent): void {
    this.options.emitter.emit(event);
  }

  async query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }> {
    return this.options.reader.query(params);
  }

  async getSummary(
    scope: string,
    environment: Environment,
    startTime: Date,
    endTime: Date,
  ): Promise<AuditSummary> {
    return this.options.reader.getSummary(scope, environment, startTime, endTime);
  }

  async getByTraceId(scope: string, traceId: string): Promise<AuditLog[]> {
    return this.options.reader.getByTraceId(scope, traceId);
  }

  getPipelineStatus(): AuditTransportStatus | null {
    return this.options.emitter.getStatus?.() ?? null;
  }

  override async close(): Promise<void> {
    const errors: string[] = [];

    try {
      await this.options.emitter.close();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      await this.options.materializer?.close();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    try {
      await this.options.reader.close();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    if (errors.length > 0) {
      throw new Error(`Runtime audit pipeline shutdown failed: ${errors.join('; ')}`);
    }
  }
}
