/**
 * Hybrid Cancellation Checker
 *
 * Checks for cancellation/pause signals using both Redis pub/sub (fast) and DB polling (reliable fallback).
 * - Redis signal: <5s latency when available
 * - DB fallback: 30s polling interval when Redis unavailable
 *
 * Note: Uses isPaused flag for both pause and stop functionality.
 */
import type { Model } from 'mongoose';
import type { IConnectorConfig } from '@agent-platform/database';

/**
 * Subscriber client interface — structural subset compatible with
 * RedisClient (Redis | Cluster) from @agent-platform/redis.
 * Kept as a structural type to avoid coupling connectors-base to the redis package.
 */
export type RedisSubscriberClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ioredis subscribe overloads
  subscribe(...args: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ioredis unsubscribe overloads
  unsubscribe(...args: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ioredis event handler overloads
  on(event: string, callback: (...args: any[]) => void): any;
};

export interface CancellationCheckerOptions {
  connectorId: string;
  tenantId: string;
  jobId: string;
  redis?: RedisSubscriberClient;
  connectorConfigModel: Model<IConnectorConfig>;
}

export class CancellationChecker {
  private cancelled = false;
  private lastDbCheck = 0;
  private readonly DB_CHECK_INTERVAL_MS = 30000; // 30 seconds

  private readonly connectorId: string;
  private readonly tenantId: string;
  private readonly jobId: string;
  private readonly redis?: RedisSubscriberClient;
  private readonly connectorConfigModel: Model<IConnectorConfig>;
  private readonly cancelChannel: string;

  constructor(options: CancellationCheckerOptions) {
    this.connectorId = options.connectorId;
    this.tenantId = options.tenantId;
    this.jobId = options.jobId;
    this.redis = options.redis;
    this.connectorConfigModel = options.connectorConfigModel;
    this.cancelChannel = `connector-sync:${this.jobId}:cancel`;

    // Subscribe to Redis cancellation signal if available
    if (this.redis) {
      this.setupRedisSubscription();
    }
  }

  /**
   * Set up Redis pub/sub subscription for cancellation signals.
   */
  private setupRedisSubscription(): void {
    if (!this.redis) return;

    // ioredis subscribe returns a Promise, handle both callback and promise styles
    const subscribeResult = this.redis.subscribe(this.cancelChannel);
    if (subscribeResult && typeof subscribeResult.then === 'function') {
      subscribeResult
        .then(() => {
          console.log(`[CancellationChecker] Subscribed to ${this.cancelChannel}`);
        })
        .catch((err: Error) => {
          console.error('[CancellationChecker] Failed to subscribe to Redis channel:', err);
        });
    }

    this.redis.on('message', (channel: string, _message: string) => {
      if (channel === this.cancelChannel) {
        console.log(
          `[CancellationChecker] Redis cancellation signal received for job ${this.jobId}`,
        );
        this.cancelled = true;
      }
    });
  }

  /**
   * Check if sync should be cancelled.
   * Fast path: Redis signal (immediate)
   * Slow path: DB poll every 30s (fallback)
   */
  async isCancelled(): Promise<boolean> {
    // Fast path: Redis signal
    if (this.cancelled) {
      console.log('[CancellationChecker] Cancellation detected via Redis signal');
      return true;
    }

    // Slow path: DB poll (every 30s as fallback)
    const now = Date.now();
    if (now - this.lastDbCheck > this.DB_CHECK_INTERVAL_MS) {
      this.lastDbCheck = now;

      try {
        const config = await this.connectorConfigModel
          .findOne({
            _id: this.connectorId,
            tenantId: this.tenantId,
          })
          .lean();

        if (config?.errorState?.isPaused) {
          console.log('[CancellationChecker] Cancellation/pause detected via DB poll', {
            isPaused: config.errorState.isPaused,
            pausedAt: config.errorState.pausedAt,
          });
          this.cancelled = true;
          return true;
        }
      } catch (error) {
        console.error('[CancellationChecker] DB poll error:', error);
        // Don't fail the sync on DB errors - continue and retry later
      }
    }

    return false;
  }

  /**
   * Clean up Redis subscription when sync completes.
   */
  async cleanup(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.unsubscribe(this.cancelChannel);
        console.log(`[CancellationChecker] Unsubscribed from ${this.cancelChannel}`);
      } catch (error) {
        console.error('[CancellationChecker] Failed to unsubscribe:', error);
      }
    }
  }
}
