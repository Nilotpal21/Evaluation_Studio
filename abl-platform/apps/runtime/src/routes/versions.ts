/**
 * Agent Versions API Routes
 *
 * Version lifecycle management: create, list, promote, diff.
 * Mounted at /api/projects/:projectId/agents/:agentName/versions
 *
 * POST /                            Create version from working copy
 * GET  /                            List versions
 * GET  /:version                    Get version detail
 * POST /:version/promote            Promote version status
 * GET  /:version/diff/:otherVersion Diff two versions
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { validateAgentName } from '@agent-platform/shared-kernel';
import { getVersionService, VersionService } from '../services/version-service.js';
import { findProjectAgentForProject, findProjectAgentsForProject } from '../repos/project-repo.js';
import { PROJECT_TOOL_TYPES, type IProjectAgent } from '@agent-platform/database/models';
import {
  auditVersionCreated,
  auditVersionPromoted,
  auditVersionDeprecated,
} from '../services/audit-helpers.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('versions-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/agents/:agentName/versions',
  tags: ['Versions'],
});
const router: RouterType = openapi.router;

// Middleware chain (authMiddleware already sets ALS via runWithTenantContext)
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// Validate agentName from parent route param
router.use((req, res, next) => {
  const agentName = (req.params as any).agentName;
  if (agentName) {
    const error = validateAgentName(agentName);
    if (error) {
      res.status(400).json({ success: false, error });
      return;
    }
  }
  next();
});

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const pathParams = z.object({
  projectId: z.string(),
  agentName: z.string(),
});

const versionPathParams = pathParams.extend({
  version: z.string(),
});

const diffPathParams = versionPathParams.extend({
  otherVersion: z.string(),
});

const createVersionBody = z.object({
  changelog: z.string().optional(),
});

const promoteVersionBody = z.object({
  targetStatus: z.enum(['draft', 'testing', 'staged', 'active', 'deprecated']),
});

const listVersionsQuery = z.object({
  limit: z.string().transform(Number).pipe(z.number().int().positive()).optional(),
  offset: z.string().transform(Number).pipe(z.number().int().nonnegative()).optional(),
});

const toolSnapshotEntry = z.object({
  name: z.string(),
  projectToolId: z.string(),
  sourceHash: z.string(),
  runtimeMetadataHash: z.string().optional(),
  toolType: z.enum(PROJECT_TOOL_TYPES),
  description: z.string().nullable(),
  dslContent: z.string(),
});

const versionRecord = z.object({
  versionId: z.string(),
  version: z.string(),
  status: z.string(),
  sourceHash: z.string(),
  dslContent: z.string().optional(),
  compiledIR: z.record(z.unknown()).optional(),
  changelog: z.string().optional(),
  toolSnapshot: z.array(toolSnapshotEntry).nullable().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});

const createVersionResponse = z.object({
  success: z.boolean(),
  versionId: z.string(),
  version: z.string(),
  sourceHash: z.string(),
  deduplicated: z.boolean().optional(),
  toolSnapshotRefresh: z
    .object({
      attempted: z.boolean(),
      matchedCount: z.number(),
      modifiedCount: z.number(),
      refreshed: z.boolean(),
    })
    .optional(),
  errors: z.array(z.string()).optional(),
  toolSnapshot: z.array(toolSnapshotEntry).nullable().optional(),
  warnings: z.array(z.string()).optional(),
});

const createVersionErrorResponse = z.object({
  success: z.boolean(),
  errors: z.array(z.string()).optional(),
  sourceHash: z.string().optional(),
});

const listVersionsResponse = z.object({
  success: z.boolean(),
  versions: z.array(versionRecord),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

const getVersionResponse = z.object({
  success: z.boolean(),
  version: versionRecord,
});

const promoteVersionResponse = z.object({
  success: z.boolean(),
  version: versionRecord.extend({
    previousStatus: z.string(),
  }),
});

const diffVersionsResponse = z.object({
  success: z.boolean(),
  diff: z.object({
    version1: z.string(),
    version2: z.string(),
    dslContent1: z.string(),
    dslContent2: z.string(),
  }),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/projects/:projectId/agents/:agentName/versions
 * Compile working copy DSL and create a new version.
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new version',
    description: 'Compile working copy DSL and create a new agent version with optional changelog',
    body: createVersionBody,
    response: createVersionResponse,
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'version:create'))) return;

      const { projectId, agentName } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const versionService = getVersionService();

      // Validate optional changelog
      const changelogError = VersionService.validateChangelog(req.body.changelog);
      if (changelogError) {
        res.status(400).json({ success: false, error: changelogError });
        return;
      }

      // Load working copy DSL from ProjectAgent (tenant-scoped at query level)
      const agent = await findProjectAgentForProject(projectId, agentName, tenantId, {
        includeTenantId: true,
      });
      if (!agent) {
        res.status(404).json({ success: false, error: 'Agent not found' });
        return;
      }
      if (!agent.dslContent) {
        res.status(400).json({ success: false, error: 'Agent has no DSL content to version' });
        return;
      }

      const allProjectAgents = await findProjectAgentsForProject(projectId, {
        tenantId,
        includeDSLContent: true,
      });
      const peerDsls = (allProjectAgents as Array<{ name?: string; dslContent?: string }>)
        .filter((candidate) => candidate.name !== agentName)
        .map((candidate) => candidate.dslContent)
        .filter((dsl): dsl is string => typeof dsl === 'string' && dsl.length > 0);

      // Validate DSL size
      const dslError = VersionService.validateDslContent(agent.dslContent);
      if (dslError) {
        res.status(400).json({ success: false, error: dslError });
        return;
      }

      const version = await versionService.nextVersion(projectId, agentName, tenantId);
      const result = await versionService.createVersion({
        projectId,
        agentName,
        dslContent: agent.dslContent,
        version,
        createdBy: req.tenantContext!.userId!,
        tenantId,
        changelog: req.body.changelog,
        peerDsls,
        libraryRef: (agent as unknown as IProjectAgent).systemPromptLibraryRef,
      });

      if (result.compileErrors) {
        res.status(422).json({
          success: false,
          errors: result.compileErrors,
          sourceHash: result.sourceHash,
        });
        return;
      }

      if (result.deduplicated) {
        res.status(200).json({
          success: true,
          versionId: result.versionId,
          version: result.version,
          sourceHash: result.sourceHash,
          deduplicated: true,
          toolSnapshotRefresh: result.toolSnapshotRefresh,
          toolSnapshot: result.toolSnapshot ?? null,
          warnings: result.warnings,
        });
        return;
      }

      auditVersionCreated(
        {
          projectId,
          agentName,
          version: result.version,
          versionId: result.versionId,
          sourceHash: result.sourceHash,
        },
        req.tenantContext!.userId!,
        tenantId,
      ).catch((err) =>
        log.warn('audit version created failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.status(201).json({
        success: true,
        versionId: result.versionId,
        version: result.version,
        sourceHash: result.sourceHash,
        toolSnapshot: result.toolSnapshot ?? null,
        warnings: result.warnings,
      });
    } catch (err) {
      log.error('Failed to create version', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to create version' });
    }
  },
);

/**
 * GET /api/projects/:projectId/agents/:agentName/versions
 * List all versions for an agent with pagination.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List versions',
    description: 'List all versions for an agent with pagination (query params: limit, offset)',
    query: listVersionsQuery,
    response: listVersionsResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'version:read'))) return;

      const { projectId, agentName } = req.params;
      const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const rawOffset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      // Validate query params are positive integers (NaN from parseInt → undefined)
      const limit =
        rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      const offset =
        rawOffset !== undefined && Number.isFinite(rawOffset) && rawOffset >= 0
          ? rawOffset
          : undefined;

      const result = await getVersionService().listVersions({
        projectId,
        agentName,
        tenantId: req.tenantContext!.tenantId,
        limit,
        offset,
      });

      const effectiveLimit = limit ?? 50;
      const effectiveOffset = offset ?? 0;
      res.set('Cache-Control', 'private, max-age=60');
      res.json({
        success: true,
        versions: result.versions,
        total: result.total,
        limit: effectiveLimit,
        offset: effectiveOffset,
        hasMore: effectiveOffset + result.versions.length < result.total,
      });
    } catch (err) {
      log.error('Failed to list versions', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to list versions' });
    }
  },
);

/**
 * GET /api/projects/:projectId/agents/:agentName/versions/tool-preview
 * Preview which tool versions will be baked into the next agent version.
 */
