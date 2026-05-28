/**
 * Workflow Version API Routes
 *
 * Version lifecycle management: create, list, activate, deactivate, update, diff.
 * Mounted at /api/projects/:projectId/workflows/:workflowId/versions
 *
 * POST /                            Create version from working copy
 * GET  /                            List versions
 * GET  /:version                    Get version detail
 * POST /:version/activate           Activate a published version
 * POST /:version/deactivate         Deactivate a published version
 * DELETE /:version                  Soft-delete a workflow version
 * PATCH /:version                   Update mutable version fields
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
import {
  getWorkflowVersionService,
  WorkflowVersionService,
} from '../services/workflow-version-service.js';
import {
  auditWorkflowVersionActivated,
  auditWorkflowVersionDeactivated,
  auditWorkflowVersionDeleted,
} from '../services/audit-helpers.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-versions-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/workflows/:workflowId/versions',
  tags: ['Workflow Versions'],
});
const router: RouterType = openapi.router;

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const pathParams = z.object({
  projectId: z.string().min(1),
  workflowId: z.string().min(1),
});

const versionPathParams = pathParams.extend({
  version: z.string().min(1),
});

const diffPathParams = versionPathParams.extend({
  otherVersion: z.string().min(1),
});

const createVersionBody = z.object({
  changelog: z.string().optional(),
});

const updateVersionBody = z.object({
  definition: z
    .object({
      nodes: z.array(z.record(z.unknown())).optional(),
      edges: z.array(z.record(z.unknown())).optional(),
      envVars: z.record(z.string()).optional(),
      inputSchema: z.record(z.unknown()).nullable().optional(),
      outputSchema: z.record(z.unknown()).nullable().optional(),
    })
    .optional(),
  triggers: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
  changelog: z.string().optional(),
  environment: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listVersionsQuery = z.object({
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(200)).optional(),
  offset: z.string().transform(Number).pipe(z.number().int().nonnegative()).optional(),
});

const versionRecord = z.object({
  versionId: z.string(),
  version: z.string(),
  state: z.string().optional(),
  sourceHash: z.string(),
  definition: z.record(z.unknown()).optional(),
  triggers: z.array(z.record(z.unknown())).optional(),
  environment: z.string().nullable().optional(),
  deploymentId: z.string().nullable().optional(),
  deleted: z.boolean().optional(),
  changelog: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  publishedBy: z.string().nullable().optional(),
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

const activateVersionResponse = z.object({
  success: z.boolean(),
  version: z.record(z.unknown()),
});

const deactivateVersionResponse = z.object({
  success: z.boolean(),
  version: z.record(z.unknown()),
});

const deleteVersionResponse = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  message: z.string().describe('Confirmation message'),
});

const updateVersionResponse = z.object({
  success: z.boolean(),
  version: z.record(z.unknown()),
});

const diffVersionsResponse = z.object({
  success: z.boolean(),
  diff: z.object({
    version1: z.string(),
    version2: z.string(),
    definition1: z.record(z.unknown()),
    definition2: z.record(z.unknown()),
  }),
});

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /api/projects/:projectId/workflows/:workflowId/versions
 * Snapshot working copy definition and create a new workflow version.
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new workflow version',
    description: 'Snapshot working copy workflow definition and create a new version',
    body: createVersionBody,
    response: createVersionResponse,
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;

      const { projectId, workflowId } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const svc = getWorkflowVersionService();

      // Validate optional changelog
      const changelogError = WorkflowVersionService.validateChangelog(req.body.changelog);
      if (changelogError) {
        res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: changelogError },
        });
        return;
      }

      const result = await svc.createVersion({
        workflowId,
        projectId,
        tenantId,
        createdBy: req.tenantContext!.userId!,
        changelog: req.body.changelog,
      });

      if (result.deduplicated) {
        res.status(200).json({
          success: true,
          versionId: result.versionId,
          version: result.version,
          sourceHash: result.sourceHash,
          deduplicated: true,
        });
        return;
      }

      res.status(201).json({
        success: true,
        versionId: result.versionId,
        version: result.version,
        sourceHash: result.sourceHash,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code;
      if (message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message },
        });
      } else if (code === 'CONFLICT' || message.includes('collision')) {
        res.status(409).json({
          success: false,
          error: {
            code: 'VERSION_COLLISION',
            message: 'Version name collision — please retry',
          },
        });
      } else {
        log.error('Failed to create workflow version', { error: message });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create workflow version' },
        });
      }
    }
  },
);

/**
 * GET /api/projects/:projectId/workflows/:workflowId/versions
 * List all versions for a workflow with pagination.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List workflow versions',
    description: 'List all versions for a workflow with pagination',
    query: listVersionsQuery,
    response: listVersionsResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;

      const { projectId, workflowId } = req.params;
      const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const rawOffset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const limit =
        rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      const offset =
        rawOffset !== undefined && Number.isFinite(rawOffset) && rawOffset >= 0
          ? rawOffset
          : undefined;

      const result = await getWorkflowVersionService().listVersions({
        workflowId,
        tenantId: req.tenantContext!.tenantId,
        projectId,
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
      log.error('Failed to list workflow versions', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list workflow versions' },
      });
    }
  },
);

/**
 * GET /api/projects/:projectId/workflows/:workflowId/versions/:version
 * Get a specific workflow version with full definition.
 */
