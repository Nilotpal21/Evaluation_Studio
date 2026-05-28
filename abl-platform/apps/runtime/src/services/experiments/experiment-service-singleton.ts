/**
 * Experiment Service Singleton
 *
 * Provides a lazily initialized ExperimentService instance for the runtime.
 * The service is constructed once with:
 *   - Redis client from the runtime's shared redis-client singleton
 *   - Lazy ExperimentModel factory (dynamic import for ESM compatibility)
 *   - Session lookup function scoped to tenant + project
 *
 * Returns null when Redis is not available (experiments require cache).
 */

import { createLogger } from '@abl/compiler/platform';
import { ExperimentService } from '@agent-platform/pipeline-engine';
import { getRedisClient } from '../redis/redis-client.js';

const log = createLogger('experiment-service-singleton');

let _instance: ExperimentService | null = null;
let _initialized = false;

/**
 * Get or create the shared ExperimentService instance.
 *
 * Returns null when Redis is unavailable — callers should skip experiment
 * assignment when the service is null.
 */
export function getExperimentService(): ExperimentService | null {
  if (_initialized) return _instance;
  _initialized = true;

  const redis = getRedisClient();
  if (!redis) {
    log.info('Experiment service unavailable — Redis not connected');
    return null;
  }

  _instance = new ExperimentService(
    redis,
    // Lazy model factory — avoids importing database models at module load time
    async () => {
      const { ExperimentModel } = await import('@agent-platform/pipeline-engine');
      return ExperimentModel;
    },
    // Session lookup for parent experiment group inheritance (A2A child sessions)
    async (id: string, tenantId: string, projectId: string) => {
      const { Session } = await import('@agent-platform/database/models');
      const doc = await Session.findOne(
        { _id: id, tenantId, projectId },
        { experimentId: 1, experimentGroup: 1 },
      ).lean();
      if (!doc) return null;
      return {
        experimentId: (doc as Record<string, unknown>).experimentId as string | null,
        experimentGroup: (doc as Record<string, unknown>).experimentGroup as
          | 'control'
          | 'experiment'
          | null,
      };
    },
  );

  log.info('Experiment service initialized');
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetExperimentService(): void {
  _instance = null;
  _initialized = false;
}
