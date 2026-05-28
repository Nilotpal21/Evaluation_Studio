/**
 * Fact Store
 *
 * Persistent memory storage for cross-session facts.
 * Supports:
 * - Namespaced fact storage (user.*, system.*, agent.*)
 * - TTL-based expiration
 * - Batch operations
 * - Querying by prefix
 */

import { randomUUID } from 'crypto';
import type { Environment } from '../core/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('fact-store');

// =============================================================================
// INTERFACES
// =============================================================================

export interface FactStoreConfig {
  /** Storage backend type */
  type: 'redis' | 'postgres' | 'memory' | 'clickhouse' | 'mongodb';

  /** Connection string for the backend */
  connectionString?: string;

  /** Default TTL in milliseconds (0 = no expiration) */
  defaultTtlMs?: number;

  /** Environment for namespacing */
  environment?: Environment;

  /** Key prefix for all facts */
  keyPrefix?: string;
}

export interface Fact {
  /** Unique fact ID */
  id: string;

  /** Fact key (path) */
  key: string;

  /** Fact value */
  value: unknown;

  /** When the fact was created */
  createdAt: Date;

  /** When the fact was last updated */
  updatedAt: Date;

  /** When the fact expires (null = never) */
  expiresAt: Date | null;

  /** Source of the fact */
  source: FactSource;

  /** Metadata */
  metadata?: Record<string, unknown>;
}

export interface FactSource {
  /** What created/updated this fact */
  type: 'agent' | 'user' | 'system' | 'external';

  /** Agent name if type is 'agent' */
  agentName?: string;

  /** Session ID if applicable */
  sessionId?: string;

  /** Trace ID for auditing */
  traceId?: string;
}

export interface SetFactParams {
  /** Fact key (supports dot notation for nesting) */
  key: string;

  /** Value to store */
  value: unknown;

  /** TTL in milliseconds (overrides default) */
  ttlMs?: number;

  /** Source information */
  source?: FactSource;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface GetFactParams {
  /** Fact key */
  key: string;

  /** Return default value if not found */
  defaultValue?: unknown;
}

export interface QueryFactsParams {
  /** Key prefix to match */
  prefix?: string;

  /** Pattern to match (glob-style) */
  pattern?: string;

  /** Filter by source type */
  sourceType?: FactSource['type'];

  /** Include expired facts */
  includeExpired?: boolean;

  /** Limit results */
  limit?: number;
}

export interface BatchSetParams {
  /** Facts to set */
  facts: SetFactParams[];

  /** Source for all facts (can be overridden per-fact) */
  defaultSource?: FactSource;
}

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class FactStore {
  protected config: FactStoreConfig;
  protected keyPrefix: string;

  constructor(config: FactStoreConfig) {
    this.config = config;
    this.keyPrefix = config.keyPrefix || `facts:${config.environment || 'dev'}:`;
  }

  /**
   * Set a fact
   */
  abstract set(params: SetFactParams): Promise<Fact>;

  /**
   * Get a fact by key
   */
  abstract get(params: GetFactParams): Promise<Fact | null>;

  /**
   * Get multiple facts by key in a single batch.
   * Default implementation uses parallel get() calls; subclasses may
   * override with optimized queries (e.g. $in for MongoDB).
   */
  async getMany(keys: string[]): Promise<Map<string, Fact>> {
    const results = new Map<string, Fact>();
    if (keys.length === 0) return results;
    const settled = await Promise.allSettled(
      keys.map(async (key) => ({ key, fact: await this.get({ key }) })),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.fact) {
        results.set(result.value.key, result.value.fact);
      }
    }
    return results;
  }

  /**
   * Get a fact value (convenience method)
   */
  async getValue<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
    const fact = await this.get({ key, defaultValue });
    return (fact?.value as T) ?? defaultValue;
  }

  /**
   * Delete a fact
   */
  abstract delete(key: string): Promise<boolean>;

  /**
   * Check if a fact exists
   */
  abstract exists(key: string): Promise<boolean>;

  /**
   * Query facts by criteria
   */
  abstract query(params: QueryFactsParams): Promise<Fact[]>;

  /**
   * Set multiple facts
   */
  abstract batchSet(params: BatchSetParams): Promise<Fact[]>;

  /**
   * Delete multiple facts
   */
  abstract batchDelete(keys: string[]): Promise<number>;

  /**
   * Clear all facts (use with caution!)
   */
  abstract clear(): Promise<number>;

  /**
   * Get all facts for a user/customer
   */
  async getForUser(userId: string): Promise<Fact[]> {
    return this.query({ prefix: `user.${userId}.` });
  }

  /**
   * Get all facts for a session
   */
  async getForSession(sessionId: string): Promise<Fact[]> {
    return this.query({ prefix: `session.${sessionId}.` });
  }

  /**
   * Set a user fact
   */
  async setUserFact(userId: string, key: string, value: unknown, ttlMs?: number): Promise<Fact> {
    return this.set({
      key: `user.${userId}.${key}`,
      value,
      ttlMs,
      source: { type: 'system' },
    });
  }

  /**
   * Get a user fact
   */
  async getUserFact<T = unknown>(
    userId: string,
    key: string,
    defaultValue?: T,
  ): Promise<T | undefined> {
    return this.getValue(`user.${userId}.${key}`, defaultValue);
  }

  /**
   * Set a system fact
   */
  async setSystemFact(key: string, value: unknown, ttlMs?: number): Promise<Fact> {
    return this.set({
      key: `system.${key}`,
      value,
      ttlMs,
      source: { type: 'system' },
    });
  }

  /**
   * Get a system fact
   */
  async getSystemFact<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
    return this.getValue(`system.${key}`, defaultValue);
  }

  /**
   * Clean up expired facts
   */
  abstract cleanup(): Promise<number>;

  /**
   * Build the full key with prefix
   */
  protected buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Parse TTL string to milliseconds
   */
  protected parseTtl(ttl: string | number | undefined): number | null {
    if (ttl === undefined || ttl === null) {
      return this.config.defaultTtlMs || null;
    }

    if (typeof ttl === 'number') {
      return ttl > 0 ? ttl : null;
    }

    // Parse string format: "1d", "2h", "30m", "60s"
    const match = ttl.match(/^(\d+)(d|h|m|s)$/);
    if (!match) {
      return parseInt(ttl, 10) || null;
    }

    const [, amount, unit] = match;
    const num = parseInt(amount, 10);

    switch (unit) {
      case 'd':
        return num * 24 * 60 * 60 * 1000;
      case 'h':
        return num * 60 * 60 * 1000;
      case 'm':
        return num * 60 * 1000;
      case 's':
        return num * 1000;
      default:
        return null;
    }
  }
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION
// =============================================================================

