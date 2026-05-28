/**
 * WorkflowDefinition CRUD API Routes (Project-Scoped)
 *
 * POST   /api/projects/:projectId/workflows                     Create workflow
 * GET    /api/projects/:projectId/workflows                     Query workflows
 * GET    /api/projects/:projectId/workflows/by-name             Get by name
 * GET    /api/projects/:projectId/workflows/:id                 Get by ID
 * PUT    /api/projects/:projectId/workflows/:id                 Update workflow
 * POST   /api/projects/:projectId/workflows/:id/archive         Archive workflow
 * POST   /api/projects/:projectId/workflows/:id/associate-session  Link to session
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { getStores } from '../services/stores/store-factory.js';
import { countSessions } from '../repos/session-repo.js';
import {
  auditWorkflowCreated,
  auditWorkflowUpdated,
  auditWorkflowArchived,
  auditWorkflowDeleted,
} from '../services/audit-helpers.js';
import { createLogger } from '@abl/compiler/platform';
import { WORKFLOW_STATUSES } from '@agent-platform/shared-kernel';
import {
  denormalizeSteps,
  validateWorkflowDag,
  WorkflowValidationError,
} from './workflow-helpers.js';
import { TriggerRegistration, ProjectTool } from '@agent-platform/database/models';
import { parseDslProperties } from '@agent-platform/shared/tools';
import { decryptForTenantAuto, encryptForTenantAuto } from '@agent-platform/shared/encryption';

const log = createLogger('workflows-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/workflows',
  tags: ['Workflows'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (error, _req, res) => {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        issues: error.issues,
      },
    });
  },
});
const router: RouterType = openapi.router;

// Middleware chain (authMiddleware already sets ALS via runWithTenantContext)
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// NOTE: Paths like /triggers, /connectors, /approvals are handled by the
// workflow-engine-proxy router (mounted after this CRUD router in server.ts).
// GET requests to these paths may be caught by the generic GET /:id route below.
// POST/DELETE/PUT requests work because no CRUD route matches those path+method combos.
// TODO: Fix Express route ordering to allow GET /triggers to pass through to engine proxy.

// Store accessors — delegate to the store factory
function getWorkflowStore() {
  return getStores().workflowDefinition;
}
function getConversationStore() {
  return getStores().conversation;
}

// =============================================================================
// Usage helpers — enrich list responses and the detail /usage endpoint with
// the two counts the UI cares about: how many triggers fire this workflow,
// and how many `type: workflow` project tools wrap it (Phase 1 of the
// "Agents using this workflow" story — agent-walk is Phase 2).
// =============================================================================

/**
 * Describe a single tool that wraps this workflow. The detail page renders
 * these as clickable chips; the list page only cares about the count.
 */
