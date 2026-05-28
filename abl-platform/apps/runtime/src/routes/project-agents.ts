/**
 * Project Agents API Routes
 *
 * Project-scoped agent management (distinct from filesystem-based agents.ts).
 * Mounted at /api/projects/:projectId/agents
 *
 * GET /                 List agents in project
 * GET /:agentName       Get agent detail + version count
 * PUT /:agentName/dsl   Save working copy (no compilation)
 */

import { type Router as RouterType, type Request, type Response } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { validateAgentName } from '@agent-platform/shared-kernel';
import { validateProjectAgentDraftDeclaredName } from '@agent-platform/project-io';
import {
  findProjectAgentsForProject,
  findProjectAgentForProject,
  updateProjectAgentDsl,
} from '../repos/project-repo.js';
import { VersionService, safeParseJSON } from '../services/version-service.js';
import { auditDslUpdated } from '../services/audit-helpers.js';
import { createLogger } from '@abl/compiler/platform';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/agents',
  tags: ['Project Agents'],
});
const router: RouterType = openapi.router;
const log = createLogger('project-agents-route');

// Middleware chain (authMiddleware already sets ALS via runWithTenantContext)
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const projectIdParamSchema = z.object({
  projectId: z.string().min(1),
});

const agentNameParamSchema = z.object({
  projectId: z.string().min(1),
  agentName: z.string(),
});

const agentDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentPath: z.string(),
  description: z.string().nullable(),
  dslContent: z.string().nullable().optional(),
  versionCount: z.number().int().nonnegative(),
  activeVersions: z.record(z.unknown()).optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

const agentListResponseSchema = z.object({
  success: z.literal(true),
  agents: z.array(agentDetailSchema),
});

const agentDetailResponseSchema = z.object({
  success: z.literal(true),
  agent: agentDetailSchema,
});

const updateDslRequestSchema = z.object({
  dslContent: z.string().min(1, 'DSL content cannot be empty'),
});

const updateDslResponseSchema = z.object({
  success: z.literal(true),
  updatedAt: z.date().optional(),
});

// =============================================================================
// PARAM VALIDATION HELPER
// =============================================================================

function validateAgentNameParam(value: string): string | null {
  return validateAgentName(value);
}

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * GET /api/projects/:projectId/agents
 * List all agents in a project (tenant-scoped).
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List project agents',
    description: 'List all agents in a project (tenant-scoped)',
    params: projectIdParamSchema,
    response: agentListResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'agent:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const agents = await findProjectAgentsForProject(projectId, { tenantId });

      res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
      res.json({
        success: true,
        agents: agents.map((a: any) => ({
          id: a.id,
          name: a.name,
          agentPath: a.agentPath,
          description: a.description,
          versionCount: a.versionCount ?? a._count?.versions ?? 0,
          activeVersions: safeParseJSON(a.activeVersions, {}),
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
      });
    } catch (err) {
      log.error('Failed to list agents', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to list agents' });
    }
  },
);

/**
 * GET /api/projects/:projectId/agents/:agentName
 * Get a single agent with version count (tenant-scoped).
 */
openapi.route(
  'get',
  '/:agentName',
  {
    summary: 'Get project agent details',
    description: 'Get a single agent with version count (tenant-scoped)',
    params: agentNameParamSchema,
    response: agentDetailResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'agent:read'))) return;

      const { projectId, agentName } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Validate agent name param
      const nameError = validateAgentNameParam(agentName);
      if (nameError) {
        res.status(400).json({ success: false, error: nameError });
        return;
      }

      const agent = await findProjectAgentForProject(projectId, agentName, tenantId, {
        includeVersionCount: true,
      });

      if (!agent) {
        res.status(404).json({ success: false, error: 'Agent not found' });
        return;
      }

      res.json({
        success: true,
        agent: {
          id: (agent as any).id ?? (agent as any)._id,
          name: agent.name,
          agentPath: agent.agentPath,
          description: agent.description,
          dslContent: agent.dslContent,
          versionCount: (agent as any).versionCount ?? (agent as any)._count?.versions ?? 0,
          activeVersions: safeParseJSON(agent.activeVersions, {}),
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        },
      });
    } catch (err) {
      log.error('Failed to get agent', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ success: false, error: 'Failed to get agent' });
    }
  },
);

/**
 * PUT /api/projects/:projectId/agents/:agentName/dsl
 * Save working copy DSL content (mutable, no compilation). Tenant-scoped + write access.
 */
openapi.route(
  'put',
  '/:agentName/dsl',
  {
    summary: 'Update agent DSL',
    description: 'Save working copy DSL content (mutable, no compilation). Requires write access.',
    params: agentNameParamSchema,
    body: updateDslRequestSchema,
    response: updateDslResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'agent:update'))) return;

      const { projectId, agentName } = req.params;
      const result = updateDslRequestSchema.safeParse(req.body);

      if (!result.success) {
        res
          .status(400)
          .json({ success: false, error: 'Invalid request', details: result.error.issues });
        return;
      }

      const { dslContent } = result.data;
      const tenantId = req.tenantContext!.tenantId;

      // Validate agent name param
      const nameError = validateAgentNameParam(agentName);
      if (nameError) {
        res.status(400).json({ success: false, error: nameError });
        return;
      }

      // Validate input
      const dslError = VersionService.validateDslContent(dslContent);
      if (dslError) {
        res.status(400).json({ success: false, error: dslError });
        return;
      }

      // Tenant-scoped lookup
      const agent = await findProjectAgentForProject(projectId, agentName, tenantId);

      if (!agent) {
        res.status(404).json({ success: false, error: 'Agent not found' });
        return;
      }

      const declaredNameValidation = validateProjectAgentDraftDeclaredName({
        recordName: agent.name,
        dslContent,
      });
      if (!declaredNameValidation.ok) {
        res.status(409).json({
          success: false,
          error: declaredNameValidation.message,
          code: declaredNameValidation.code,
          recordName: declaredNameValidation.recordName,
          declaredName: declaredNameValidation.declaredName,
        });
        return;
      }

      // Capture previous content hash for audit trail
      const { createHash } = await import('crypto');
      const previousContentHash = agent.dslContent
        ? createHash('sha256').update(agent.dslContent).digest('hex').substring(0, 16)
        : undefined;

      const updated = await updateProjectAgentDsl(
        (agent as any).id ?? (agent as any)._id,
        dslContent,
        tenantId,
      );

      if (!updated) {
        res.status(500).json({ success: false, error: 'Failed to update agent' });
        return;
      }

      auditDslUpdated(
        { projectId, agentName, previousContentHash },
        req.tenantContext!.userId!,
        tenantId,
      ).catch((err) =>
        log.warn('audit DSL updated failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, updatedAt: updated.updatedAt });
    } catch (err) {
      log.error('Failed to update DSL', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to update DSL' });
    }
  },
);

export default openapi.router;
