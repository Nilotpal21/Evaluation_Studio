/**
 * Command Queue — Per-exploration in-memory command queue
 *
 * Stores intervention commands forwarded from search-ai so that
 * the depth prober can check for pending commands between page visits.
 */

import { createLogger } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface Intervention {
  type: 'stop' | 'add-sample' | 'explore-branch' | 'skip-branch' | 'explore-all' | 'undo-skip';
  payload?: {
    url?: string;
    urls?: string[];
    maxDepth?: number;
  };
  receivedAt: number;
}

// ─── Logger ─────────────────────────────────────────────────────────

const logger = createLogger('command-queue');

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum commands queued per exploration */
export const MAX_QUEUED_COMMANDS = 50;

/** Maximum active explorations tracked (prevents memory leak) */
const MAX_EXPLORATIONS = 100;

// ─── Queue Store ────────────────────────────────────────────────────

const queues = new Map<string, Intervention[]>();

/**
 * Enqueue a command for a given exploration.
 * Returns false if the queue is full (>= MAX_QUEUED_COMMANDS).
 */
export function enqueueCommand(exploreId: string, command: Intervention): boolean {
  evictStaleQueues();

  let queue = queues.get(exploreId);
  if (!queue) {
    queue = [];
    queues.set(exploreId, queue);
  }

  if (queue.length >= MAX_QUEUED_COMMANDS) {
    logger.warn('Command queue full', { exploreId, queueSize: queue.length });
    return false;
  }

  queue.push(command);
  logger.info('Command enqueued', { exploreId, type: command.type, queueSize: queue.length });
  return true;
}

/**
 * Dequeue the next command for a given exploration.
 * Returns undefined if the queue is empty.
 */
export function getNextCommand(exploreId: string): Intervention | undefined {
  const queue = queues.get(exploreId);
  if (!queue || queue.length === 0) return undefined;
  return queue.shift();
}

/**
 * Get all pending commands without removing them.
 */
export function peekCommands(exploreId: string): Intervention[] {
  return queues.get(exploreId) ?? [];
}

/**
 * Clear the command queue for a given exploration.
 */
export function clearQueue(exploreId: string): void {
  queues.delete(exploreId);
  logger.info('Queue cleared', { exploreId });
}

/**
 * Get the current queue size for an exploration.
 */
export function queueSize(exploreId: string): number {
  return queues.get(exploreId)?.length ?? 0;
}

// ─── Eviction ───────────────────────────────────────────────────────

/** Remove queues for explorations that are likely stale (>30 min old) */
function evictStaleQueues(): void {
  if (queues.size <= MAX_EXPLORATIONS) return;

  const now = Date.now();
  const TTL = 30 * 60 * 1000; // 30 minutes

  for (const [id, queue] of queues) {
    const lastCommand = queue[queue.length - 1];
    if (!lastCommand || now - lastCommand.receivedAt > TTL) {
      queues.delete(id);
    }
  }

  // If still over limit, remove oldest
  if (queues.size > MAX_EXPLORATIONS) {
    const entries = [...queues.entries()];
    const toRemove = entries.slice(0, entries.length - MAX_EXPLORATIONS);
    for (const [id] of toRemove) {
      queues.delete(id);
    }
  }
}