interface WorkflowToolUsage {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

interface WorkflowUsage {
  triggerCount: number;
  toolCount: number;
  tools: WorkflowToolUsage[];
}

/**
 * Load usage counts for a batch of workflow IDs within one project. Runs
 * two queries (triggers + workflow-type tools) and folds the results into
 * a map so callers can enrich list responses in O(1) per workflow.
 */
async function loadUsageForWorkflows(
  tenantId: string,
  projectId: string,
  workflowIds: string[],
): Promise<Map<string, WorkflowUsage>> {
  const out = new Map<string, WorkflowUsage>();
  for (const id of workflowIds) out.set(id, { triggerCount: 0, toolCount: 0, tools: [] });
  if (workflowIds.length === 0) return out;

  const [triggerDocs, toolDocs] = await Promise.all([
    TriggerRegistration.find({
      tenantId,
      projectId,
      workflowId: { $in: workflowIds },
      status: { $ne: 'deleted' },
    })
      .select('workflowId')
      .lean(),
    ProjectTool.find({ tenantId, projectId, toolType: 'workflow' }).lean(),
  ]);

  for (const t of triggerDocs) {
    const entry = out.get((t as { workflowId?: string }).workflowId ?? '');
    if (entry) entry.triggerCount += 1;
  }

  // Tools encode their target workflow in DSL as `workflow_id: <value>`.
  // Parse once per tool and bucket by workflowId so each list load only
  // pays the DSL-parse cost once per tool in the project.
  for (const t of toolDocs) {
    const tool = t as {
      _id: string;
      name: string;
      slug: string;
      description: string | null;
      dslContent: string;
    };
    let workflowIdFromDsl: string | undefined;
    try {
      const props = parseDslProperties(tool.dslContent);
      workflowIdFromDsl = props.workflow_id;
    } catch {
      // Malformed tool DSL — skip; it won't count toward any workflow's usage.
      continue;
    }
    if (!workflowIdFromDsl) continue;
    const entry = out.get(workflowIdFromDsl);
    if (!entry) continue;
    entry.toolCount += 1;
    entry.tools.push({
      id: tool._id,
      name: tool.name,
      slug: tool.slug,
      description: tool.description ?? null,
    });
  }

  return out;
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const workflowTypeSchema = z
  .enum(['cx_automation', 'ex_automation', 'internal'])
  .describe(
    'Workflow type: cx_automation (customer experience), ex_automation (employee experience), or internal',
  );

const workflowStatusSchema = z.enum(WORKFLOW_STATUSES).describe('Workflow status');

const workflowStepSchema = z
  .record(z.unknown())
  .describe('Workflow step configuration (structure varies by workflow type)');

const workflowTriggerSchema = z.record(z.unknown()).describe('Workflow trigger configuration');

const workflowEscalationRuleSchema = z
  .record(z.unknown())
  .describe('Escalation rule configuration');

const workflowDefinitionSchema = z.object({
  id: z.string().describe('Unique workflow definition ID'),
  tenantId: z.string().describe('Tenant ID'),
  projectId: z.string().describe('Project ID'),
  name: z.string().describe('Workflow name'),
  type: workflowTypeSchema,
  description: z.string().optional().describe('Optional workflow description'),
  entryAgent: z.string().nullable().optional().describe('Entry agent name for the workflow'),
  steps: z.array(workflowStepSchema).describe('Workflow steps'),
  triggers: z.array(workflowTriggerSchema).describe('Workflow triggers'),
  slaMinutes: z.number().optional().describe('SLA in minutes'),
  escalationRules: z.array(workflowEscalationRuleSchema).describe('Escalation rules'),
  notificationRules: z.array(z.record(z.unknown())).optional().describe('Notification rules'),
  status: workflowStatusSchema,
  metadata: z.record(z.unknown()).describe('Additional metadata'),
  tags: z.array(z.string()).optional().describe('Workflow tags'),
  // Node-based canvas fields
  nodes: z.array(z.record(z.unknown())).optional().describe('Canvas node definitions'),
  edges: z.array(z.record(z.unknown())).optional().describe('Canvas edge connections'),
  envVars: z.record(z.string()).optional().describe('Environment variables'),
  inputSchema: z.record(z.unknown()).nullable().optional().describe('Input JSON schema'),
  outputSchema: z.record(z.unknown()).nullable().optional().describe('Output JSON schema'),
  createdAt: z.date().or(z.string()).describe('Creation timestamp'),
  updatedAt: z.date().or(z.string()).optional().describe('Last update timestamp'),
  archivedAt: z.date().or(z.string()).optional().describe('Archive timestamp'),
});

const createWorkflowRequestSchema = z.object({
  projectId: z.string().optional().describe('Project ID (optional — path param takes precedence)'),
  name: z.string().min(1).max(30).describe('Workflow name (1-30 characters)'),
  type: workflowTypeSchema.optional().describe('Workflow type (defaults to cx_automation)'),
  description: z.string().optional().describe('Optional workflow description'),
  entryAgent: z.string().optional().describe('Entry agent name for the workflow'),
  steps: z.array(workflowStepSchema).optional().describe('Workflow steps'),
  triggers: z.array(workflowTriggerSchema).optional().describe('Workflow triggers'),
  slaMinutes: z.number().int().positive().optional().describe('SLA in minutes'),
  escalationRules: z.array(workflowEscalationRuleSchema).optional().describe('Escalation rules'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  tags: z.array(z.string()).optional().describe('Workflow tags'),
  // Node-based canvas fields
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        nodeType: z.string().min(1),
        name: z.string().min(1),
        position: z.object({ x: z.number(), y: z.number() }),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .optional()
    .describe('Canvas node definitions'),
  edges: z
    .array(
      z.object({
        id: z.string().min(1),
        source: z.string().min(1),
        sourceHandle: z.string().optional(),
        target: z.string().min(1),
        label: z.string().optional(),
      }),
    )
    .optional()
    .describe('Canvas edge connections'),
  envVars: z.record(z.string()).optional().describe('Environment variables'),
  inputSchema: z.record(z.unknown()).nullable().optional().describe('Input JSON schema'),
  outputSchema: z.record(z.unknown()).nullable().optional().describe('Output JSON schema'),
});

const createWorkflowResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  data: workflowDefinitionSchema.describe('Created workflow definition'),
});

const queryWorkflowsResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  data: z.array(workflowDefinitionSchema).describe('List of workflow definitions'),
  total: z.number().describe('Total count of matching workflows'),
});

const getWorkflowResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  data: workflowDefinitionSchema.describe('Workflow definition'),
});

export const updateWorkflowRequestSchema = z.object({
  name: z.string().min(1).max(30).optional().describe('Workflow name (1-30 characters)'),
  type: workflowTypeSchema.optional().describe('Workflow type'),
  description: z.string().optional().describe('Workflow description'),
  entryAgent: z.string().optional().describe('Entry agent name for the workflow'),
  steps: z.array(workflowStepSchema).optional().describe('Workflow steps'),
  triggers: z.array(workflowTriggerSchema).optional().describe('Workflow triggers'),
  slaMinutes: z.number().int().positive().optional().describe('SLA in minutes'),
  escalationRules: z.array(workflowEscalationRuleSchema).optional().describe('Escalation rules'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  tags: z.array(z.string()).optional().describe('Workflow tags'),
  // Node-based canvas fields
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        nodeType: z.string().min(1),
        name: z.string().min(1),
        position: z.object({ x: z.number(), y: z.number() }),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .optional()
    .describe('Canvas node definitions'),
  edges: z
    .array(
      z.object({
        id: z.string().min(1),
        source: z.string().min(1),
        sourceHandle: z.string().optional(),
        target: z.string().min(1),
        label: z.string().optional(),
      }),
    )
    .optional()
    .describe('Canvas edge connections'),
  envVars: z.record(z.string()).optional().describe('Environment variables'),
  // Nullable so clients can explicitly clear a previously-set schema.
  // Mirrors the create schema (`workflowDefinitionSchema`) which also
  // accepts `null` — without this, PATCH `{ inputSchema: null }` was
  // rejected as a Zod validation error.
  inputSchema: z.record(z.unknown()).nullable().optional().describe('Workflow input schema'),
  outputSchema: z.record(z.unknown()).nullable().optional().describe('Workflow output schema'),
});

const updateWorkflowResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  data: workflowDefinitionSchema.describe('Updated workflow definition'),
});

const archiveWorkflowResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  message: z.string().describe('Confirmation message'),
  warning: z.string().optional().describe('Warning about active sessions using this workflow'),
});

const associateSessionRequestSchema = z.object({
  sessionId: z.string().min(1).describe('Session ID to associate'),
  stepId: z.string().optional().describe('Optional workflow step ID'),
});

const associateSessionResponseSchema = z.object({
  success: z.boolean().describe('Whether the operation succeeded'),
  message: z.string().describe('Confirmation message'),
});

