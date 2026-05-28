import type {
  AuditEmitter,
  AuditEvent,
  AuditTransportStatus,
  AuditTransport,
} from '@abl/compiler/platform/stores/audit-pipeline.js';

export class TransportBackedAuditEmitter implements AuditEmitter {
  constructor(private readonly transport: AuditTransport) {}

  emit(event: AuditEvent): void {
    this.transport.publish(event);
  }

  emitBatch(events: AuditEvent[]): void {
    this.transport.publishBatch(events);
  }

  async flush(): Promise<void> {
    await this.transport.flush();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  getStatus(): AuditTransportStatus {
    return this.transport.getStatus();
  }
}
