/**
 * Graceful Shutdown Handler
 *
 * Registers SIGTERM/SIGINT handlers that pause workers, wait for
 * active jobs to drain, then close all transfer event components.
 */
import { createLogger } from '@abl/compiler/platform';
import type { AgentDesktopAdapter } from '../adapters/interface.js';
import type { DurableEventQueue } from './durable-event-queue.js';
import type { EventWorker } from './event-worker.js';
import type { SdkNotificationQueue } from './sdk-notification-queue.js';
import type { SessionTimeoutScheduler } from './session-timeout-scheduler.js';

const log = createLogger('transfer-shutdown');

const DRAIN_TIMEOUT_MS = 5_000;

export interface ShutdownComponents {
  eventQueue?: DurableEventQueue;
  eventWorker?: EventWorker;
  sdkQueue?: SdkNotificationQueue;
  timeoutScheduler?: SessionTimeoutScheduler;
  adapters?: AgentDesktopAdapter[];
}

/**
 * Register SIGTERM and SIGINT handlers that gracefully drain
 * all transfer-related BullMQ components before shutting down.
 *
 * Returns an unregister function that removes the signal listeners.
 */
export function registerTransferShutdownHandlers(components: ShutdownComponents): () => void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Graceful shutdown initiated', { signal });

    const closeWithTimeout = async (name: string, closeFn: () => Promise<void>): Promise<void> => {
      try {
        await Promise.race([
          closeFn(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`${name} drain timed out`)), DRAIN_TIMEOUT_MS),
          ),
        ]);
        log.info(`${name} closed`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`${name} close failed`, { error: message });
      }
    };

    // 1. Pause event workers first (stop accepting new work)
    if (components.eventWorker) {
      await closeWithTimeout('EventWorker', () => components.eventWorker!.close());
    }

    // 2. Close adapters (drains HTTP connection pools)
    if (components.adapters) {
      for (const adapter of components.adapters) {
        if (adapter.close) {
          await closeWithTimeout(`Adapter[${adapter.name}]`, () => adapter.close!());
        }
      }
    }

    // 3. Close queues
    if (components.eventQueue) {
      await closeWithTimeout('DurableEventQueue', () => components.eventQueue!.close());
    }
    if (components.sdkQueue) {
      await closeWithTimeout('SdkNotificationQueue', () => components.sdkQueue!.close());
    }
    if (components.timeoutScheduler) {
      await closeWithTimeout('SessionTimeoutScheduler', () => components.timeoutScheduler!.close());
    }

    log.info('All transfer components shut down');
  };

  const onSigterm = (): void => {
    void shutdown('SIGTERM');
  };
  const onSigint = (): void => {
    void shutdown('SIGINT');
  };

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return () => {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  };
}