export class InMemoryFactStore extends FactStore {
  private facts: Map<string, Fact> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: FactStoreConfig) {
    super(config);

    // Start cleanup interval
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      60000, // Every minute
    );
  }

  async set(params: SetFactParams): Promise<Fact> {
    const key = params.key;
    const existing = this.facts.get(key);
    const now = new Date();

    const ttlMs = this.parseTtl(params.ttlMs);
    const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs) : null;

    const fact: Fact = {
      id: existing?.id || randomUUID(),
      key,
      value: params.value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      expiresAt,
      source: params.source || { type: 'system' },
      metadata: params.metadata,
    };

    this.facts.set(key, fact);
    return fact;
  }

  async get(params: GetFactParams): Promise<Fact | null> {
    const fact = this.facts.get(params.key);

    if (!fact) {
      return null;
    }

    // Check expiration
    if (fact.expiresAt && fact.expiresAt < new Date()) {
      this.facts.delete(params.key);
      return null;
    }

    return fact;
  }

  async getMany(keys: string[]): Promise<Map<string, Fact>> {
    const results = new Map<string, Fact>();
    if (keys.length === 0) return results;
    const now = new Date();
    for (const key of keys) {
      const fact = this.facts.get(key);
      if (!fact) continue;
      if (fact.expiresAt && fact.expiresAt < now) {
        this.facts.delete(key);
        continue;
      }
      results.set(key, fact);
    }
    return results;
  }

  async delete(key: string): Promise<boolean> {
    return this.facts.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const fact = await this.get({ key });
    return fact !== null;
  }

  async query(params: QueryFactsParams): Promise<Fact[]> {
    const results: Fact[] = [];
    const now = new Date();

    for (const [key, fact] of this.facts.entries()) {
      // Check expiration
      if (!params.includeExpired && fact.expiresAt && fact.expiresAt < now) {
        continue;
      }

      // Check prefix
      if (params.prefix && !key.startsWith(params.prefix)) {
        continue;
      }

      // Check pattern (simple glob matching)
      if (params.pattern && !this.matchPattern(key, params.pattern)) {
        continue;
      }

      // Check source type
      if (params.sourceType && fact.source.type !== params.sourceType) {
        continue;
      }

      results.push(fact);

      // Check limit
      if (params.limit && results.length >= params.limit) {
        break;
      }
    }

    return results;
  }

  async batchSet(params: BatchSetParams): Promise<Fact[]> {
    const results: Fact[] = [];

    for (const factParams of params.facts) {
      const fact = await this.set({
        ...factParams,
        source: factParams.source || params.defaultSource,
      });
      results.push(fact);
    }

    return results;
  }

  async batchDelete(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.facts.delete(key)) {
        deleted++;
      }
    }
    return deleted;
  }

  async clear(): Promise<number> {
    const count = this.facts.size;
    this.facts.clear();
    return count;
  }

  async cleanup(): Promise<number> {
    const now = new Date();
    let cleaned = 0;

    for (const [key, fact] of this.facts.entries()) {
      if (fact.expiresAt && fact.expiresAt < now) {
        this.facts.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Stop the cleanup interval (for testing/shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Simple glob pattern matching
   */
  private matchPattern(key: string, pattern: string): boolean {
    const regex = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(key);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createFactStore(config: FactStoreConfig): FactStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryFactStore(config);

    case 'redis':
      // TODO: Implement Redis fact store
      log.warn('Redis fact store not implemented, falling back to memory');
      return new InMemoryFactStore({ ...config, type: 'memory' });

    case 'postgres':
      // TODO: Implement PostgreSQL fact store
      log.warn('PostgreSQL fact store not implemented, falling back to memory');
      return new InMemoryFactStore({ ...config, type: 'memory' });

    case 'clickhouse':
      // ClickHouseFactStore requires a ClickHouse client;
      // use runtime's ClickHouseFactStore directly instead of this factory.
      throw new Error(
        'ClickHouse fact store requires runtime dependencies — use ClickHouseFactStore from @abl/runtime',
      );

    default:
      throw new Error(`Unknown fact store type: ${config.type}`);
  }
}
