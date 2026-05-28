import { createLogger } from '@abl/compiler/platform';
import type {
  AuditEvent,
  AuditMaterializer,
  AuditSink,
} from '@abl/compiler/platform/stores/audit-pipeline.js';

const log = createLogger('runtime-audit-materializer');

export class RuntimeAuditMaterializer implements AuditMaterializer {
  constructor(private readonly sink: AuditSink) {}

  async handle(event: AuditEvent): Promise<void> {
    await this.sink.write(event);
  }

  async handleBatch(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.sink.writeBatch(events);
    log.debug('Materialized runtime audit batch', { eventCount: events.length });
  }

  async flush(): Promise<void> {
    await this.sink.flush();
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}
