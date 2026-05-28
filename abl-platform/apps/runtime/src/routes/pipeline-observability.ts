/**
 * Pipeline Observability API Routes
 *
 * Mounted at /api/projects/:projectId/pipeline-observability
 *
 * Backs the Studio "Recent Runs" and "Data" tabs plus pipeline-card health
 * badges. All data access (Mongo run records, ClickHouse output tables) is
 * owned by Runtime — Studio proxies to these endpoints and never hits the
 * databases directly.
 *
 *   GET  /runs                          Project-scoped runs list
 *   GET  /runs/health                   Health summary + per-pipeline stats
 *   POST /data/query                    ClickHouse output data preview
 *   GET  /data/previewable-pipelines    Pipelines with known output tables
 *   GET  /pipelines/:pipelineId/output-schema   Resolved schema + filter metadata
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectWideAnalyticsAccess } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import {
  PIPELINE_OBSERVABILITY_CONTRACT,
  type PipelineObservabilityResponseMeta,
} from '@agent-platform/shared';
import {
  listProjectRuns,
  getProjectRunHealth,
  resolveRunSessionId,
} from '../services/pipeline-observability/runs-service.js';
import {
  resolveOutputSchema,
  OutputSchemaError,
} from '../services/pipeline-observability/schema-resolver.js';
import {
  buildPipelineDataQuery,
  QueryBuilderError,
} from '../services/pipeline-observability/query-builder.js';
import { listPreviewablePipelines } from '../services/pipeline-observability/previewable-pipelines-service.js';
import { PipelineDefinitionModel } from '@agent-platform/pipeline-engine/schemas';
import { previewNode } from '@agent-platform/pipeline-engine/preview';
import { ContractRegistry } from '@agent-platform/pipeline-engine/contracts';
import {
  toExternalObservabilityPipelineId,
  toStoredObservabilityPipelineId,
} from '../services/pipeline-observability/pipeline-id-aliases.js';

const log = createLogger('pipeline-observability-route');
const PIPELINE_OBSERVABILITY_META: PipelineObservabilityResponseMeta = {
  contract: PIPELINE_OBSERVABILITY_CONTRACT,
};

function sanitizePreviewError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  log.warn('Pipeline preview failed', { error: msg });
  return 'Preview failed. Check the selected node, sample session, and pipeline configuration.';
}

// ─── Lazy ClickHouse ────────────────────────────────────────────────────────

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/pipeline-observability',
  tags: ['Pipeline Observability'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const RunsQuerySchema = z.object({
  type: z.enum(['builtin', 'custom', 'all']).default('all'),
  pipelineId: z.string().min(1).optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const HealthQuerySchema = z.object({
  window: z.enum(['1h', '24h', '7d']).default('24h'),
  pipelineId: z.string().min(1).optional(),
});

const DataQueryBodySchema = z.object({
  pipelineId: z.string().min(1),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  timeRange: z.object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  }),
  filters: z
    .array(
      z.object({
        column: z.string().min(1),
        op: z.enum(['=', 'in', 'contains']),
        value: z.unknown(),
      }),
    )
    .optional()
    .default([]),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
});

// ─── GET /runs ──────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/runs',
  {
    summary: 'List project-scoped pipeline runs',
    description:
      'Recent Runs tab feed. Joins PipelineRunRecord with PipelineDefinition to resolve pipeline name and kind.',
    response: z.object({
      success: z.boolean(),
      meta: z.record(z.unknown()),
      data: z.array(z.record(z.unknown())),
      pagination: z.object({
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const parsed = RunsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const normalizedPipelineId = parsed.data.pipelineId
      ? toStoredObservabilityPipelineId(parsed.data.pipelineId)
      : undefined;

    try {
      const since = parsed.data.since ?? new Date(Date.now() - 24 * 3600e3);
      const until = parsed.data.until ?? new Date();
      const result = await listProjectRuns({
        tenantId,
        projectId,
        type: parsed.data.type,
        pipelineId: normalizedPipelineId,
        status: parsed.data.status,
        since,
        until,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      res.json({
        success: true,
        meta: PIPELINE_OBSERVABILITY_META,
        data: result.data.map((run) => ({
          ...run,
          pipelineId: toExternalObservabilityPipelineId(run.pipelineId),
        })),
        pagination: result.pagination,
      });
    } catch (error) {
      log.error('List project runs failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_RUNS_LIST_FAILED',
          message: 'Failed to list pipeline runs',
        },
      });
    }
  },
);

// ─── GET /runs/health ───────────────────────────────────────────────────────

openapi.route(
  'get',
  '/runs/health',
  {
    summary: 'Pipeline run health summary',
    description:
      'Aggregated counts (total/completed/failed/running/cancelled) + avg duration, optionally split by pipeline for card badges.',
    response: z.object({
      success: z.boolean(),
      meta: z.record(z.unknown()),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const parsed = HealthQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const normalizedPipelineId = parsed.data.pipelineId
      ? toStoredObservabilityPipelineId(parsed.data.pipelineId)
      : undefined;

    try {
      const data = await getProjectRunHealth({
        tenantId,
        projectId,
        window: parsed.data.window,
        pipelineId: normalizedPipelineId,
      });
      res.json({
        success: true,
        meta: PIPELINE_OBSERVABILITY_META,
        data: {
          ...data,
          byPipeline: data.byPipeline?.map((entry) => ({
            ...entry,
            pipelineId: toExternalObservabilityPipelineId(entry.pipelineId),
          })),
        },
      });
    } catch (error) {
      log.error('Pipeline run health failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_HEALTH_FAILED',
          message: 'Failed to compute pipeline health',
        },
      });
    }
  },
);

// ─── POST /data/query ───────────────────────────────────────────────────────

openapi.route(
  'post',
  '/data/query',
  {
    summary: 'Query pipeline output data',
    description:
      'Parameterized ClickHouse SELECT over a pipeline output table. Tenant + project isolation is always enforced server-side.',
    body: z.unknown(),
    response: z.object({
      success: z.boolean(),
      meta: z.record(z.unknown()),
      data: z.object({
        table: z.string(),
        columns: z.array(z.string()),
        rows: z.array(z.record(z.unknown())),
      }),
      pagination: z.object({
        total: z.number().nullable(),
        limit: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const parsed = DataQueryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const normalizedPipelineId = toStoredObservabilityPipelineId(parsed.data.pipelineId);

    try {
      const schema = await resolveOutputSchema(normalizedPipelineId, tenantId);

      // runId → sessionId lookup (analytics tables have no run_id column)
      let effectiveSessionId = parsed.data.sessionId;
      if (parsed.data.runId && !effectiveSessionId) {
        effectiveSessionId = await resolveRunSessionId(parsed.data.runId, tenantId);
      }

      const { sql, params: queryParams } = buildPipelineDataQuery({
        tenantId,
        projectId,
        pipelineId: normalizedPipelineId,
        tableName: schema.table,
        columns: schema.columns,
        sessionId: effectiveSessionId,
        runId: parsed.data.runId,
        timeRange: parsed.data.timeRange,
        filters: parsed.data.filters,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });

      const ch = await getClickHouse();
      const result = await ch.query({
        query: sql,
        query_params: queryParams,
        format: 'JSONEachRow',
      });
      const rows: unknown[] = await result.json();

      res.json({
        success: true,
        meta: PIPELINE_OBSERVABILITY_META,
        data: {
          table: schema.table,
          columns: schema.columns.filter((c) => c.exportable).map((c) => c.name),
          rows,
        },
        pagination: {
          total: null,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
          hasMore: rows.length === parsed.data.limit,
        },
      });
    } catch (error: unknown) {
      if (error instanceof OutputSchemaError && error.code === 'NO_OUTPUT_TABLE') {
        res.status(400).json({
          success: false,
          error: { code: 'NO_OUTPUT_TABLE', message: error.message },
        });
        return;
      }
      if (error instanceof OutputSchemaError && error.code === 'NOT_FOUND') {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Pipeline not found' },
        });
        return;
      }
      if (error instanceof QueryBuilderError) {
        res.status(400).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('exceeded max_execution_time')) {
        res.status(504).json({
          success: false,
          error: { code: 'QUERY_TIMEOUT', message: 'Query exceeded 10-second limit' },
        });
        return;
      }
      if (msg.includes('max_rows_to_read')) {
        res.status(413).json({
          success: false,
          error: { code: 'SCAN_LIMIT', message: 'Query scan limit hit — narrow filters' },
        });
        return;
      }
      log.error('Pipeline data query failed', {
        error: msg,
        projectId,
        pipelineId: parsed.data.pipelineId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_DATA_QUERY_FAILED',
          message: 'Failed to query pipeline data',
        },
      });
    }
  },
);

// ─── GET /data/previewable-pipelines ────────────────────────────────────────

openapi.route(
  'get',
  '/data/previewable-pipelines',
  {
    summary: 'List previewable pipelines',
    description:
      'Returns builtin + custom pipelines that have a resolvable output table in ClickHouse for this project.',
    response: z.object({
      success: z.boolean(),
      meta: z.record(z.unknown()),
      data: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(['builtin', 'custom']),
        }),
      ),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    try {
      const data = await listPreviewablePipelines({ tenantId, projectId });
      res.json({ success: true, meta: PIPELINE_OBSERVABILITY_META, data });
    } catch (error) {
      log.error('List previewable pipelines failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PREVIEWABLE_PIPELINES_FAILED',
          message: 'Failed to list previewable pipelines',
        },
      });
    }
  },
);

// ─── GET /pipelines/:pipelineId/output-schema ───────────────────────────────

openapi.route(
  'get',
  '/pipelines/:pipelineId/output-schema',
  {
    summary: 'Resolve pipeline output schema',
    description:
      "Returns the ClickHouse table and column metadata (including filterable/exportable flags) for a pipeline's output.",
    response: z.object({
      success: z.boolean(),
      meta: z.record(z.unknown()),
      data: z.object({
        table: z.string(),
        columns: z.array(z.record(z.unknown())),
      }),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const { pipelineId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const normalizedPipelineId = toStoredObservabilityPipelineId(pipelineId);

    try {
      const schema = await resolveOutputSchema(normalizedPipelineId, tenantId);
      res.json({ success: true, meta: PIPELINE_OBSERVABILITY_META, data: schema });
    } catch (error: unknown) {
      if (error instanceof OutputSchemaError && error.code === 'NO_OUTPUT_TABLE') {
        res.status(400).json({
          success: false,
          error: { code: 'NO_OUTPUT_TABLE', message: error.message },
        });
        return;
      }
      if (error instanceof OutputSchemaError && error.code === 'NOT_FOUND') {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Pipeline not found' },
        });
        return;
      }
      log.error('Output schema resolution failed', {
        error: error instanceof Error ? error.message : String(error),
        pipelineId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'OUTPUT_SCHEMA_FAILED',
          message: 'Failed to resolve output schema',
        },
      });
    }
  },
);

// ── Live dataflow preview (P7) ─────────────────────────────────────────────

const PreviewNodeBodySchema = z.object({
  nodeId: z.string().min(1),
  sampleSessionId: z.string().min(1),
});

const previewContractRegistry = new ContractRegistry();

openapi.route(
  'post',
  '/pipelines/:pipelineId/preview-node',
  {
    summary: 'Execute a pipeline node in preview mode',
    description:
      "Runs the upstream sub-graph up to the target node in-process using the sample session. Write/external nodes are short-circuited. Returns the target node's output without persisting anything.",
    response: z.object({
      success: z.boolean(),
      output: z.record(z.unknown()),
      skippedNodes: z.array(z.string()),
      cached: z.boolean(),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const { projectId, pipelineId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const parsed = PreviewNodeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'nodeId and sampleSessionId are required' },
      });
      return;
    }
    const { nodeId, sampleSessionId } = parsed.data;

    try {
      const pipeline = await PipelineDefinitionModel.findOne({
        _id: pipelineId,
        tenantId,
        projectId,
      }).lean();
      if (!pipeline) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Pipeline not found' } });
        return;
      }

      const nodes = (pipeline.nodes ??
        []) as import('@agent-platform/pipeline-engine').PipelineNode[];
      const entryNodeId = pipeline.entryNodeId ?? '';

      // Build pipelineInput from the first trigger's exampleOutput in ContractRegistry
      const firstTriggerId = (pipeline.defaultTriggerIds ?? [])[0] ?? '';
      const triggerContract = previewContractRegistry.getTrigger(firstTriggerId);
      const pipelineInput: Record<string, unknown> = triggerContract?.exampleOutput ?? {};

      const result = await previewNode({
        tenantId,
        projectId,
        pipelineId,
        nodeId,
        sampleSessionId,
        nodes,
        entryNodeId,
        pipelineInput,
        triggerId: firstTriggerId || undefined,
        pipelineName: pipeline.name,
      });
      res.json({
        success: true,
        output: result.output,
        skippedNodes: result.skippedNodes,
        cached: result.cached,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: { code: 'PREVIEW_FAILED', message: sanitizePreviewError(err) },
      });
    }
  },
);

export default openapi.router;