openapi.route(
  'get',
  '/:version',
  {
    summary: 'Get workflow version detail',
    description: 'Get a specific workflow version with full definition',
    params: versionPathParams,
    response: getVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;

      const { projectId, workflowId, version } = req.params;
      const record = await getWorkflowVersionService().getVersion(
        workflowId,
        version,
        req.tenantContext!.tenantId,
        projectId,
      );

      if (!record) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'Workflow version not found' },
        });
        return;
      }

      res.json({ success: true, version: record });
    } catch (err) {
      log.error('Failed to get workflow version', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get workflow version' },
      });
    }
  },
);

/**
 * POST /api/projects/:projectId/workflows/:workflowId/versions/:version/activate
 * Activate a published workflow version.
 */
openapi.route(
  'post',
  '/:version/activate',
  {
    summary: 'Activate workflow version',
    description: 'Activate a published workflow version (creates trigger registrations)',
    params: versionPathParams,
    response: activateVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;

      const { projectId, workflowId, version } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId!;
      const svc = getWorkflowVersionService();

      const updatedDoc = await svc.activate({
        tenantId,
        projectId,
        workflowId,
        version,
        activatedBy: userId,
      });

      // Fire-and-forget audit
      auditWorkflowVersionActivated(
        {
          tenantId,
          projectId,
          workflowId,
          workflowVersion: version,
          versionId: String((updatedDoc as unknown as { _id: string })._id),
        },
        userId,
      ).catch((err) =>
        log.warn('audit workflow version activated failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, version: updatedDoc });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? ((err as { code?: string }).code ?? '') : '';

      if (code === 'DRAFT_ALWAYS_ACTIVE') {
        res.status(400).json({
          success: false,
          error: { code: 'DRAFT_ALWAYS_ACTIVE', message },
        });
      } else if (code === 'NOT_FOUND' || message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message },
        });
      } else if (code === 'CONFLICT' || message.includes('Concurrent modification')) {
        res.status(409).json({
          success: false,
          error: { code: 'CONCURRENT_MODIFICATION', message },
        });
      } else {
        log.error('Failed to activate workflow version', { error: message });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to activate workflow version' },
        });
      }
    }
  },
);

/**
 * POST /api/projects/:projectId/workflows/:workflowId/versions/:version/deactivate
 * Deactivate a published workflow version.
 */
openapi.route(
  'post',
  '/:version/deactivate',
  {
    summary: 'Deactivate workflow version',
    description: 'Deactivate a published workflow version (removes trigger registrations)',
    params: versionPathParams,
    response: deactivateVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;

      const { projectId, workflowId, version } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId!;
      const svc = getWorkflowVersionService();

      const updatedDoc = await svc.deactivate({
        tenantId,
        projectId,
        workflowId,
        version,
      });

      // Fire-and-forget audit
      auditWorkflowVersionDeactivated(
        {
          tenantId,
          projectId,
          workflowId,
          workflowVersion: version,
          versionId: String((updatedDoc as unknown as { _id: string })._id),
        },
        userId,
      ).catch((err) =>
        log.warn('audit workflow version deactivated failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, version: updatedDoc });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? ((err as { code?: string }).code ?? '') : '';

      if (code === 'DRAFT_ALWAYS_ACTIVE') {
        res.status(400).json({
          success: false,
          error: { code: 'DRAFT_ALWAYS_ACTIVE', message },
        });
      } else if (code === 'NOT_FOUND' || message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message },
        });
      } else if (code === 'CONFLICT' || message.includes('Concurrent modification')) {
        res.status(409).json({
          success: false,
          error: { code: 'CONCURRENT_MODIFICATION', message },
        });
      } else {
        log.error('Failed to deactivate workflow version', { error: message });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to deactivate workflow version' },
        });
      }
    }
  },
);

