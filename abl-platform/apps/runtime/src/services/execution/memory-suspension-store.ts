/**
 * MemorySuspensionStore — in-memory implementation of SuspensionStore.
 *
 * Suitable for development and single-pod deployments. Suspensions do not
 * survive process restarts. For production, use a MongoDB-backed implementation.
 */

import type { SuspensionStore } from '@agent-platform/execution';
import type { SuspendedExecution } from '@agent-platform/execution';

export class MemorySuspensionStore implements SuspensionStore {
  private readonly store = new Map<string, SuspendedExecution>();

  async create(suspension: SuspendedExecution): Promise<void> {
    this.store.set(suspension.suspensionId, { ...suspension });
  }

  async load(suspensionId: string): Promise<SuspendedExecution | null> {
    return this.store.get(suspensionId) ?? null;
  }

  async loadScoped(tenantId: string, suspensionId: string): Promise<SuspendedExecution | null> {
    const s = this.store.get(suspensionId);
    return s && s.tenantId === tenantId ? s : null;
  }

  async loadByCallbackId(callbackId: string): Promise<SuspendedExecution | null> {
    for (const s of this.store.values()) {
      if (s.callbackId === callbackId) return s;
    }
    return null;
  }

  async claimForResume(suspensionId: string): Promise<boolean> {
    const s = this.store.get(suspensionId);
    if (!s || s.status !== 'suspended') return false;
    s.status = 'resuming';
    s.resumedAt = new Date();
    s.resumeAttempts++;
    return true;
  }

  async releaseClaim(suspensionId: string): Promise<void> {
    const s = this.store.get(suspensionId);
    if (s && s.status === 'resuming') {
      s.status = 'suspended';
    }
  }

  async complete(suspensionId: string): Promise<void> {
    const s = this.store.get(suspensionId);
    if (s) {
      s.status = 'completed';
      s.completedAt = new Date();
    }
  }

  async fail(suspensionId: string, error: { code: string; message: string }): Promise<void> {
    const s = this.store.get(suspensionId);
    if (s) {
      s.status = 'failed';
      s.error = error;
    }
  }

  async expire(suspensionId: string): Promise<void> {
    const s = this.store.get(suspensionId);
    if (s) s.status = 'expired';
  }

  async cancel(suspensionId: string): Promise<void> {
    const s = this.store.get(suspensionId);
    if (s) s.status = 'cancelled';
  }

  async findByBarrier(barrierId: string): Promise<SuspendedExecution[]> {
    return [...this.store.values()].filter((s) => s.barrierId === barrierId);
  }

  async findExpired(limit: number): Promise<SuspendedExecution[]> {
    const now = new Date();
    return [...this.store.values()]
      .filter((s) => s.status === 'suspended' && s.expiresAt < now)
      .slice(0, limit);
  }

  async findBySession(sessionId: string): Promise<SuspendedExecution[]> {
    return [...this.store.values()].filter((s) => s.sessionId === sessionId);
  }

  async list(params: {
    tenantId: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<SuspendedExecution[]> {
    let results = [...this.store.values()].filter((s) => s.tenantId === params.tenantId);
    if (params.status) results = results.filter((s) => s.status === params.status);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    return results.slice(offset, offset + limit);
  }
}