const errorResponseSchema = z.object({
  success: z.literal(false).describe('Operation failed'),
  error: z.string().describe('Error message'),
  errors: z
    .array(
      z.object({
        field: z.string().describe('Field name with validation error'),
        message: z.string().describe('Validation error message'),
      }),
    )
    .optional()
    .describe('Validation errors'),
});

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * POST / — Create workflow
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create workflow definition',
    description: 'Create a new workflow definition (requires ADMIN+ role)',
    body: createWorkflowRequestSchema,
    response: createWorkflowResponseSchema,
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:create'))) return;

      // `triggers` is server-managed (see PUT handler note). Strip on POST too.
      if (req.body.triggers !== undefined) {
        log.warn('Workflow create body included `triggers` — stripping; use the triggers API', {
          projectId: req.params.projectId,
        });
      }
      // Pick only validated fields — prevent prototype pollution (M-6)
      const validated: Record<string, unknown> = {
        name: req.body.name,
        entryAgent: req.body.entryAgent,
        type: req.body.type ?? 'cx_automation',
        description: req.body.description,
        steps: req.body.steps,
        slaMinutes: req.body.slaMinutes,
        escalationRules: req.body.escalationRules,
        metadata: req.body.metadata,
        tags: req.body.tags,
      };
      // Node-based canvas fields
      if (req.body.nodes !== undefined) validated.nodes = req.body.nodes;
      if (req.body.edges !== undefined) validated.edges = req.body.edges;
      if (req.body.envVars !== undefined) validated.envVars = req.body.envVars;
      if (req.body.inputSchema !== undefined) validated.inputSchema = req.body.inputSchema;
      if (req.body.outputSchema !== undefined) validated.outputSchema = req.body.outputSchema;
      if (req.body.status !== undefined) validated.status = req.body.status;

      // Reject self-loops and cycles before they reach the store.
      validateWorkflowDag(
        req.body.nodes as { id: string; nodeType?: string }[] | undefined,
        req.body.edges as { source: string; target: string }[] | undefined,
      );

      const params = {
        ...validated,
        projectId: req.params.projectId,
        tenantId: req.tenantContext!.tenantId,
        createdBy: req.tenantContext!.userId ?? '',
      } as Parameters<ReturnType<typeof getWorkflowStore>['create']>[0];

      const store = getWorkflowStore();
      const workflow = await store.create(params);

      auditWorkflowCreated(workflow, req.tenantContext!.userId!).catch((err) =>
        log.warn('audit workflow created failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      // Create draft version atomically with the workflow (per HLD FR-2)
      try {
        const { getWorkflowVersionService } =
          await import('../services/workflow-version-service.js');
        await getWorkflowVersionService().getOrCreateDraft(
          workflow.id,
          req.tenantContext!.tenantId,
          req.params.projectId,
          req.tenantContext!.userId!,
        );
      } catch (draftErr) {
        log.warn('Failed to create draft version for new workflow', {
          error: draftErr instanceof Error ? draftErr.message : String(draftErr),
          workflowId: workflow.id,
        });
        // Draft creation failure is non-fatal — getOrCreateDraft acts as safety net on reads
      }

      res.status(201).json({ success: true, data: workflow });
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        res.status(400).json({ success: false, error: error.message, code: error.code });
        return;
      }

      const mongoErr =
        typeof error === 'object' && error !== null
          ? (error as { code?: number; keyPattern?: Record<string, unknown> })
          : null;
      if (mongoErr?.code === 11000 && mongoErr.keyPattern && 'name' in mongoErr.keyPattern) {
        res.status(409).json({
          success: false,
          error: {
            code: 'workflow_name_conflict',
            message: 'A workflow with this name already exists',
          },
        });
        return;
      }

      log.error('Error creating workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to create workflow' });
    }
  },
);

/**
 * GET / — Query workflows
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Query workflow definitions',
    description:
      'Query workflow definitions with optional filters (query params: projectId, type, status, limit, offset)',
    response: queryWorkflowsResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;

      const store = getWorkflowStore();
      const result = await store.query({
        tenantId: req.tenantContext!.tenantId,
        projectId: req.params.projectId,
        type: req.query.type as any,
        status: req.query.status as any,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
      });

      // Enrich list entries with triggerCount + toolCount so the workflow
      // card in Studio can render the new count chips without an N+1
      // fetch-per-workflow. Two extra queries total (one for triggers,
      // one for workflow-type tools), batched over all IDs in the page.
      const usageMap = await loadUsageForWorkflows(
        req.tenantContext!.tenantId,
        req.params.projectId,
        result.definitions.map((d: { id: string }) => d.id),
      );
      const enriched = result.definitions.map((d: { id: string }) => {
        const usage = usageMap.get(d.id);
        return {
          ...d,
          triggerCount: usage?.triggerCount ?? 0,
          toolCount: usage?.toolCount ?? 0,
        };
      });

      res.json({ success: true, data: enriched, total: result.total });
    } catch (error) {
      log.error('Error querying workflows', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to query workflows' });
    }
  },
);

/**
 * GET /by-name — Get workflow by name
 */