/**
 * DELETE /api/projects/:projectId/workflows/:workflowId/versions/:version
 * Soft-delete a workflow version.
 */
openapi.route(
  'delete',
  '/:version',
  {
    summary: 'Delete workflow version',
    description:
      'Soft-delete a workflow version. Draft versions and deployed versions cannot be deleted. Active versions are deactivated first.',
    params: versionPathParams,
    response: deleteVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:delete'))) return;

      const { projectId, workflowId, version } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId!;
      const svc = getWorkflowVersionService();

      await svc.softDeleteVersion({
        tenantId,
        projectId,
        workflowId,
        version,
        userId,
      });

      // Fire-and-forget audit
      auditWorkflowVersionDeleted(
        {
          tenantId,
          projectId,
          workflowId,
          workflowVersion: version,
          versionId: '',
        },
        userId,
      ).catch((err) =>
        log.warn('audit workflow version deleted failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, message: `Version ${version} deleted` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? ((err as { code?: string }).code ?? '') : '';

      if (code === 'DRAFT_CANNOT_DELETE') {
        res.status(409).json({
          success: false,
          error: { code: 'DRAFT_CANNOT_DELETE', message },
        });
      } else if (code === 'VERSION_DEPLOYED') {
        res.status(409).json({
          success: false,
          error: { code: 'VERSION_DEPLOYED', message },
        });
      } else if (code === 'NOT_FOUND' || message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message },
        });
      } else if (code === 'CONFLICT' || message.includes('Concurrent modification')) {
        res.status(409).json({
          success: false,
          error: { code: 'CONCURRENT_MODIFICATION', message },
        });
      } else {
        log.error('Failed to delete workflow version', { error: message });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete workflow version' },
        });
      }
    }
  },
);

/**
 * PATCH /api/projects/:projectId/workflows/:workflowId/versions/:version
 * Update mutable fields on a workflow version.
 */
