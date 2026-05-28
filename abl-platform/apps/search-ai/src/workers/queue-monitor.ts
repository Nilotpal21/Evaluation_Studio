/**
 * Queue Monitor
 *
 * Monitors BullMQ queue health and depth across the ingestion pipeline.
 * Provides visibility into queue bottlenecks and processing rates.
 */

import { Queue } from 'bullmq';
import {
  QUEUE_DOCLING_EXTRACTION,
  QUEUE_PAGE_PROCESSING,
  QUEUE_CANONICAL_MAP,
  QUEUE_ENRICHMENT,
  QUEUE_EMBEDDING,
} from '@agent-platform/search-ai-sdk';
import { createQueue } from './shared.js';

export interface QueueStats {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
  timestamp: Date;
}

export interface QueueHealth {
  queueName: string;
  status: 'healthy' | 'degraded' | 'critical';
  waiting: number;
  active: number;
  failed: number;
  issues: string[];
  timestamp: Date;
}

/**
 * Get stats for a single queue
 */
async function getQueueStats(queueName: string): Promise<QueueStats> {
  const queue = createQueue(queueName);

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    const total = waiting + active + completed + failed + delayed;

    return {
      queueName,
      waiting,
      active,
      completed,
      failed,
      delayed,
      total,
      timestamp: new Date(),
    };
  } finally {
    await queue.close();
  }
}

/**
 * Get stats for all monitored queues
 */
export async function getAllQueueStats(): Promise<QueueStats[]> {
  const queues = [
    'content-processing',
    QUEUE_DOCLING_EXTRACTION,
    QUEUE_PAGE_PROCESSING,
    QUEUE_CANONICAL_MAP,
    QUEUE_ENRICHMENT,
    QUEUE_EMBEDDING,
  ];

  return Promise.all(queues.map((queueName) => getQueueStats(queueName)));
}

/**
 * Assess queue health based on stats
 */
function assessQueueHealth(stats: QueueStats): QueueHealth {
  const issues: string[] = [];
  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

  // Critical: High failure rate (>10% of total jobs)
  if (stats.failed > 0 && stats.failed / Math.max(stats.total, 1) > 0.1) {
    issues.push(
      `High failure rate: ${stats.failed} failed jobs (${((stats.failed / stats.total) * 100).toFixed(1)}%)`,
    );
    status = 'critical';
  }

  // Critical: Very high backlog (>1000 waiting)
  if (stats.waiting > 1000) {
    issues.push(`Very high backlog: ${stats.waiting} jobs waiting`);
    status = 'critical';
  }
  // Degraded: Moderate backlog (>100 waiting)
  else if (stats.waiting > 100) {
    issues.push(`Moderate backlog: ${stats.waiting} jobs waiting`);
    if (status !== 'critical') status = 'degraded';
  }

  // Info: High active count (might indicate slow processing)
  if (stats.active > 50) {
    issues.push(`High active count: ${stats.active} jobs in progress`);
  }

  return {
    queueName: stats.queueName,
    status,
    waiting: stats.waiting,
    active: stats.active,
    failed: stats.failed,
    issues,
    timestamp: stats.timestamp,
  };
}

/**
 * Get health assessment for all queues
 */
export async function getAllQueueHealth(): Promise<QueueHealth[]> {
  const stats = await getAllQueueStats();
  return stats.map(assessQueueHealth);
}

/**
 * Log queue stats in a human-readable format
 */
export function logQueueStats(stats: QueueStats[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('[queue-monitor] Queue Statistics');
  console.log('='.repeat(80));

  for (const queue of stats) {
    const healthStatus = assessQueueHealth(queue).status;
    const statusEmoji = healthStatus === 'healthy' ? '✓' : healthStatus === 'degraded' ? '⚠' : '✗';

    console.log(`\n${statusEmoji} ${queue.queueName}`);
    console.log(`  Waiting:   ${queue.waiting.toString().padStart(6)}`);
    console.log(`  Active:    ${queue.active.toString().padStart(6)}`);
    console.log(`  Completed: ${queue.completed.toString().padStart(6)}`);
    console.log(`  Failed:    ${queue.failed.toString().padStart(6)}`);
    console.log(`  Delayed:   ${queue.delayed.toString().padStart(6)}`);
    console.log(`  Total:     ${queue.total.toString().padStart(6)}`);
  }

  console.log('\n' + '='.repeat(80));
}

/**
 * Log queue health issues
 */
export function logQueueHealth(health: QueueHealth[]): void {
  const critical = health.filter((h) => h.status === 'critical');
  const degraded = health.filter((h) => h.status === 'degraded');

  if (critical.length > 0) {
    console.log('\n' + '✗'.repeat(80));
    console.log('[queue-monitor] CRITICAL ISSUES DETECTED');
    console.log('✗'.repeat(80));

    for (const queue of critical) {
      console.log(`\n✗ ${queue.queueName}`);
      for (const issue of queue.issues) {
        console.log(`  - ${issue}`);
      }
    }
    console.log('\n' + '✗'.repeat(80));
  }

  if (degraded.length > 0) {
    console.log('\n' + '⚠'.repeat(80));
    console.log('[queue-monitor] DEGRADED QUEUE PERFORMANCE');
    console.log('⚠'.repeat(80));

    for (const queue of degraded) {
      console.log(`\n⚠ ${queue.queueName}`);
      for (const issue of queue.issues) {
        console.log(`  - ${issue}`);
      }
    }
    console.log('\n' + '⚠'.repeat(80));
  }

  if (critical.length === 0 && degraded.length === 0) {
    console.log('\n[queue-monitor] ✓ All queues healthy');
  }
}

/**
 * Monitor queues and log stats + health
 */
export async function monitorQueues(): Promise<void> {
  const stats = await getAllQueueStats();
  const health = await getAllQueueHealth();

  logQueueStats(stats);
  logQueueHealth(health);
}

/**
 * Start periodic queue monitoring
 *
 * @param intervalMs - Monitoring interval in milliseconds (default: 60000 = 1 minute)
 * @returns Stop function to cancel monitoring
 */
export function startPeriodicMonitoring(intervalMs: number = 60000): () => void {
  console.log(`[queue-monitor] Starting periodic monitoring (interval: ${intervalMs}ms)`);

  // Initial monitoring
  monitorQueues().catch((error) => {
    console.error('[queue-monitor] Initial monitoring failed:', error);
  });

  // Periodic monitoring
  const intervalId = setInterval(() => {
    monitorQueues().catch((error) => {
      console.error('[queue-monitor] Periodic monitoring failed:', error);
    });
  }, intervalMs);

  // Return stop function
  return () => {
    console.log('[queue-monitor] Stopping periodic monitoring');
    clearInterval(intervalId);
  };
}
