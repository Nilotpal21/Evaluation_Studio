/**
 * SyncExecutionService
 *
 * Enables synchronous workflow execution via Redis Pub/Sub.
 * Subscribes to a per-execution channel before returning, waits for
 * a terminal event (completed / failed / cancelled), then fetches
 * the result from MongoDB. On timeout, returns { status: 'timeout' }
 * so the caller can gracefully degrade to async polling.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('sync-execution');

// ─── Types ─────────────────────────────────────────────────────────

export interface SyncExecutionDeps {
  /** Dedicated ioredis client for Pub/Sub (via createSubscriber(handle); cluster-aware). */
  redisSubscriber: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface SyncExecutionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ─── Service ───────────────────────────────────────────────────────

export class SyncExecutionService {
  private activeSubscriptions = 0;
  private readonly maxConcurrent: number;

  constructor(
    private readonly deps: SyncExecutionDeps,
    maxConcurrent = 100,
  ) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Number of in-flight Pub/Sub subscriptions. */
  get activeCount(): number {
    return this.activeSubscriptions;
  }

  /**
   * Wait for a workflow execution to complete via Redis Pub/Sub.
   *
   * Subscribes to `workflow:{tenantId}:execution:{executionId}:status`
   * BEFORE returning.  Filters for terminal events:
   *   workflow.completed, workflow.failed, workflow.cancelled.
   *
   * On timeout → returns `{ status: 'timeout' }`.
   * On terminal event → fetches result from MongoDB and returns it.
   */
  async waitForCompletion(
    tenantId: string,
    executionId: string,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<SyncExecutionResult> {
    if (this.activeSubscriptions >= this.maxConcurrent) {
      throw new Error('SYNC_LIMIT_EXCEEDED');
    }

    this.activeSubscriptions++;
    let decremented = false;
    const channel = `workflow:${tenantId}:execution:${executionId}:status`;

    try {
      return await new Promise<SyncExecutionResult>((resolve) => {
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          if (!decremented) {
            decremented = true;
            this.activeSubscriptions--;
          }
          this.deps.redisSubscriber.unsubscribe(channel).catch((err: unknown) => {
            log.warn('Failed to unsubscribe from channel', {
              error: err instanceof Error ? err.message : String(err),
              channel,
            });
          });
          clearTimeout(timer);
        };

        // ── Timeout handler ──────────────────────────────────────
        const timer = setTimeout(() => {
          if (!settled) {
            log.info('Sync execution timed out', {
              executionId,
              tenantId,
              timeoutMs,
            });
            cleanup();
            resolve({ status: 'timeout' });
          }
        }, timeoutMs);

        // ── Client disconnect handler ────────────────────────────
        if (abortSignal) {
          abortSignal.addEventListener(
            'abort',
            () => {
              if (!settled) {
                log.info('Client disconnected, cleaning up subscription', {
                  executionId,
                });
                cleanup();
                resolve({ status: 'timeout' });
              }
            },
            { once: true },
          );
        }

        // ── Message handler — filters for terminal events ────────
        const messageHandler = async (subscribedChannel: string, message: string) => {
          if (subscribedChannel !== channel || settled) return;

          try {
            const event = JSON.parse(message);
            const terminalTypes = ['workflow.completed', 'workflow.failed', 'workflow.cancelled'];
            if (!terminalTypes.includes(event.type)) return;

            log.info('Received terminal event', {
              executionId,
              type: event.type,
            });
            cleanup();
            this.deps.redisSubscriber.removeListener('message', messageHandler);

            // Pub/Sub event is notification-only — fetch from MongoDB
            const result = await this.fetchExecutionResult(tenantId, executionId);
            resolve(result);
          } catch (err) {
            log.error('Error processing Pub/Sub message', {
              error: err instanceof Error ? err.message : String(err),
              executionId,
            });
          }
        };

        this.deps.redisSubscriber.on('message', messageHandler);

        this.deps.redisSubscriber.subscribe(channel).catch((err: unknown) => {
          log.error('Failed to subscribe to channel', {
            error: err instanceof Error ? err.message : String(err),
            channel,
          });
          cleanup();
          this.deps.redisSubscriber.removeListener('message', messageHandler);
          resolve({ status: 'timeout' });
        });
      });
    } catch (err) {
      // Safety: only decrement if cleanup() didn't already handle it
      if (!decremented) {
        decremented = true;
        this.activeSubscriptions = Math.max(0, this.activeSubscriptions - 1);
      }
      throw err;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────

  /**
   * Fetch execution result from MongoDB.
   * Dynamic import avoids circular deps at module load time.
   */
  private async fetchExecutionResult(
    tenantId: string,
    executionId: string,
  ): Promise<SyncExecutionResult> {
    const { WorkflowExecution } = await import('@agent-platform/database/models');

    const execution = await WorkflowExecution.findOne({
      _id: executionId,
      tenantId,
    }).lean();

    if (!execution) {
      return {
        status: 'failed',
        error: {
          code: 'EXECUTION_NOT_FOUND',
          message: 'Execution record not found',
        },
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = execution as any;

    if (doc.status === 'completed') {
      return {
        status: 'completed',
        result: doc.output ?? doc.context ?? {},
      };
    }

    if (doc.status === 'failed') {
      return {
        status: 'failed',
        error: doc.error ?? {
          code: 'EXECUTION_FAILED',
          message: 'Workflow failed',
        },
      };
    }

    if (doc.status === 'cancelled') {
      return {
        status: 'cancelled',
        error: {
          code: 'EXECUTION_CANCELLED',
          message: 'Workflow was cancelled',
        },
      };
    }

    // Still running — shouldn't happen after terminal event, handle gracefully
    return { status: 'timeout' };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Graceful shutdown — unsubscribe all channels and quit the
   * subscriber connection.
   */
  async shutdown(): Promise<void> {
    try {
      await this.deps.redisSubscriber.unsubscribe();
      await this.deps.redisSubscriber.quit();
      log.info('SyncExecutionService shut down');
    } catch (err) {
      log.error('Error during SyncExecutionService shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