openapi.route(
  'get',
  '/by-name',
  {
    summary: 'Get workflow by name',
    description: 'Retrieve a workflow definition by name (query params: name)',
    response: getWorkflowResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;

      const { name } = req.query;
      if (!name) {
        res.status(400).json({ success: false, error: 'name query param required' });
        return;
      }

      const store = getWorkflowStore();
      const workflow = await store.getByName(
        req.tenantContext!.tenantId,
        req.params.projectId,
        name as string,
      );

      if (!workflow) {
        res.status(404).json({ success: false, error: 'Workflow not found' });
        return;
      }

      res.json({ success: true, data: workflow });
    } catch (error) {
      log.error('Error looking up workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to look up workflow' });
    }
  },
);

/**
 * GET /:id — Get by ID
 */
// Paths handled by the workflow-engine proxy — skip the /:id handler for these.
const ENGINE_PROXY_PATHS = new Set(['triggers', 'connectors', 'approvals', 'notifications']);

openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get workflow by ID',
    description: 'Retrieve a workflow definition by its unique ID',
    response: getWorkflowResponseSchema,
  },
  async (req, res, next) => {
    // Let engine-proxy paths fall through to the next router
    if (ENGINE_PROXY_PATHS.has(req.params.id)) {
      return next('route');
    }
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;

      const store = getWorkflowStore();
      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const workflow = await store.getById(req.params.id, tenantId, projectId);

      if (!workflow) {
        res.status(404).json({ success: false, error: 'Workflow not found' });
        return;
      }

      // Decrypt design-time sample outputs stored as encrypted strings.
      // Failures are soft — a stale or missing DEK returns null for that node.
      if (Array.isArray(workflow.nodes)) {
        await Promise.all(
          (workflow.nodes as Array<Record<string, unknown>>).map(async (node) => {
            const cfg = node.config as Record<string, unknown> | undefined;
            if (cfg && typeof cfg.sampleOutput === 'string') {
              try {
                const plain = await decryptForTenantAuto(cfg.sampleOutput, tenantId);
                cfg.sampleOutput = JSON.parse(plain) as unknown;
              } catch {
                cfg.sampleOutput = null;
              }
            }
          }),
        );
      }

      res.json({ success: true, data: workflow });
    } catch (error) {
      log.error('Error getting workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to get workflow' });
    }
  },
);

/**
 * GET /:id/usage — Usage summary for the workflow detail page
 *
 * Returns how many triggers fire this workflow and which `type: workflow`
 * tools wrap it. Phase 1 of the "agents using this workflow" story — the
 * agent walk lands in Phase 2; Studio treats `toolCount > 0` as the
 * "used by agents" indicator today because every agent-consumed workflow
 * ultimately flows through a tool binding.
 */
router.get('/:id/usage', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    const tenantId = req.tenantContext!.tenantId;
    // `router` is not the openapi typed router, so `req.params` is inferred
    // from the local pattern (`:id`) only — cast through the parent-scoped
    // shape to pick up `:projectId` merged by the parent mount.
    const params = req.params as unknown as { id: string; projectId: string };
    const { projectId, id: workflowId } = params;

    // 404 when the workflow doesn't exist or isn't visible to this caller,
    // to avoid leaking existence via the usage endpoint.
    const workflow = await getWorkflowStore().getById(workflowId, tenantId, projectId);
    if (!workflow) {
      res.status(404).json({ success: false, error: 'Workflow not found' });
      return;
    }

    const usageMap = await loadUsageForWorkflows(tenantId, projectId, [workflowId]);
    const usage = usageMap.get(workflowId) ?? { triggerCount: 0, toolCount: 0, tools: [] };
    res.json({ success: true, data: usage });
  } catch (error) {
    const params = req.params as unknown as { id: string; projectId: string };
    log.error('Error getting workflow usage', {
      error: error instanceof Error ? error.message : String(error),
      projectId: params.projectId,
      workflowId: params.id,
    });
    res.status(500).json({ success: false, error: 'Failed to get workflow usage' });
  }
});