openapi.route(
  'patch',
  '/:version',
  {
    summary: 'Update workflow version fields',
    description:
      'Update mutable fields on a workflow version. Draft versions allow all fields; published versions freeze definition structure.',
    params: versionPathParams,
    body: updateVersionBody,
    response: updateVersionResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;

      const { projectId, workflowId, version } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      const { WorkflowVersion, Workflow } = await import('@agent-platform/database/models');

      // Load current version. For drafts, lazily materialize from the Workflow
      // document so updates succeed even when a draft row was never written
      // (workflow predates the draft-versions feature, or the non-fatal create
      // in POST /workflows silently failed). Matches the safety-net pattern
      // used elsewhere in the service.
      let existing: Record<string, unknown> | null;
      if (version === 'draft') {
        existing = (await getWorkflowVersionService().getOrCreateDraft(
          workflowId,
          tenantId,
          projectId,
          req.tenantContext!.userId ?? '',
        )) as Record<string, unknown>;
      } else {
        existing = (await WorkflowVersion.findOne({
          workflowId,
          version,
          tenantId,
          projectId,
          deleted: false,
        }).lean()) as Record<string, unknown> | null;
      }

      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'Workflow version not found' },
        });
        return;
      }

      // Validate mutable fields
      const validation = WorkflowVersionService.validateMutableFields(
        { version, state: existing.state as string | undefined },
        req.body,
      );
      if (!validation.allowed) {
        res.status(400).json({
          success: false,
          error: {
            code: 'FIELD_FROZEN',
            message: `Cannot modify frozen fields on published version: ${validation.frozenFields?.join(', ')}`,
          },
        });
        return;
      }

      // Build $set payload
      const $set: Record<string, unknown> = {};
      const body = req.body;

      if (body.definition !== undefined) {
        if (body.definition.nodes !== undefined) $set['definition.nodes'] = body.definition.nodes;
        if (body.definition.edges !== undefined) $set['definition.edges'] = body.definition.edges;
        if (body.definition.envVars !== undefined)
          $set['definition.envVars'] = body.definition.envVars;
        if (body.definition.inputSchema !== undefined)
          $set['definition.inputSchema'] = body.definition.inputSchema;
        if (body.definition.outputSchema !== undefined)
          $set['definition.outputSchema'] = body.definition.outputSchema;
      }
      if (body.triggers !== undefined) $set.triggers = body.triggers;
      if (body.changelog !== undefined) $set.changelog = body.changelog;
      if (body.environment !== undefined) $set.environment = body.environment;
      if (body.metadata !== undefined) $set.metadata = body.metadata;

      if (Object.keys($set).length === 0) {
        res.json({ success: true, version: existing });
        return;
      }

      const updated = await WorkflowVersion.findOneAndUpdate(
        { _id: existing._id, tenantId },
        { $set },
        { new: true },
      ).lean();

      if (!updated) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'Workflow version not found after update' },
        });
        return;
      }

      // LD-10: Sync draft version fields back to Workflow document for Phase 1 backward compat.
      // inputSchema/outputSchema need to sync too — they're the contract surfaces
      // consumed by curl snippets, the Fire Now modal, and OpenAPI export via the
      // Workflow doc (not the draft version row). Without this sync they
      // silently stay null on the workflow and downstream surfaces fall back
      // to empty examples.
      if (version === 'draft') {
        const syncSet: Record<string, unknown> = {};
        if (body.definition?.nodes !== undefined) syncSet.nodes = body.definition.nodes;
        if (body.definition?.edges !== undefined) syncSet.edges = body.definition.edges;
        if (body.definition?.envVars !== undefined) syncSet.envVars = body.definition.envVars;
        if (body.definition?.inputSchema !== undefined)
          syncSet.inputSchema = body.definition.inputSchema;
        if (body.definition?.outputSchema !== undefined)
          syncSet.outputSchema = body.definition.outputSchema;

        if (Object.keys(syncSet).length > 0) {
          // Use the raw MongoDB collection instead of Mongoose's
          // `findOneAndUpdate` so the synced nodes/edges arrive at the
          // Workflow doc exactly as they were written to the draft version
          // row. Mongoose's subdocument processing for `WorkflowNodeSchema`
          // strips node-level `config: {}` (matching the Mixed-with-default
          // combination) while the draft version's `[Mixed]` array preserves
          // it, which produced a visible round-trip drift: a node saved
          // with an empty config (e.g. a freshly added End node) would
          // come back from GET /:id without a `config` key at all. The
          // back-sync is fire-and-forget with no hook dependencies, so
          // skipping the Mongoose subdoc pipeline is safe here — Mongoose
          // still owns the draft-row write above, which is where
          // validation actually matters.
          Workflow.collection
            .updateOne({ _id: workflowId, tenantId, projectId }, { $set: syncSet })
            .catch((err: unknown) =>
              log.warn('Failed to sync draft to workflow document', {
                error: err instanceof Error ? err.message : String(err),
                workflowId,
              }),
            );
        }
      }

      res.json({ success: true, version: updated });
    } catch (err) {
      log.error('Failed to update workflow version', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update workflow version' },
      });
    }
  },
);

/**
 * GET /api/projects/:projectId/workflows/:workflowId/versions/:version/diff/:otherVersion
 * Return definitions for two versions (client-side diffing).
 */
openapi.route(
  'get',
  '/:version/diff/:otherVersion',
  {
    summary: 'Compare workflow versions',
    description: 'Get definitions for two workflow versions to enable client-side diffing',
    params: diffPathParams,
    response: diffVersionsResponse,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;

      const { projectId, workflowId, version, otherVersion } = req.params;
      const { a, b } = await getWorkflowVersionService().diffVersions(
        workflowId,
        version,
        otherVersion,
        req.tenantContext!.tenantId,
        projectId,
      );

      res.json({
        success: true,
        diff: {
          version1: (a as Record<string, unknown>).version as string,
          version2: (b as Record<string, unknown>).version as string,
          definition1: (a as Record<string, unknown>).definition as Record<string, unknown>,
          definition2: (b as Record<string, unknown>).definition as Record<string, unknown>,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message },
        });
      } else {
        log.error('Failed to diff workflow versions', { error: message });
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to diff workflow versions' },
        });
      }
    }
  },
);

export default router;
