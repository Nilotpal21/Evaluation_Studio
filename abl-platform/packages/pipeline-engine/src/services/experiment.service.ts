/**
 * Experiment Service
 *
 * Provides Redis-cached lookup of the active experiment for a project,
 * cache invalidation, and parent-session experiment group inheritance.
 */

import { createLogger } from '@abl/compiler/platform';
import type { IExperiment } from '../schemas/experiment.schema.js';
import type { RedisLike } from '../pipeline/services/definition-cache.js';
import type { CachedExperiment } from './experiment-assignment.js';

const log = createLogger('experiment-service');

// ─── Cache Configuration ────────────────────────────────────────────────

/**
 * Redis key prefix for active experiment cache.
 * Key format: experiment:active:{tenantId}:{projectId}
 * Value: JSON-serialized CachedExperiment or the literal string 'null'
 *        (caches absence of an active experiment to avoid repeated DB queries).
 */
const CACHE_TTL_SECONDS = 300;
const CACHE_KEY_PREFIX = 'experiment:active:';

// ─── Session Lookup Result ──────────────────────────────────────────────

/** Minimal session projection for parent experiment group inheritance. */
interface ParentSessionProjection {
  experimentId: string | null;
  experimentGroup: 'control' | 'experiment' | null;
}

// ─── Service Class ──────────────────────────────────────────────────────

export class ExperimentService {
  constructor(
    private readonly redis: RedisLike,
    private readonly getExperimentModel: () => Promise<
      typeof import('../schemas/experiment.schema.js').ExperimentModel
    >,
    private readonly findSessionByIdAndTenant: (
      id: string,
      tenantId: string,
      projectId: string,
    ) => Promise<ParentSessionProjection | null>,
  ) {}

  /**
   * Get the active (status=running) experiment for a project.
   *
   * Checks Redis cache first. On cache miss, queries MongoDB and caches
   * the result (or absence) for CACHE_TTL_SECONDS.
   */
  async getActiveExperiment(tenantId: string, projectId: string): Promise<CachedExperiment | null> {
    const cacheKey = `${CACHE_KEY_PREFIX}${tenantId}:${projectId}`;

    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached === 'null' ? null : (JSON.parse(cached) as CachedExperiment);
    }

    const ExperimentModel = await this.getExperimentModel();
    const doc = await ExperimentModel.findOne(
      { tenantId, projectId, status: 'running' },
      {
        _id: 1,
        assignmentMode: 1,
        controlVersion: 1,
        experimentVersion: 1,
        controlDeploymentId: 1,
        experimentDeploymentId: 1,
        trafficSplit: 1,
        channels: 1,
      },
    ).lean<
      Pick<
        IExperiment,
        | '_id'
        | 'assignmentMode'
        | 'controlVersion'
        | 'experimentVersion'
        | 'controlDeploymentId'
        | 'experimentDeploymentId'
        | 'trafficSplit'
        | 'channels'
      >
    >();

    const value: CachedExperiment | null = doc
      ? {
          experimentId: String(doc._id),
          assignmentMode: (doc.assignmentMode as 'version' | 'deployment') ?? 'version',
          controlVersion: doc.controlVersion,
          experimentVersion: doc.experimentVersion,
          controlDeploymentId: doc.controlDeploymentId
            ? String(doc.controlDeploymentId)
            : undefined,
          experimentDeploymentId: doc.experimentDeploymentId
            ? String(doc.experimentDeploymentId)
            : undefined,
          trafficSplit: doc.trafficSplit,
          channels: doc.channels ?? [],
        }
      : null;

    await this.redis.set(
      cacheKey,
      value === null ? 'null' : JSON.stringify(value),
      'EX',
      CACHE_TTL_SECONDS,
    );

    return value;
  }

  /**
   * Invalidate the cached active experiment for a project.
   * Call after experiment status changes (start, stop, complete).
   */
  async invalidateCache(tenantId: string, projectId: string): Promise<void> {
    const cacheKey = `${CACHE_KEY_PREFIX}${tenantId}:${projectId}`;
    await this.redis.del(cacheKey);
    log.info('Experiment cache invalidated', { tenantId, projectId });
  }

  /**
   * Atomically increment the assignment counter for a group.
   * Fire-and-forget — called after successful experiment assignment.
   */
  async incrementAssignmentCount(
    experimentId: string,
    tenantId: string,
    group: 'control' | 'experiment',
  ): Promise<void> {
    const ExperimentModel = await this.getExperimentModel();
    const field = group === 'control' ? 'controlAssignments' : 'experimentAssignments';
    await ExperimentModel.updateOne({ _id: experimentId, tenantId }, { $inc: { [field]: 1 } });
  }

  /**
   * Look up the experiment group of a parent session.
   * Used for A2A child sessions that should inherit the parent's assignment.
   */
  async getParentExperimentGroup(
    parentId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{ experimentId: string; experimentGroup: 'control' | 'experiment' } | null> {
    const parent = await this.findSessionByIdAndTenant(parentId, tenantId, projectId);

    if (!parent?.experimentId || !parent?.experimentGroup) return null;
    return {
      experimentId: parent.experimentId,
      experimentGroup: parent.experimentGroup,
    };
  }
}