/**
 * PUT /:id — Update workflow
 */
openapi.route(
  'put',
  '/:id',
  {
    summary: 'Update workflow definition',
    description: 'Update an existing workflow definition (requires ADMIN+ role)',
    body: updateWorkflowRequestSchema,
    response: updateWorkflowResponseSchema,
  },
  async (req, res, next) => {
    // Let engine-proxy paths fall through to the next router (workflow-engine-proxy).
    // Without this, PUT /workflows/triggers/:registrationId would be treated as
    // "update workflow with id=triggers" and return a misleading 404.
    if (ENGINE_PROXY_PATHS.has(req.params.id)) {
      return next('route');
    }
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:update'))) return;

      const store = getWorkflowStore();
      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const existing = await store.getById(req.params.id, tenantId, projectId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Workflow not found' });
        return;
      }

      // Pick only validated fields — prevent prototype pollution (same pattern as POST handler)
      const body: Record<string, unknown> = {};
      if (req.body.name !== undefined) body.name = req.body.name;
      if (req.body.type !== undefined) body.type = req.body.type;
      if (req.body.description !== undefined) body.description = req.body.description;
      if (req.body.entryAgent !== undefined) body.entryAgent = req.body.entryAgent;
      if (req.body.steps !== undefined)
        body.steps = denormalizeSteps(req.body.steps as Record<string, unknown>[]);
      // `triggers` is intentionally NOT writable through workflow CRUD. The
      // denormalized `Workflow.triggers[]` array is server-managed: TriggerEngine
      // .register / .update / .deregister write it as a side effect of the
      // dedicated POST/PUT/DELETE /api/projects/:projectId/workflows/triggers
      // endpoints. Accepting it here would let a caller plant arbitrary fields
      // (including a fake `callbackAccessToken` or `triggerParams`) directly
      // into the denormalized copy, drifting it from the canonical
      // TriggerRegistration collection. Log + strip silently to keep
      // backwards-compatible — older callers occasionally include the field
      // when re-uploading a full workflow doc.
      if (req.body.triggers !== undefined) {
        log.warn('Workflow update body included `triggers` — stripping; use the triggers API', {
          workflowId: req.params.id,
          projectId: req.params.projectId,
        });
      }
      if (req.body.slaMinutes !== undefined) body.slaMinutes = req.body.slaMinutes;
      if (req.body.escalationRules !== undefined) body.escalationRules = req.body.escalationRules;
      if (req.body.metadata !== undefined) body.metadata = req.body.metadata;
      if (req.body.tags !== undefined) body.tags = req.body.tags;
      // Node-based canvas fields. Re-encrypt any sampleOutput that arrived as a
      // plaintext object — this happens when Studio auto-saves the canvas after a
      // test-action run (the local store holds the decrypted object returned by the
      // GET handler). Without re-encryption the value would persist unencrypted.
      if (req.body.nodes !== undefined) {
        const incomingNodes = req.body.nodes as Array<Record<string, unknown>>;
        body.nodes = await Promise.all(
          incomingNodes.map(async (node) => {
            const cfg = node.config as Record<string, unknown> | undefined;
            if (cfg && cfg.sampleOutput !== undefined && typeof cfg.sampleOutput !== 'string') {
              try {
                const encrypted = await encryptForTenantAuto(
                  JSON.stringify(cfg.sampleOutput),
                  tenantId,
                );
                return { ...node, config: { ...cfg, sampleOutput: encrypted } };
              } catch {
                // Encryption failure — strip the field rather than store plaintext.
                const { sampleOutput: _dropped, ...rest } = cfg;
                return { ...node, config: rest };
              }
            }
            return node;
          }),
        );
      }
      if (req.body.edges !== undefined) body.edges = req.body.edges;
      if (req.body.envVars !== undefined) body.envVars = req.body.envVars;
      if (req.body.inputSchema !== undefined) body.inputSchema = req.body.inputSchema;
      if (req.body.outputSchema !== undefined) body.outputSchema = req.body.outputSchema;

      // Validate the effective graph — use the incoming value if present,
      // otherwise fall back to the existing graph so partial updates still
      // enforce DAG invariants.
      const existingDef = existing as unknown as {
        nodes?: { id: string; nodeType?: string }[];
        edges?: { source: string; target: string }[];
      };
      const effectiveNodes =
        (body.nodes as { id: string; nodeType?: string }[] | undefined) ?? existingDef.nodes;
      const effectiveEdges =
        (body.edges as { source: string; target: string }[] | undefined) ?? existingDef.edges;
      validateWorkflowDag(effectiveNodes, effectiveEdges);

      const updated = await store.update(req.params.id, tenantId, projectId, body);

      auditWorkflowUpdated(
        req.params.id,
        { name: existing.name, type: existing.type, status: existing.status },
        { name: updated.name, type: updated.type, status: updated.status },
        req.tenantContext!.userId!,
        req.tenantContext!.tenantId,
      ).catch((err) =>
        log.warn('audit workflow updated failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      res.json({ success: true, data: updated });
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        res.status(400).json({ success: false, error: error.message, code: error.code });
        return;
      }
      log.error('Error updating workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to update workflow' });
    }
  },
);

