/**
 * Tenant-Isolated Batch Queue (RFC-003 Phase 2.3)
 *
 * Maintains separate queues per tenant-index-provider combination.
 * CRITICAL: Ensures no cross-tenant batching.
 */

import type { QueuedRequest, BatchConfig } from './batch-types.js';

export class BatchQueue {
  private queues: Map<string, QueuedRequest[]>;
  private readonly maxRequestAgeMs: number;

  // Track last activity per queue for cleanup
  private lastActivity: Map<string, number>;

  constructor(config: Pick<BatchConfig, 'maxRequestAgeMs'>) {
    this.queues = new Map();
    this.lastActivity = new Map();
    this.maxRequestAgeMs = config.maxRequestAgeMs;
  }

  /**
   * Add request to tenant-isolated queue.
   */
  enqueue(tenantId: string, indexId: string, provider: string, request: QueuedRequest): void {
    const key = this.getQueueKey(tenantId, indexId, provider);

    if (!this.queues.has(key)) {
      this.queues.set(key, []);
    }

    this.queues.get(key)!.push(request);
    this.lastActivity.set(key, Date.now());
  }

  /**
   * Remove and return up to N requests from queue.
   * CRITICAL: All returned requests are from same tenant-index-provider.
   */
  dequeue(tenantId: string, indexId: string, provider: string, count: number): QueuedRequest[] {
    const key = this.getQueueKey(tenantId, indexId, provider);
    const queue = this.queues.get(key);

    if (!queue || queue.length === 0) {
      return [];
    }

    // Remove stale requests (queued too long)
    this.removeStaleRequests(queue);

    // Take up to 'count' requests
    const batch = queue.splice(0, Math.min(count, queue.length));

    // Update last activity
    if (queue.length === 0) {
      this.queues.delete(key);
      this.lastActivity.delete(key);
    } else {
      this.lastActivity.set(key, Date.now());
    }

    return batch;
  }

  /**
   * Get current queue size for a specific tenant-index-provider.
   */
  size(tenantId: string, indexId: string, provider: string): number {
    const key = this.getQueueKey(tenantId, indexId, provider);
    return this.queues.get(key)?.length ?? 0;
  }

  /**
   * Get all active queue keys (for iteration).
   */
  getActiveQueues(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Parse queue key back to components.
   */
  parseQueueKey(key: string): { tenantId: string; indexId: string; provider: string } {
    const [tenantId, indexId, provider] = key.split(':');
    return { tenantId, indexId, provider };
  }

  /**
   * Clear all queues (for testing or shutdown).
   */
  clear(): void {
    // Reject all pending requests
    for (const queue of this.queues.values()) {
      for (const req of queue) {
        req.reject(new Error('Queue cleared'));
      }
    }
    this.queues.clear();
    this.lastActivity.clear();
  }

  /**
   * Clear queues for a specific tenant (for tenant deletion).
   */
  clearTenant(tenantId: string): void {
    const keysToDelete: string[] = [];

    for (const key of this.queues.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        const queue = this.queues.get(key)!;
        for (const req of queue) {
          req.reject(new Error('Tenant queue cleared'));
        }
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.queues.delete(key);
      this.lastActivity.delete(key);
    }
  }

  /**
   * Remove empty queues that have been inactive (for memory management).
   */
  cleanupInactiveQueues(inactivityThresholdMs: number): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, lastActiveTime] of this.lastActivity.entries()) {
      const queue = this.queues.get(key);

      // Remove if empty and inactive
      if ((!queue || queue.length === 0) && now - lastActiveTime > inactivityThresholdMs) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.queues.delete(key);
      this.lastActivity.delete(key);
    }
  }

  /**
   * Get statistics about all queues.
   */
  getStats(): {
    activeQueues: number;
    totalRequests: number;
    stalledRequests: number;
    queueSizes: Record<string, number>;
  } {
    let totalRequests = 0;
    let stalledRequests = 0;
    const queueSizes: Record<string, number> = {};

    const now = Date.now();

    for (const [key, queue] of this.queues.entries()) {
      const size = queue.length;
      totalRequests += size;
      queueSizes[key] = size;

      // Count stalled requests (waiting too long)
      for (const req of queue) {
        if (now - req.timestamp > this.maxRequestAgeMs) {
          stalledRequests++;
        }
      }
    }

    return {
      activeQueues: this.queues.size,
      totalRequests,
      stalledRequests,
      queueSizes,
    };
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Generate queue key with tenant and index isolation.
   *
   * Format: {tenantId}:{indexId}:{provider}
   *
   * CRITICAL: This ensures separate queues per tenant-index-provider.
   */
  private getQueueKey(tenantId: string, indexId: string, provider: string): string {
    return `${tenantId}:${indexId}:${provider}`;
  }

  /**
   * Remove stale requests from queue (queued too long).
   */
  private removeStaleRequests(queue: QueuedRequest[]): void {
    const now = Date.now();
    let i = 0;

    while (i < queue.length) {
      const req = queue[i];
      const age = now - req.timestamp;

      if (age > this.maxRequestAgeMs) {
        // Reject stale request
        req.reject(new Error(`Request stale after ${age}ms (max: ${this.maxRequestAgeMs}ms)`));
        queue.splice(i, 1);
      } else {
        i++;
      }
    }
  }
}
