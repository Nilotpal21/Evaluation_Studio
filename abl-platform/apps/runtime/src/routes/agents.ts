/**
 * Agent Discovery REST API
 *
 * Exposes agent listing and details from the database.
 * All agents must be seeded/created in the database — no filesystem access.
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { isDatabaseAvailable } from '../db/index.js';
import { findProjectAgentsWithTenant, findProjectAgentByName } from '../repos/project-repo.js';
import { getCurrentTenantId } from '@agent-platform/shared-auth/middleware';
import { buildAgentDetails } from '../services/dsl-utils.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/agents',
  tags: ['Agents'],
  validateRequests: true,
  wrapAsyncHandlers: true,
});
const router: RouterType = openapi.router;

// All agent routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const agentMetadataSchema = z.object({
  id: z.string().describe('Agent ID'),
  name: z.string().describe('Agent name'),
});

const listAgentsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  total: z.number().describe('Total number of agents'),
  agents: z.array(agentMetadataSchema).describe('List of agents'),
});

const agentDetailsSchema = z.object({
  id: z.string().describe('Agent ID'),
  name: z.string().describe('Agent name'),
  dslContent: z.string().describe('Agent DSL source code'),
});

const getAgentDetailsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  agent: agentDetailsSchema.describe('Full agent details and compiled specification'),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/agents — List all agents from database
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List agents',
    description: 'List all agents from the database. Requires authentication.',
    response: listAgentsResponseSchema,
  },
  async (_req, res) => {
    if (!isDatabaseAvailable()) {
      res.status(503).json({ success: false, error: 'Database not available' });
      return;
    }

    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }

      const agents = await findProjectAgentsWithTenant({ tenantId });

      res.json({
        success: true,
        total: agents.length,
        agents,
      });
    } catch (error) {
      console.error('Error listing agents:', error);
      res.status(500).json({ success: false, error: 'Failed to list agents' });
    }
  },
);

/**
 * GET /api/agents/:name — Get agent details from database
 */
openapi.route(
  'get',
  '/:name',
  {
    summary: 'Get agent details',
    description:
      'Get full agent details and compiled specification by name. Requires authentication.',
    params: z.object({
      name: z.string().describe('Agent name'),
    }),
    query: z.object({
      projectId: z.string().min(1).describe('Project ID').optional(),
    }),
    response: getAgentDetailsResponseSchema,
  },
  async (req, res) => {
    if (!isDatabaseAvailable()) {
      res.status(503).json({ success: false, error: 'Database not available' });
      return;
    }

    try {
      const tenantId = getCurrentTenantId();
      if (!tenantId) {
        res.status(403).json({ success: false, error: 'Tenant context required' });
        return;
      }
      const validatedParams = getValidatedRequestData(res)?.params as { name: string } | undefined;
      const validatedQuery = getValidatedRequestData(res)?.query as
        | { projectId?: string }
        | undefined;
      const name = validatedParams?.name ?? req.params.name;
      const projectId =
        validatedQuery?.projectId ??
        (typeof req.query.projectId === 'string' ? req.query.projectId : undefined);

      if (!projectId) {
        res.status(400).json({
          success: false,
          error: 'projectId query parameter is required for agent detail lookup',
        });
        return;
      }

      const record = await findProjectAgentByName(name, { tenantId, projectId });

      if (!record?.dslContent) {
        res.status(404).json({ success: false, error: `Agent not found: ${name}` });
        return;
      }

      const agent = buildAgentDetails(record.dslContent, record.name);
      if (!agent) {
        res.status(500).json({ success: false, error: 'Failed to compile agent DSL' });
        return;
      }

      // Agent details are relatively static — cache with ETag from sourceHash
      res.set('Cache-Control', 'private, max-age=300');
      res.json({ success: true, agent });
    } catch (error) {
      console.error('Error loading agent:', error);
      res.status(500).json({ success: false, error: 'Failed to load agent' });
    }
  },
);

export default openapi.router;
