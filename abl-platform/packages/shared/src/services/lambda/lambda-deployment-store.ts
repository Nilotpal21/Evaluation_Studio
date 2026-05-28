/**
 * Lambda Deployment Store
 *
 * Extensible interface for tracking per-tenant Lambda runner deployments.
 * Redis implementation now; MongoDB can be swapped in later without
 * touching the deployment service or runner.
 */

import { scanKeys, type RedisClient } from '@agent-platform/redis';
import type { LambdaLogger } from './types.js';

/* v8 ignore start -- default logger fallback used only when no logger injected */
const defaultLogger: LambdaLogger = {
  info: (msg, meta) => console.info(msg, meta),
  warn: (msg, meta) => console.warn(msg, meta),
  error: (msg, meta) => console.error(msg, meta),
  debug: (msg, meta) => console.debug(msg, meta),
};
/* v8 ignore stop */

// ─── Types ─────────────────────────────────────────────────────────────────

export type LambdaDeploymentStatus = 'deploying' | 'active' | 'failed' | 'deleting';

export interface LambdaDeploymentRecord {
  tenantId: string;
  runtime: 'javascript' | 'python';
  functionName: string;
  status: LambdaDeploymentStatus;
  region: string;
  createdAt: string;
  updatedAt: string;
  lastHealthCheck?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

// ─── Interface ─────────────────────────────────────────────────────────────

export interface LambdaDeploymentStore {
  get(tenantId: string, runtime: string): Promise<LambdaDeploymentRecord | null>;
  upsert(record: LambdaDeploymentRecord): Promise<void>;
  updateStatus(
    tenantId: string,
    runtime: string,
    status: LambdaDeploymentStatus,
    extra?: Partial<LambdaDeploymentRecord>,
  ): Promise<void>;
  delete(tenantId: string, runtime: string): Promise<void>;
  listByTenant(tenantId: string): Promise<LambdaDeploymentRecord[]>;
}

// ─── Redis Implementation ──────────────────────────────────────────────────

const KEY_PREFIX = 'lambda:runner';

function buildKey(tenantId: string, runtime: string): string {
  return `${KEY_PREFIX}:${tenantId}:${runtime}`;
}

export class RedisLambdaDeploymentStore implements LambdaDeploymentStore {
  private readonly log: LambdaLogger;

  constructor(
    private redis: RedisClient,
    logger?: LambdaLogger,
  ) {
    this.log = logger ?? defaultLogger;
  }

  async get(tenantId: string, runtime: string): Promise<LambdaDeploymentRecord | null> {
    const raw = await this.redis.get(buildKey(tenantId, runtime));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LambdaDeploymentRecord;
    } catch (err) {
      this.log.warn('Failed to parse deployment record', { tenantId, runtime, error: String(err) });
      return null;
    }
  }

  async upsert(record: LambdaDeploymentRecord): Promise<void> {
    const key = buildKey(record.tenantId, record.runtime);
    await this.redis.set(key, JSON.stringify(record));
  }

  async updateStatus(
    tenantId: string,
    runtime: string,
    status: LambdaDeploymentStatus,
    extra?: Partial<LambdaDeploymentRecord>,
  ): Promise<void> {
    const existing = await this.get(tenantId, runtime);
    if (!existing) {
      throw new Error(`Deployment record not found for tenant "${tenantId}" runtime "${runtime}"`);
    }
    const updated: LambdaDeploymentRecord = {
      ...existing,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.upsert(updated);
  }

  async delete(tenantId: string, runtime: string): Promise<void> {
    await this.redis.del(buildKey(tenantId, runtime));
  }

  async listByTenant(tenantId: string): Promise<LambdaDeploymentRecord[]> {
    const pattern = `${KEY_PREFIX}:${tenantId}:*`;
    const records: LambdaDeploymentRecord[] = [];
    for await (const key of scanKeys(this.redis, pattern)) {
      const raw = await this.redis.get(key);
      if (raw) {
        try {
          records.push(JSON.parse(raw));
        } catch {
          // skip malformed entries
        }
      }
    }
    return records;
  }
}
