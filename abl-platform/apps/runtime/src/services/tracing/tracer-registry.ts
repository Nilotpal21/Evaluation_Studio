/**
 * TracerRegistry — Session-scoped tracer lifecycle management.
 *
 * Manages a bounded Map of TracerImpl instances with LRU eviction and TTL-based sweep.
 */

import type { WritePipeline } from '@agent-platform/shared-observability/tracing';
import { createLogger } from '@abl/compiler/platform';
import { TracerImpl } from './tracer.js';

const log = createLogger('tracer-registry');

/** Maximum number of concurrent tracer entries */
const MAX_REGISTRY_ENTRIES = 10_000;

/** Time-to-live for idle tracers in milliseconds (30 minutes) */
const TRACER_TTL_MS = 30 * 60 * 1000;

/** Sweep interval in milliseconds (60 seconds) */
const SWEEP_INTERVAL_MS = 60 * 1000;

interface RegistryEntry {
  tracer: TracerImpl;
  lastAccess: number;
}

export interface TracerRegistryConfig {
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  writePipeline: WritePipeline;
  defaultAttributes?: Record<string, string>;
}

export class TracerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly sweepInterval: NodeJS.Timeout;

  constructor() {
    this.sweepInterval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Don't hold the event loop open for background cleanup
    this.sweepInterval.unref();
  }

  /**
   * Get an existing tracer for the session or create a new one.
   */
  getOrCreate(sessionId: string, config: TracerRegistryConfig): TracerImpl {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing.tracer;
    }

    // Evict LRU if at capacity
    if (this.entries.size >= MAX_REGISTRY_ENTRIES) {
      this.evictLRU();
    }

    const tracer = new TracerImpl({
      sessionId: config.sessionId,
      tenantId: config.tenantId,
      projectId: config.projectId,
      writePipeline: config.writePipeline,
      defaultAttributes: config.defaultAttributes,
    });

    this.entries.set(sessionId, {
      tracer,
      lastAccess: Date.now(),
    });

    return tracer;
  }

  /**
   * Remove a tracer on session end.
   */
  remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /**
   * Periodic sweep — removes expired entries and evicts LRU if over max.
   */
  sweep(): void {
    const now = Date.now();
    let expired = 0;

    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastAccess > TRACER_TTL_MS) {
        this.entries.delete(sessionId);
        expired++;
      }
    }

    // If still over max after TTL sweep, evict LRU
    while (this.entries.size > MAX_REGISTRY_ENTRIES) {
      this.evictLRU();
    }

    if (expired > 0) {
      log.info('Tracer registry sweep completed', {
        expired,
        remaining: this.entries.size,
      });
    }
  }

  /**
   * Stop the sweep interval (for shutdown).
   */
  destroy(): void {
    clearInterval(this.sweepInterval);
  }

  /**
   * Get current registry size (for monitoring).
   */
  get size(): number {
    return this.entries.size;
  }

  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
      log.info('Evicted LRU tracer', { sessionId: oldestKey });
    }
  }
}
