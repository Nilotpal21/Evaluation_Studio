/**
 * Project Environments Route
 *
 * Returns the distinct environment names from the deployments collection
 * for a given project + tenant. Used by Studio to populate the
 * environment dropdown in the Agent Assist connection dialog.
 *
 * Mount: /api/projects/:projectId/environments
 */

import { Router } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const log = createLogger('project-environments');

// ─── Constants ─────────────────────────────────────────────────────────

const DEFAULT_ENVIRONMENTS = ['dev', 'stg', 'prod'];

// ─── Types ─────────────────────────────────────────────────────────────

interface ProjectParams {
  projectId: string;
}

// ─── Extractable pure function for environment resolution ──────────────

/**
 * Given a list of environment strings from deployments, returns sorted
 * distinct values. Falls back to DEFAULT_ENVIRONMENTS when the list is empty.
 */
export function resolveEnvironments(deploymentEnvs: string[]): string[] {
  const unique = [...new Set(deploymentEnvs)].sort();
  return unique.length > 0 ? unique : [...DEFAULT_ENVIRONMENTS];
}

// ─── DI interface for testing ──────────────────────────────────────────

export interface ProjectEnvironmentsDeps {
  /** Override the deployment query for testing. */
  getDistinctEnvironments?: (tenantId: string, projectId: string) => Promise<string[]>;
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createProjectEnvironmentsRouter(
  deps?: ProjectEnvironmentsDeps,
): ReturnType<typeof Router> {
  const router: ReturnType<typeof Router> = Router({ mergeParams: true });

  // ─── Middleware ──────────────────────────────────────────────────────
  router.use(authMiddleware);
  router.use(requireProjectScope('projectId'));
  router.use(tenantRateLimit('request'));

  // ─── GET / — List distinct environments ─────────────────────────────

  router.get('/', async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const tenantId = req.tenantContext?.tenantId;
      const { projectId } = req.params as unknown as ProjectParams;
      if (!tenantId || !projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CONTEXT', message: 'Missing tenant or project context' },
        });
        return;
      }

      if (!(await requireProjectPermission(req, res, 'project:read'))) return;

      let envNames: string[];
      if (deps?.getDistinctEnvironments) {
        envNames = await deps.getDistinctEnvironments(tenantId, projectId);
      } else {
        const { Deployment } = await import('@agent-platform/database/models');
        envNames = await Deployment.distinct('environment', {
          tenantId,
          projectId,
        });
      }

      const environments = resolveEnvironments(envNames);

      res.json({
        success: true,
        data: { environments },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to list project environments', { error: message, requestId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list environments' },
      });
    }
  });

  return router;
}

const defaultRouter: ReturnType<typeof Router> = createProjectEnvironmentsRouter();
export default defaultRouter;
