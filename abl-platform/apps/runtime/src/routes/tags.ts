/**
 * Tags API Routes
 *
 * Mounted at /api/projects/:projectId/tags
 *
 * GET    /rules            List tag rules
 * POST   /rules            Create a tag rule
 * PUT    /rules/:ruleId    Update a tag rule
 * DELETE /rules/:ruleId    Delete a tag rule
 * POST   /apply            Apply tags to a session manually
 * GET    /conversations    List sessions by tag
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('tags-route');

// ─── Lazy imports ───────────────────────────────────────────────────────────

async function getTagRuleModel() {
  const { TagRuleModel } = await import('@agent-platform/pipeline-engine');
  return TagRuleModel;
}

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/tags',
  tags: ['Tags'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// ─── GET /rules ─────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/rules',
  {
    summary: 'List tag rules',
    description: 'Returns all tag rules for the current project.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;

      const Model = await getTagRuleModel();
      const rules = await Model.find({ tenantId, projectId }).lean();

      res.json({ success: true, data: rules });
    } catch (error) {
      log.error('Failed to list tag rules', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to list tag rules' });
    }
  },
);

// ─── POST /rules ────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/rules',
  {
    summary: 'Create a tag rule',
    description: 'Creates a new tag rule for automatic or manual conversation tagging.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const userId = req.tenantContext!.userId ?? 'unknown';

      const { tagName, conditions, description, color, conditionLogic, autoApply } = req.body;

      if (!tagName || typeof tagName !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'tagName is required and must be a string' },
        });
        return;
      }

      if (!Array.isArray(conditions) || conditions.length === 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'conditions is required and must be a non-empty array',
          },
        });
        return;
      }

      const Model = await getTagRuleModel();
      const rule = await Model.create({
        tenantId,
        projectId,
        tagName,
        conditions,
        description: description ?? undefined,
        color: color ?? undefined,
        conditionLogic: conditionLogic ?? 'AND',
        autoApply: autoApply ?? false,
        createdBy: userId,
      });

      log.info('Tag rule created', { tenantId, projectId, tagName, ruleId: rule._id });
      res.json({ success: true, data: rule.toObject() });
    } catch (error) {
      log.error('Failed to create tag rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to create tag rule' });
    }
  },
);

// ─── PUT /rules/:ruleId ────────────────────────────────────────────────────

openapi.route(
  'put',
  '/rules/:ruleId',
  {
    summary: 'Update a tag rule',
    description: 'Updates an existing tag rule by ID.',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, ruleId } = req.params;

      const Model = await getTagRuleModel();
      const updated = await Model.findOneAndUpdate(
        { _id: ruleId, tenantId, projectId },
        { $set: req.body },
        { new: true },
      );

      if (!updated) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Tag rule not found' },
        });
        return;
      }

      log.info('Tag rule updated', { tenantId, projectId, ruleId });
      res.json({ success: true, data: updated.toObject() });
    } catch (error) {
      log.error('Failed to update tag rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        ruleId: req.params.ruleId,
      });
      res.status(500).json({ success: false, error: 'Failed to update tag rule' });
    }
  },
);

// ─── DELETE /rules/:ruleId ─────────────────────────────────────────────────

openapi.route(
  'delete',
  '/rules/:ruleId',
  {
    summary: 'Delete a tag rule',
    description: 'Permanently deletes a tag rule by ID.',
    response: z.object({
      success: z.boolean(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'project:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, ruleId } = req.params;

      const Model = await getTagRuleModel();
      const deleted = await Model.findOneAndDelete({ _id: ruleId, tenantId, projectId });

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Tag rule not found' },
        });
        return;
      }

      log.info('Tag rule deleted', { tenantId, projectId, ruleId });
      res.json({ success: true });
    } catch (error) {
      log.error('Failed to delete tag rule', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        ruleId: req.params.ruleId,
      });
      res.status(500).json({ success: false, error: 'Failed to delete tag rule' });
    }
  },
);

// ─── POST /apply ────────────────────────────────────────────────────────────

openapi.route(
  'post',
  '/apply',
  {
    summary: 'Apply tags to a session manually',
    description:
      'Inserts one or more tags for a conversation session into the analytics store with applied_by set to the current user.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        applied: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:write'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const userId = req.tenantContext!.userId ?? 'unknown';

      const { sessionId, tags } = req.body;

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'sessionId is required and must be a string' },
        });
        return;
      }

      if (
        !Array.isArray(tags) ||
        tags.length === 0 ||
        !tags.every((t: unknown) => typeof t === 'string')
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'tags is required and must be a non-empty array of strings',
          },
        });
        return;
      }

      const rows = tags.map((tagName: string) => ({
        tenant_id: tenantId,
        project_id: projectId,
        session_id: sessionId,
        tag_name: tagName,
        applied_by: userId,
        rule_id: 'manual',
      }));

      const ch = await getClickHouse();
      await ch.insert({
        table: 'abl_platform.conversation_tags',
        values: rows,
        format: 'JSONEachRow',
      });

      log.info('Tags applied manually', {
        tenantId,
        projectId,
        sessionId,
        tagCount: tags.length,
      });
      res.json({ success: true, data: { applied: tags.length } });
    } catch (error) {
      log.error('Failed to apply tags', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to apply tags' });
    }
  },
);

// ─── GET /conversations ─────────────────────────────────────────────────────

openapi.route(
  'get',
  '/conversations',
  {
    summary: 'List sessions by tag',
    description:
      'Returns conversation sessions that have been tagged with a specific tag name, ordered by most recent first.',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const tag = req.query.tag as string;
      const limit = Math.min(Number(req.query.limit) || 50, 200);

      if (!tag) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'tag query parameter is required' },
        });
        return;
      }

      const ch = await getClickHouse();

      const query = `
        SELECT
          session_id,
          tag_name,
          applied_at,
          applied_by
        FROM abl_platform.conversation_tags
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND tag_name = {tag:String}
        ORDER BY applied_at DESC
        LIMIT {limit:UInt32}
        SETTINGS max_execution_time = 10
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, tag, limit: limit.toString() },
      });
      const data = (await result.json()) as unknown as Record<string, unknown>[];

      res.json({ success: true, data });
    } catch (error) {
      log.error('Failed to query conversations by tag', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to query conversations by tag' });
    }
  },
);

export default openapi.router;
