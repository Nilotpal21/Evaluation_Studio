import { shutdownAuditLogs } from '../repos/auth-repo.js';
import { shutdownPIIAuditLogger } from './execution/pii-audit-singleton.js';
import { peekSessionService } from './session/session-service.js';

interface BufferedPersistenceStore {
  flushPendingColdPersists(): Promise<void>;
}

function hasBufferedPersistenceFlush(store: unknown): store is BufferedPersistenceStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    'flushPendingColdPersists' in store &&
    typeof (store as { flushPendingColdPersists?: unknown }).flushPendingColdPersists === 'function'
  );
}

export async function flushBufferedPersistenceOnShutdown(): Promise<void> {
  await shutdownAuditLogs();
  await shutdownPIIAuditLogger();

  const sessionService = peekSessionService();
  if (!sessionService || !hasBufferedPersistenceFlush(sessionService.store)) {
    return;
  }

  await sessionService.store.flushPendingColdPersists();
}
