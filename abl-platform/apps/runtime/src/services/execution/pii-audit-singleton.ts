/**
 * Singleton PIIAuditLogger for the runtime
 *
 * Lazily instantiated on first access. Uses RuntimePIIAuditStore
 * to emit Kafka -> ClickHouse PII audit events.
 */
import { PIIAuditLogger } from '@abl/compiler/platform/security/pii-audit.js';
import { getAuditStore } from './pii-audit-store-adapter.js';

let logger: PIIAuditLogger | undefined;

export function getPIIAuditLogger(): PIIAuditLogger {
  if (!logger) {
    logger = new PIIAuditLogger(getAuditStore());
  }
  return logger;
}

export async function shutdownPIIAuditLogger(): Promise<void> {
  if (!logger) {
    return;
  }

  const currentLogger = logger;
  logger = undefined;
  await currentLogger.stop();
}

/** For testing — reset the singleton */
export function resetPIIAuditLogger(): void {
  if (logger) {
    void logger.stop();
    logger = undefined;
  }
}