openapi.route(
  'get',
  '/tool-preview',
  {
    summary: 'Preview tool versions for next agent version',
    description: 'Returns which tool versions would be baked into a new agent version',
    params: pathParams,
    response: z.object({
      success: z.boolean(),
      tools: z.array(
        z.object({
          toolId: z.string(),
          toolName: z.string(),
          toolType: z.string(),
          draftOnly: z.boolean(),
          publishedVersion: z
            .object({
              versionId: z.string(),
              version: z.number(),
              versionName: z.string().nullable(),
            })
            .optional(),
        }),
      ),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'version:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const { findProjectToolsByProject } = await import('@agent-platform/shared/repos');

      const allToolsResult = await findProjectToolsByProject(tenantId, projectId, {
        limit: 500,
      });

      const tools = allToolsResult.data.map((tool: any) => ({
        toolId: tool.id ?? tool._id,
        toolName: tool.name,
        toolType: tool.toolType,
        draftOnly: false,
      }));

      res.json({ success: true, tools });
    } catch (err) {
      log.error('Failed to load tool preview', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to load tool preview' });
    }
  },
);

/**
 * GET /api/projects/:projectId/agents/:agentName/versions/:version
 * Get a specific version with full DSL + IR.
 */
openapi.route(
  'get',
  '/:version',
  {
    summary: 'Get version detail',
    description: 'Get a specific version with full DSL content and compiled IR',
    params: versionPathParams,
    response: getVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'version:read'))) return;

      const { projectId, agentName, version } = req.params;
      const record = await getVersionService().getVersion(
        projectId,
        agentName,
        version,
        req.tenantContext!.tenantId,
      );

      if (!record) {
        res.status(404).json({ success: false, error: 'Version not found' });
        return;
      }

      res.json({ success: true, version: record });
    } catch (err) {
      log.error('Failed to get version', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Failed to get version' });
    }
  },
);

