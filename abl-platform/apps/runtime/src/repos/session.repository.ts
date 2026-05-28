/**
 * Session Repository (Class-Based)
 *
 * Extends TenantScopedRepository for runtime session operations.
 * Wraps the Session model with tenant-scoped helpers and adds
 * domain-specific queries (active sessions, agent filtering, metrics).
 *
 * IMPORTANT: All ID-based queries include tenantId — NEVER uses findById().
 * Cross-tenant access returns null (404 at route level, not 403).
 */

import { TenantScopedRepository } from '@agent-platform/shared/repos';
import type { PaginationOptions } from '@agent-platform/shared/repos';

// Lazy-loaded model reference (populated on first access)
let _Session: any = null;

async function getSessionModel(): Promise<any> {
  if (!_Session) {
    const models = await import('@agent-platform/database/models');
    _Session = models.Session;
  }
  return _Session;
}

export class SessionRepository extends TenantScopedRepository<any> {
  private _model: any = null;

  protected get model(): any {
    if (!this._model) {
      throw new Error('SessionRepository not initialized. Call init() first.');
    }
    return this._model;
  }

  /** Initialize the repository by loading the Session model. */
  async init(): Promise<void> {
    this._model = await getSessionModel();
  }

  // ─── Domain Queries ──────────────────────────────────────────────────────

  /**
   * Find active sessions for a specific agent within a tenant.
   */
  async findActiveSessions(
    tenantId: string,
    projectId: string,
    agentName?: string,
  ): Promise<any[]> {
    const filter: Record<string, unknown> = { projectId, status: 'active' };
    if (agentName) filter.currentAgent = agentName;
    return this.findManyByTenant(filter, tenantId, { sort: { lastActivityAt: -1 } });
  }

  /**
   * List sessions for a project with pagination and sorting.
   */
  async listByProject(
    tenantId: string,
    projectId: string,
    options?: PaginationOptions & { status?: string; channel?: string },
  ): Promise<any[]> {
    const filter: Record<string, unknown> = { projectId };
    if (options?.status) filter.status = options.status;
    if (options?.channel) filter.channel = options.channel;
    return this.findManyByTenant(filter, tenantId, {
      skip: options?.skip,
      limit: options?.limit,
      sort: options?.sort ?? { lastActivityAt: -1 },
    });
  }

  /**
   * Count sessions matching a filter, scoped to tenant.
   */
  async countByProject(
    tenantId: string,
    projectId: string,
    filter?: { status?: string; channel?: string },
  ): Promise<number> {
    const where: Record<string, unknown> = { projectId };
    if (filter?.status) where.status = filter.status;
    if (filter?.channel) where.channel = filter.channel;
    return this.countByTenant(where, tenantId);
  }

  /**
   * Update session status (e.g., active -> ended).
   */
  async updateStatus(id: string, tenantId: string, status: string): Promise<any | null> {
    return this.updateByIdAndTenant(id, tenantId, { status });
  }

  /**
   * Atomically increment token count and estimated cost.
   */
  async incrementTokens(
    id: string,
    tenantId: string,
    tokenCountIncrement: number,
    estimatedCostIncrement: number,
  ): Promise<void> {
    await this.model.updateOne(
      { _id: id, tenantId },
      { $inc: { tokenCount: tokenCountIncrement, estimatedCost: estimatedCostIncrement } },
    );
  }

  /**
   * Update lastActivityAt and increment message count.
   */
  async updateActivity(id: string, tenantId: string, messageCountIncrement: number): Promise<void> {
    await this.model.updateOne(
      { _id: id, tenantId },
      {
        $set: { lastActivityAt: new Date() },
        $inc: { messageCount: messageCountIncrement },
      },
    );
  }

  /**
   * Atomically increment session metrics (trace events, errors, handoffs).
   */
  async incrementMetrics(
    id: string,
    tenantId: string,
    increments: { traceEventCount?: number; errorCount?: number; handoffCount?: number },
  ): Promise<void> {
    const $inc: Record<string, number> = {};
    if (increments.traceEventCount) $inc.traceEventCount = increments.traceEventCount;
    if (increments.errorCount) $inc.errorCount = increments.errorCount;
    if (increments.handoffCount) $inc.handoffCount = increments.handoffCount;
    if (Object.keys($inc).length === 0) return;
    await this.model.updateOne({ _id: id, tenantId }, { $inc });
  }

  /**
   * Find old sessions for a tenant, scoped to specific statuses before a cutoff date.
   * Used by per-tenant retention cleanup.
   */
  async findOldSessionsByTenant(
    tenantId: string,
    cutoff: Date,
    statuses: string[],
    batchSize: number,
  ): Promise<Array<{ id: string }>> {
    const docs = await this.model
      .find({ tenantId, lastActivityAt: { $lt: cutoff }, status: { $in: statuses } }, { _id: 1 })
      .limit(batchSize)
      .lean();
    return docs.map((d: any) => ({ id: d._id as string }));
  }
}

/** Singleton instance — call `await sessionRepository.init()` before use. */
export const sessionRepository = new SessionRepository();