/**
 * POST /:id/archive — Archive workflow
 */
openapi.route(
  'post',
  '/:id/archive',
  {
    summary: 'Archive workflow definition',
    description:
      'Archive a workflow definition (requires ADMIN+ role). Returns warning if active sessions are using this workflow.',
    response: archiveWorkflowResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:delete'))) return;

      const store = getWorkflowStore();
      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const existing = await store.getById(req.params.id, tenantId, projectId);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Workflow not found' });
        return;
      }

      await store.archive(req.params.id, tenantId, projectId);

      // Check for active sessions using this workflow
      const activeSessions = await countSessions({
        workflowId: req.params.id,
        tenantId,
        status: 'active',
      });

      auditWorkflowArchived(
        req.params.id,
        req.tenantContext!.userId!,
        req.tenantContext!.tenantId,
      ).catch((err) =>
        log.warn('audit workflow archived failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      const response: { success: boolean; message: string; warning?: string } = {
        success: true,
        message: 'Workflow archived',
      };
      if (activeSessions > 0) {
        response.warning = `${activeSessions} active session(s) are still using this workflow`;
      }

      res.json(response);
    } catch (error) {
      log.error('Error archiving workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to archive workflow' });
    }
  },
);

/**
 * DELETE /:id — Soft-delete workflow and cascade to versions and triggers
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete workflow definition',
    description:
      'Soft-delete a workflow definition and cascade to all versions and trigger registrations (requires ADMIN+ role)',
    response: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:delete'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId, id: workflowId } = req.params;

      // Verify workflow exists before cascade
      const store = getWorkflowStore();
      const existing = await store.getById(workflowId, tenantId, projectId);
      if (!existing) {
        res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
        });
        return;
      }

      const { getWorkflowVersionService } = await import('../services/workflow-version-service.js');
      await getWorkflowVersionService().softDeleteCascade(tenantId, projectId, workflowId);

      // Fire-and-forget audit
      auditWorkflowDeleted({ tenantId, projectId, workflowId }, req.tenantContext!.userId!).catch(
        (err) =>
          log.warn('audit workflow deleted failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
      );

      res.json({ success: true, message: 'Workflow deleted' });
    } catch (error) {
      log.error('Error deleting workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete workflow' },
      });
    }
  },
);

/**
 * POST /:id/associate-session — Link workflow to session
 */
openapi.route(
  'post',
  '/:id/associate-session',
  {
    summary: 'Associate workflow with session',
    description: 'Link a workflow definition to a conversation session (requires ADMIN+ role)',
    body: associateSessionRequestSchema,
    response: associateSessionResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;

      const { sessionId, stepId } = req.body;

      const store = getWorkflowStore();
      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const workflow = await store.getById(req.params.id, tenantId, projectId);
      if (!workflow) {
        res.status(404).json({ success: false, error: 'Workflow not found' });
        return;
      }

      const convStore = getConversationStore();
      await convStore.associateWorkflow(sessionId, req.params.id, stepId);

      res.json({ success: true, message: 'Workflow associated with session' });
    } catch (error) {
      log.error('Error associating workflow', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to associate workflow with session' });
    }
  },
);

export default openapi.router;