/**
 * POST /api/projects/:projectId/agents/:agentName/versions/:version/promote
 * Promote a version to a new status.
 */
openapi.route(
  'post',
  '/:version/promote',
  {
    summary: 'Promote version',
    description: 'Promote a version to a new status (draft, testing, staged, active, deprecated)',
    params: versionPathParams,
    body: promoteVersionBody,
    response: promoteVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'version:promote'))) return;

      const { projectId, agentName, version } = req.params;
      const { targetStatus } = req.body;

      if (!targetStatus || typeof targetStatus !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required field: targetStatus' });
        return;
      }
      if (!VersionService.isValidStatus(targetStatus)) {
        res.status(400).json({
          success: false,
          error: `Invalid targetStatus. Must be one of: draft, testing, staged, active, deprecated`,
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const result = await getVersionService().promoteVersion({
        projectId,
        agentName,
        version,
        targetStatus,
        promotedBy: req.tenantContext!.userId!,
        tenantId,
      });

      auditVersionPromoted(
        {
          projectId,
          agentName,
          version,
          fromStatus: result.previousStatus,
          toStatus: targetStatus,
        },
        req.tenantContext!.userId!,
        tenantId,
      ).catch((err) =>
        log.warn('audit version promoted failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      // Additional audit for deprecation (compliance-relevant)
      if (targetStatus === 'deprecated') {
        auditVersionDeprecated(
          { projectId, agentName, version, deprecatedBy: req.tenantContext!.userId! },
          req.tenantContext!.userId!,
          tenantId,
        ).catch((err) =>
          log.warn('audit version deprecated failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      res.json({ success: true, version: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        res.status(404).json({ success: false, error: message });
      } else if (message.includes('Cannot transition')) {
        res.status(422).json({ success: false, error: message });
      } else if (message.includes('Concurrent modification')) {
        res.status(409).json({ success: false, error: message });
      } else {
        log.error('Failed to promote version', { error: message });
        res.status(500).json({ success: false, error: 'Failed to promote version' });
      }
    }
  },
);

/**
 * GET /api/projects/:projectId/agents/:agentName/versions/:version/diff/:otherVersion
 * Return DSL content for two versions (client-side diffing).
 */
openapi.route(
  'get',
  '/:version/diff/:otherVersion',
  {
    summary: 'Compare versions',
    description: 'Get DSL content for two versions to enable client-side diffing',
    params: diffPathParams,
    response: diffVersionsResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'version:read'))) return;

      const { projectId, agentName, version, otherVersion } = req.params;
      const diff = await getVersionService().diffVersions(
        projectId,
        agentName,
        version,
        otherVersion,
        req.tenantContext!.tenantId,
      );
      res.json({ success: true, diff });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        res.status(404).json({ success: false, error: message });
      } else {
        log.error('Failed to diff versions', { error: message });
        res.status(500).json({ success: false, error: 'Failed to diff versions' });
      }
    }
  },
);

export default router;
