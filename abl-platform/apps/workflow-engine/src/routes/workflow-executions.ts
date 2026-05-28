/**
 * Workflow Execution Routes
 *
 * GET  /                                List executions for a workflow
 * GET  /:executionId                    Get execution detail with step statuses
 * POST /execute                         Manually trigger a workflow execution
 * POST /:executionId/cancel             Cancel a running execution
 */

import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../constants.js';
import {
  convertVersionDocToSteps,
  convertWorkflowDocToSteps,
} from '../handlers/canvas-to-steps.js';
import type {
  OutputMapping,
  StartInputVariable,
  EdgeDescriptor,
} from '../handlers/canvas-to-steps.js';
import { validateAndCoerceInput } from '../validation/start-input-validator.js';
import { buildWorkflowExecutionPayload } from '../lib/execution-payload.js';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';
import { compareSemverDesc } from '../lib/semver-compare.js';
import type { WorkflowExecutionModel, MongooseModelLike } from '../persistence/execution-store.js';
import type {
  StatusPublisher,
  WorkflowRunInput,
  ExecutionPersistence,
} from '../handlers/workflow-handler.js';
import type { RestateWorkflowClient } from '../services/restate-client.js';

const log = createLogger('workflow-engine:executions');

export type { WorkflowExecutionModel, StatusPublisher };

/** Workflow document shape the execute route reads. */
interface WorkflowDefinitionDocLike {
  _id: string;
  name: string;
  steps?: unknown[];
  nodes?: unknown[];
  edges?: unknown[];
}

/** Mongoose-like model interface for WorkflowDefinition */
export type WorkflowDefinitionModel = Pick<MongooseModelLike<WorkflowDefinitionDocLike>, 'findOne'>;

/**
 * Mongoose-like model interface for WorkflowVersion.
 *
 * Used by /execute to resolve either an explicitly pinned version
 * (`workflowVersionId` in the body) or the active version (default for
 * Studio-initiated runs). When no active version exists the route falls
 * back to the current Workflow draft.
 */
/** Single version-doc shape returned by both findOne and find. */
interface WorkflowVersionDoc {
  _id: string;
  workflowId: string;
  version: string;
  state?: 'active' | 'inactive';
  deleted?: boolean;
  definition?: {
    nodes?: unknown[];
    edges?: unknown[];
  };
}

export interface WorkflowVersionModel {
  findOne(filter: Record<string, unknown>): Promise<WorkflowVersionDoc | null>;
  find(filter: Record<string, unknown>): {
    lean(): Promise<WorkflowVersionDoc[]>;
  };
}

/** Restate ingress client for starting/cancelling workflows (legacy + relay-race) */
export type RestateClient = Pick<
  RestateWorkflowClient,
  'startLegacyWorkflow' | 'cancelLegacyWorkflow' | 'startWorkflow' | 'cancelWorkflow'
>;

/** Mongoose-like model interface for HumanTask bulk updates */
export interface HumanTaskModel {
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
}

/** Reader indirection injected when `WORKFLOW_DUAL_READ_ENABLED=true` (LLD §5.2). */
export interface HybridReaderAdapter {
  listByWorkflow(params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    limit: number;
    status?: string;
  }): Promise<unknown[]>;
  getById(params: {
    tenantId: string;
    projectId: string;
    workflowId?: string;
    executionId: string;
  }): Promise<Record<string, unknown> | null>;
}

export interface WorkflowExecutionRouteDeps {
  executionModel: WorkflowExecutionModel;
  workflowModel: WorkflowDefinitionModel;
  workflowVersionModel?: WorkflowVersionModel;
  restateClient: RestateClient;
  publisher: StatusPublisher;
  humanTaskModel?: HumanTaskModel;
  /**
   * Relay-race: persistence for createExecution (called from execute route in
   * relay-race mode so the execution record + inputSnapshot exist before
   * startWorkflow() is invoked). Optional — absent means legacy startLegacyWorkflow() path.
   */
  persistence?: Pick<ExecutionPersistence, 'createExecution'>;
  /**
   * Tenant-scoped secret encryption — invoked when a caller supplies
   * `triggerMetadata.accessToken` on an async-push run. The plaintext is
   * immediately replaced with `triggerMetadata.encryptedAccessToken` so that
   * neither the Restate input, the MongoDB execution document, nor the
   * downstream BullMQ callback job ever carries the bearer token in the clear.
   */
  encryptSecret: (plaintext: string, tenantId: string) => Promise<string>;
  /**
   * When set, list GETs + Mongo-miss detail GETs route through this reader.
   * Factory at `src/index.ts` wires this only when the dual-read flag is on.
   */
  hybridReader?: HybridReaderAdapter;
}

/** Cancellable execution statuses */
const CANCELLABLE_STATUSES = [
  'running',
  'waiting_callback',
  'waiting_approval',
  'waiting_human',
  'waiting_human_task',
  'waiting_delay',
];

/** Allowed trigger types for the execute endpoint */
const ALLOWED_TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent', 'workflow'] as const;

// ─── Zod schemas ──────────────────────────────────────────────────────────

const listExecutionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  status: z.string().min(1).optional(),
});

const ALLOWED_WEBHOOK_MODES = ['sync', 'async'] as const;
const ALLOWED_WEBHOOK_DELIVERIES = ['poll', 'push'] as const;

const executeBodySchema = z.object({
  executionId: z.string().uuid().optional(),
  triggerType: z.enum(ALLOWED_TRIGGER_TYPES).default('studio'),
  workflowVersionId: z.string().min(1).optional(),
  workflowVersion: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  triggerMetadata: z.record(z.string(), z.unknown()).optional(),
  webhookMode: z.enum(ALLOWED_WEBHOOK_MODES).optional(),
  webhookDelivery: z.enum(ALLOWED_WEBHOOK_DELIVERIES).optional(),
});

type WorkflowDefinitionDoc = {
  _id: string;
  name: string;
  steps?: unknown[];
  nodes?: unknown[];
  edges?: unknown[];
};

type ExecutionDefinition = {
  steps: unknown[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  outputMappingsByEndNodeId: Record<string, OutputMapping[]>;
  startInputVariables: StartInputVariable[];
  inDegreeMap?: Record<string, number>;
  edgeMap?: Record<string, EdgeDescriptor[]>;
  workflowVersionId?: string;
  workflowVersion?: string;
};

/**
 * Resolve the "working copy" execution definition.
 *
 * The draft WorkflowVersion row is the authoritative source for canvas
 * saves — they write `definition.nodes`/`definition.edges` there and only
 * fire-and-forget sync back to the Workflow doc. Reading from the draft
 * row here makes the /execute path consistent with `fireWebhookTrigger`,
 * eliminating the debug-vs-fire-now drift caused by stale `workflow.steps`
 * or unsynced `workflow.nodes`.
 *
 * Falls back to the Workflow doc only for legacy workflows that predate
 * the draft-versions feature (no draft row exists). The `workflow.steps`
 * short-circuit is preserved for those — it's a known drift source for
 * non-legacy workflows but the only available data for legacy ones.
 */
async function buildWorkingCopyExecutionDefinition(
  deps: WorkflowExecutionRouteDeps,
  workflow: WorkflowDefinitionDoc,
  params: { tenantId: string; projectId: string; workflowId: string },
): Promise<ExecutionDefinition> {
  if (deps.workflowVersionModel) {
    const draftDoc = await deps.workflowVersionModel.findOne({
      workflowId: params.workflowId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      version: 'draft',
      deleted: { $ne: true },
    });
    if (draftDoc) {
      const conversion = convertVersionDocToSteps(draftDoc);
      return {
        steps: conversion.steps,
        nameToIdMap: conversion.nameToIdMap,
        outputMappings: conversion.outputMappings,
        outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
        startInputVariables: conversion.startInputVariables,
        inDegreeMap: conversion.inDegreeMap,
        edgeMap: conversion.edgeMap,
        workflowVersionId: draftDoc._id,
        workflowVersion: 'draft',
      };
    }
  }

  if (workflow.steps && Array.isArray(workflow.steps) && workflow.steps.length > 0) {
    const canvasConversion = convertWorkflowDocToSteps(workflow);
    return {
      steps: workflow.steps,
      nameToIdMap: canvasConversion.nameToIdMap,
      outputMappings: canvasConversion.outputMappings,
      outputMappingsByEndNodeId: canvasConversion.outputMappingsByEndNodeId,
      startInputVariables: canvasConversion.startInputVariables,
      inDegreeMap: canvasConversion.inDegreeMap,
      edgeMap: canvasConversion.edgeMap,
    };
  }

  const conversion = convertWorkflowDocToSteps(workflow);
  return {
    steps: conversion.steps,
    nameToIdMap: conversion.nameToIdMap,
    outputMappings: conversion.outputMappings,
    outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
    startInputVariables: conversion.startInputVariables,
    inDegreeMap: conversion.inDegreeMap,
    edgeMap: conversion.edgeMap,
  };
}

async function buildVersionExecutionDefinition(
  deps: WorkflowExecutionRouteDeps,
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    workflowVersionId?: string;
    workflowVersion?: string;
  },
): Promise<ExecutionDefinition | null | 'unavailable'> {
  if (!params.workflowVersionId && !params.workflowVersion) {
    return null;
  }
  if (!deps.workflowVersionModel) {
    return 'unavailable';
  }

  const versionDoc = params.workflowVersionId
    ? await deps.workflowVersionModel.findOne({
        _id: params.workflowVersionId,
        workflowId: params.workflowId,
        tenantId: params.tenantId,
        projectId: params.projectId,
        deleted: { $ne: true },
      })
    : await deps.workflowVersionModel.findOne({
        workflowId: params.workflowId,
        version: params.workflowVersion,
        tenantId: params.tenantId,
        projectId: params.projectId,
        deleted: { $ne: true },
      });

  if (!versionDoc) {
    return null;
  }

  const conversion = convertVersionDocToSteps(versionDoc);
  return {
    steps: conversion.steps,
    nameToIdMap: conversion.nameToIdMap,
    outputMappings: conversion.outputMappings,
    outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
    startInputVariables: conversion.startInputVariables,
    inDegreeMap: conversion.inDegreeMap,
    edgeMap: conversion.edgeMap,
    workflowVersionId: versionDoc._id,
    workflowVersion: versionDoc.version,
  };
}

async function buildDefaultVersionExecutionDefinition(
  deps: WorkflowExecutionRouteDeps,
  params: {
    tenantId: string;
    projectId: string;
    workflowId: string;
  },
): Promise<ExecutionDefinition | null> {
  if (!deps.workflowVersionModel) {
    return null;
  }

  const candidates = await deps.workflowVersionModel
    .find({
      workflowId: params.workflowId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      state: 'active',
      deleted: { $ne: true },
      version: { $ne: 'draft' },
    })
    .lean();

  candidates.sort((a, b) => compareSemverDesc(a.version, b.version));
  const activeDoc = candidates[0] ?? null;
  if (!activeDoc) {
    log.warn('workflow.version.resolution.miss', {
      workflowId: params.workflowId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      resolution: 'draft-fallback',
    });
    return null;
  }

  const conversion = convertVersionDocToSteps(activeDoc);
  return {
    steps: conversion.steps,
    nameToIdMap: conversion.nameToIdMap,
    outputMappings: conversion.outputMappings,
    outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
    startInputVariables: conversion.startInputVariables,
    inDegreeMap: conversion.inDegreeMap,
    edgeMap: conversion.edgeMap,
    workflowVersionId: activeDoc._id,
    workflowVersion: activeDoc.version,
  };
}

// Fields that must never leave the service boundary.
// Add new sensitive per-step keys here — they are stripped from every step
// in context.steps before the execution document is returned to Studio clients.
// G-4 fix: expand to include all internal relay-race step fields that should
// never reach API consumers. awakeableId could enable replay attacks on
// unauthenticated Restate ingress; the rest are orchestration internals.
const STEP_SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'callbackSecret',
  'parkPoint',
  'awakeableId',
  'nextStepIds',
  'rejectStepIds',
  'joinStepId',
  'barrierTotal',
  'barrierCount',
  'barrierFailCount',
  'branchId',
  'failureStrategy',
]);

/**
 * Strip internal Mongoose/Restate fields and produce a clean execution
 * document suitable for the Studio API response.
 *
 * Applies to both the list and detail endpoints so the response shape is
 * identical regardless of which endpoint surfaces the record.
 *
 * Preserved root fields: id, workflowId, workflowVersionId, workflowVersion,
 * tenantId, projectId, status, triggerType, triggerMetadata, input, output,
 * error, startedAt, completedAt, durationMs, webhookMode, webhookDelivery,
 * workflowName (extracted from context.workflow), context (stripped of
 * internal sub-objects — context.steps is the single source of truth for all
 * step execution data).
 */
function cleanExecutionDoc(raw: Record<string, unknown>): Record<string, unknown> {
  const {
    _id,
    __v,
    restateWorkflowId,
    startTime,
    endTime,
    createdAt,
    updatedAt,
    expiresAt,
    nodeExecutions: _nodeExecutions,
    // F-1 fix: inputSnapshot contains the full WorkflowExecutionInput including
    // triggerMetadata.encryptedAccessToken and internal step configs — never expose
    // to API consumers. It is an internal relay-race implementation detail.
    inputSnapshot: _inputSnapshot,
    // runCounter is an internal monotonic counter — not meaningful to API consumers.
    runCounter: _runCounter,
    context,
    ...rootFields
  } = raw;
  void _inputSnapshot;
  void _runCounter;

  // Strip internal context sub-objects (workflow/tenant) — new executions
  // already omit these at write time; this guards against legacy docs
  const {
    workflow,
    tenant: _tenant,
    steps: rawSteps,
    // G-2 fix: loopData stores full loop item arrays (connector responses, PII).
    // Never expose to API consumers — it is an internal relay-race implementation detail.
    loopData: _loopData,
    ...restContext
  } = (context as Record<string, unknown> | undefined) ?? {};
  void _loopData;
  const workflowName = (workflow as Record<string, unknown> | undefined)?.name as
    | string
    | undefined;

  void __v;
  void restateWorkflowId;
  void startTime;
  void endTime;
  void createdAt;
  void updatedAt;
  void expiresAt;
  void _tenant;
  void _nodeExecutions;

  const cleanedSteps = rawSteps
    ? Object.fromEntries(
        Object.entries(rawSteps as Record<string, Record<string, unknown>>).map(([name, step]) => {
          const publicStep = Object.fromEntries(
            Object.entries(step ?? {}).filter(([key]) => !STEP_SENSITIVE_FIELDS.has(key)),
          );
          return [name, publicStep];
        }),
      )
    : rawSteps;

  // Strip credential sub-fields from triggerMetadata before sending to clients.
  // access tokens and callback secrets are service-internal; clients have no use for them.
  const { triggerMetadata: rawTriggerMeta, ...otherRootFields } = rootFields;
  const safeTriggerMeta =
    rawTriggerMeta && typeof rawTriggerMeta === 'object'
      ? Object.fromEntries(
          Object.entries(rawTriggerMeta as Record<string, unknown>).filter(
            ([k]) =>
              k !== 'encryptedAccessToken' &&
              k !== 'accessToken' &&
              k !== 'encryptedCallbackSecret' &&
              k !== 'callbackSecret',
          ),
        )
      : rawTriggerMeta;

  return {
    id: _id,
    ...otherRootFields,
    ...(safeTriggerMeta !== undefined ? { triggerMetadata: safeTriggerMeta } : {}),
    ...(workflowName !== undefined ? { workflowName } : {}),
    context: { ...restContext, steps: cleanedSteps },
  };
}

export function createWorkflowExecutionRouter(deps: WorkflowExecutionRouteDeps): Router {
  const router = Router({ mergeParams: true });

  /**
   * GET / — List executions for a workflow
   * Query params: limit, status
   */
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId } = ctx;

      const queryParsed = listExecutionsQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: queryParsed.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { limit, status } = queryParsed.data;

      // When the hybrid reader is wired (dual-read flag on), route through
      // it so historical / post-TTL executions from CH surface alongside
      // live Mongo rows. Mongo wins on overlap — see `dual-read-merger.ts`.
      if (deps.hybridReader) {
        const rows = await deps.hybridReader.listByWorkflow({
          tenantId,
          projectId,
          workflowId,
          limit,
          status,
        });
        // H-2 fix: apply cleanExecutionDoc to hybrid reader results — same as the
        // Mongo path. Without this, inputSnapshot, loopData, runCounter, and all
        // STEP_SENSITIVE_FIELDS are exposed when WORKFLOW_DUAL_READ_ENABLED=true.
        return res.json({
          success: true,
          data: rows.map((r) => cleanExecutionDoc(r as Record<string, unknown>)),
        });
      }

      const filter: Record<string, unknown> = { tenantId, projectId, workflowId };
      if (status) {
        filter.status = status;
      }

      const executions = await deps.executionModel
        .find(filter)
        .sort({ startedAt: -1 })
        .limit(limit)
        .lean();

      return res.json({
        success: true,
        data: executions.map((e) => cleanExecutionDoc(e as Record<string, unknown>)),
      });
    }),
  );

  /**
   * GET /:executionId — Get execution detail
   */
  router.get(
    '/:executionId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, {
        requireParams: ['workflowId', 'executionId'],
      });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, executionId } = ctx;

      const execution = await deps.executionModel.findOne({
        _id: executionId,
        tenantId,
        projectId,
        workflowId,
      });

      if (!execution) {
        // Mongo miss. With the dual-read flag on, fall through to the hybrid
        // reader which queries `workflow_executions_latest` in CH — the
        // post-TTL path for historical executions (Phase 6). Returns a
        // minimal shape without `steps`/`nodeExecutions` because the CH
        // projection doesn't carry step-level detail; clients handle the
        // `source: 'ch'` signal to render a reduced view.
        if (deps.hybridReader) {
          const chRow = await deps.hybridReader.getById({
            tenantId,
            projectId,
            workflowId,
            executionId,
          });
          if (chRow) {
            // H-2 fix: apply cleanExecutionDoc so hybrid-reader detail also strips
            // inputSnapshot, loopData, runCounter, and STEP_SENSITIVE_FIELDS.
            return res.json({
              success: true,
              data: cleanExecutionDoc({ ...chRow, steps: [] } as Record<string, unknown>),
            });
          }
        }
        return res.status(404).json({
          success: false,
          error: { code: 'EXECUTION_NOT_FOUND', message: 'Execution not found' },
        });
      }

      // Convert to plain object (handles Mongoose documents)
      const doc =
        typeof (execution as any).toObject === 'function'
          ? (execution as any).toObject()
          : execution;

      return res.json({
        success: true,
        data: cleanExecutionDoc(doc as Record<string, unknown>),
      });
    }),
  );

  /**
   * POST /execute — Manually trigger a workflow
   */
  router.post(
    '/execute',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId } = ctx;

      // Verify workflow exists and belongs to this tenant/project
      const workflow = await deps.workflowModel.findOne({
        _id: workflowId,
        tenantId,
        projectId,
      });

      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' },
        });
      }

      const parsed = executeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const executionId = parsed.data.executionId ?? crypto.randomUUID();
      const {
        triggerType,
        workflowVersionId,
        workflowVersion,
        payload: triggerPayload,
        webhookMode,
        webhookDelivery,
      } = parsed.data;
      const rawTriggerMetadata = parsed.data.triggerMetadata
        ? { ...parsed.data.triggerMetadata }
        : undefined;

      // Studio (browser-JWT) requests must not be able to set callbackUrl —
      // that path would let a JWT user with read access exfiltrate workflow
      // output via a webhook. API-key callers (triggerType=webhook) and
      // trigger-owned paths are trusted to set it (their auth already proves
      // dispatch authority). SSRF protection is enforced downstream in
      // callback-delivery-worker.ts.
      if (rawTriggerMetadata && triggerType === 'studio') {
        delete rawTriggerMetadata.callbackUrl;
        delete rawTriggerMetadata.accessToken;
        delete rawTriggerMetadata.callbackSecret;
        delete rawTriggerMetadata.encryptedAccessToken;
        delete rawTriggerMetadata.encryptedCallbackSecret;
      }

      // Trust boundary for the async-push bearer token: for any non-studio
      // caller that supplied a plaintext `accessToken`, encrypt it tenant-scoped
      // and swap it for `encryptedAccessToken` in the trigger metadata. Every
      // downstream hop (Restate input → MongoDB `triggerMetadata` Mixed field
      // → BullMQ callback job) therefore sees ciphertext; the worker decrypts
      // only in the one frame that builds the outbound Bearer header.
      if (
        rawTriggerMetadata &&
        typeof rawTriggerMetadata.accessToken === 'string' &&
        rawTriggerMetadata.accessToken.length > 0
      ) {
        const plaintext = rawTriggerMetadata.accessToken;
        delete rawTriggerMetadata.accessToken;
        rawTriggerMetadata.encryptedAccessToken = await deps.encryptSecret(plaintext, tenantId);
      }
      if (
        rawTriggerMetadata &&
        typeof rawTriggerMetadata.callbackSecret === 'string' &&
        rawTriggerMetadata.callbackSecret.length > 0
      ) {
        const plaintext = rawTriggerMetadata.callbackSecret;
        delete rawTriggerMetadata.callbackSecret;
        rawTriggerMetadata.encryptedCallbackSecret = await deps.encryptSecret(plaintext, tenantId);
      }

      // ─── Version resolution ────────────────────────────────────────────
      // Precedence:
      //   1. explicit `workflowVersionId` (by _id)
      //   2. semver-string pin `workflowVersion` (state-agnostic)
      //   3. highest-semver active published (semver-desc sort) — skipped for studio runs
      //   4. draft fallback (emits workflow.version.resolution.miss metric)
      // Studio runs always use the working copy (draft) so developers can test
      // edits without publishing first. Non-studio callers (API keys, triggers,
      // webhooks, cron) still resolve the highest published version at step 3.
      // API keys / triggers / tool bindings can pin at step 1 or 2.
      // An explicit miss at step 1 or 2 returns 404 instead of silently running draft.
      let executionDefinition = await buildWorkingCopyExecutionDefinition(
        deps,
        workflow as WorkflowDefinitionDoc,
        { tenantId, projectId, workflowId },
      );

      if (workflowVersionId || workflowVersion) {
        const versionExecutionDefinition = await buildVersionExecutionDefinition(deps, {
          tenantId,
          projectId,
          workflowId,
          workflowVersionId,
          workflowVersion,
        });

        if (versionExecutionDefinition === 'unavailable') {
          return res.status(500).json({
            success: false,
            error: {
              code: 'WORKFLOW_VERSION_RESOLUTION_UNAVAILABLE',
              message: 'Workflow version resolution is unavailable',
            },
          });
        }

        if (!versionExecutionDefinition) {
          return res.status(404).json({
            success: false,
            error: {
              code: 'WORKFLOW_VERSION_NOT_FOUND',
              message: 'Requested workflow version not found',
            },
          });
        }

        executionDefinition = versionExecutionDefinition;
      } else if (triggerType !== 'studio') {
        // Non-studio callers resolve the highest published version so production
        // triggers always run a stable release, not an in-progress draft.
        const defaultVersionExecutionDefinition = await buildDefaultVersionExecutionDefinition(
          deps,
          {
            tenantId,
            projectId,
            workflowId,
          },
        );
        if (defaultVersionExecutionDefinition) {
          executionDefinition = defaultVersionExecutionDefinition;
        }
      }

      // Preflight input validation — returns 4xx to synchronous callers
      // before touching Restate, for a fast UX on malformed payloads. The
      // handler re-runs this as the canonical check (covers every fire path
      // including webhook/cron/agent/poll that bypass this route).
      const preflight = validateAndCoerceInput(
        executionDefinition.startInputVariables,
        triggerPayload,
      );
      if (!preflight.ok) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INPUT_VALIDATION_FAILED',
            message: `${preflight.errors.length} input field${
              preflight.errors.length === 1 ? '' : 's'
            } failed validation`,
            fields: preflight.errors,
          },
        });
      }

      // ── Relay-race path (DEFAULT — always on when persistence is wired) ──
      // Restate 1.6.2 cannot re-dispatch suspended workflow.run handlers after
      // partition leadership transitions, regardless of mechanism (durable
      // promises OR awakeables). ALL long-running async steps (approval,
      // human-task, ADI, Docling) are broken on the legacy startWorkflow() path.
      // The relay race is the only correct path for this Restate build.
      //
      // Emergency opt-out: set RELAY_RACE_DISABLED=true to fall back to the
      // legacy startWorkflow() path (useful only for rollback during a deploy).
      const relayRaceEnabled =
        process.env.RELAY_RACE_DISABLED !== 'true' && deps.persistence != null;

      if (relayRaceEnabled && deps.persistence) {
        const triggerMetadataForPayload = rawTriggerMetadata ?? {
          triggeredBy: (req as any).tenantContext?.userId ?? 'unknown',
          firedAt: new Date().toISOString(),
        };
        const workflowInputPayload = buildWorkflowExecutionPayload({
          workflowId,
          workflowName: workflow.name,
          tenantId,
          projectId,
          triggerType,
          triggerPayload,
          triggerMetadata: triggerMetadataForPayload,
          steps: executionDefinition.steps,
          nameToIdMap: executionDefinition.nameToIdMap,
          outputMappings: executionDefinition.outputMappings,
          outputMappingsByEndNodeId: executionDefinition.outputMappingsByEndNodeId,
          startInputVariables: executionDefinition.startInputVariables,
          inDegreeMap: executionDefinition.inDegreeMap,
          edgeMap: executionDefinition.edgeMap,
          workflowVersion: executionDefinition.workflowVersion,
          workflowVersionId: executionDefinition.workflowVersionId,
          webhookMode,
          webhookDelivery,
        });

        try {
          // Step 1: Create execution record with inputSnapshot so every leg can
          // cold-start from MongoDB without relying on Restate's journal.
          const stepRecords = (
            executionDefinition.steps as Array<{ id: string; type: string; name: string }>
          ).map((s) => ({ stepId: s.id, name: s.name ?? s.id, type: s.type, status: 'pending' }));

          // Derive actual canvas Start and End node IDs so the step index uses
          // the same UUIDs that nextStepIds/canvas edges reference. Falls back
          // to literal 'start'/'end' for legacy workflows without edgeMap.
          // edgeMap is Record<sourceNodeId, EdgeDescriptor[]> — key IS the source UUID.
          const edgeMap = executionDefinition.edgeMap ?? {};
          const startNodeId: string =
            Object.entries(edgeMap).find(([, edges]) =>
              edges.some((e) => e.sourceRuntimeId === 'start'),
            )?.[0] ?? 'start';
          // outputMappingsByEndNodeId keys are canvas End node UUIDs
          const endNodeIds = Object.keys(executionDefinition.outputMappingsByEndNodeId ?? {});
          const endStepRecords =
            endNodeIds.length > 0
              ? endNodeIds.map((id) => ({
                  stepId: id,
                  name: 'End',
                  type: 'end',
                  status: 'pending',
                }))
              : [{ stepId: 'end', name: 'End', type: 'end', status: 'pending' }];

          await deps.persistence.createExecution({
            executionId,
            tenantId,
            projectId,
            workflowId,
            workflowVersionId: executionDefinition.workflowVersionId,
            workflowVersion: executionDefinition.workflowVersion,
            status: 'running',
            triggerType,
            triggerPayload,
            triggerMetadata: triggerMetadataForPayload,
            steps: [
              { stepId: startNodeId, name: 'Start', type: 'start', status: 'completed' },
              ...stepRecords,
              ...endStepRecords,
            ],
            webhookMode,
            webhookDelivery,
            inputSnapshot: workflowInputPayload,
          });

          // Step 2: Compute root step IDs (degree=0 in inDegreeMap, or first step).
          const inDegreeMap = executionDefinition.inDegreeMap ?? {};
          const allStepIds = (executionDefinition.steps as Array<{ id: string }>).map((s) => s.id);
          const rootStepIds =
            Object.keys(inDegreeMap).length > 0
              ? Object.entries(inDegreeMap)
                  .filter(([, deg]) => deg === 0)
                  .map(([id]) => id)
              : allStepIds.slice(0, 1);

          // Step 3: Trigger the first relay-race run.
          const runInput: WorkflowRunInput = {
            tenantId,
            projectId,
            startFromStepIds: rootStepIds,
          };
          await deps.restateClient.startWorkflow(executionId, runInput);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(502).json({
            success: false,
            error: { code: 'RELAY_START_FAILED', message },
          });
        }
      } else {
        // Legacy path — startLegacyWorkflow() → Restate handler creates execution record.
        try {
          await deps.restateClient.startLegacyWorkflow(
            executionId,
            buildWorkflowExecutionPayload({
              workflowId,
              workflowName: workflow.name,
              tenantId,
              projectId,
              triggerType,
              triggerPayload,
              triggerMetadata: rawTriggerMetadata ?? {
                triggeredBy: (req as any).tenantContext?.userId ?? 'unknown',
                firedAt: new Date().toISOString(),
              },
              steps: executionDefinition.steps,
              nameToIdMap: executionDefinition.nameToIdMap,
              outputMappings: executionDefinition.outputMappings,
              outputMappingsByEndNodeId: executionDefinition.outputMappingsByEndNodeId,
              startInputVariables: executionDefinition.startInputVariables,
              inDegreeMap: executionDefinition.inDegreeMap,
              edgeMap: executionDefinition.edgeMap,
              workflowVersion: executionDefinition.workflowVersion,
              workflowVersionId: executionDefinition.workflowVersionId,
              webhookMode,
              webhookDelivery,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(502).json({
            success: false,
            error: { code: 'RESTATE_START_FAILED', message },
          });
        }
      }

      return res.status(202).json({ success: true, executionId });
    }),
  );

  /**
   * POST /:executionId/cancel — Cancel a running execution
   */
  router.post(
    '/:executionId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, {
        requireParams: ['workflowId', 'executionId'],
      });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, executionId } = ctx;

      const execution = (await deps.executionModel.findOne({
        _id: executionId,
        tenantId,
        projectId,
        workflowId,
      })) as { status?: string } | null;

      if (!execution) {
        return res.status(404).json({
          success: false,
          error: { code: 'EXECUTION_NOT_FOUND', message: 'Execution not found' },
        });
      }

      if (!CANCELLABLE_STATUSES.includes(execution.status ?? '')) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_CANCELLABLE',
            message: `Cannot cancel execution in '${execution.status}' status`,
          },
        });
      }

      // G-1 fix: relay-race executions use workflow-executor (restate.object), not
      // workflow-runner (restate.workflow). cancelLegacyWorkflow targets the legacy service.
      // For relay-race executions (inputSnapshot present), call cancelWorkflow instead.
      // cancelWorkflow writes cancelled status to MongoDB; future runs detect it at cold-start.
      // cancelLegacyWorkflow is kept as a no-op safety call for legacy in-flight executions.
      const isRelayRace = !!(execution as Record<string, unknown>).inputSnapshot;
      try {
        if (isRelayRace) {
          await deps.restateClient.cancelWorkflow(executionId, tenantId, projectId);
        } else {
          await deps.restateClient.cancelLegacyWorkflow(executionId);
        }
      } catch (err: unknown) {
        // Restate may be unavailable — still mark as cancelled in our DB.
        // The user's intent to cancel is recorded regardless.
        void err; // Captured but non-fatal; DB update below serves as the source of truth
      }

      // Mark execution as cancelled and transition any in-flight step statuses
      // in context.steps. Aggregation pipeline update allows conditional field
      // transforms on an embedded object without positional array operators.
      const ACTIVE_NODE_STATUSES = [
        'running',
        'waiting_approval',
        'waiting_human_task',
        'waiting_delay',
        'waiting_callback',
      ];
      await deps.executionModel.findOneAndUpdate(
        { _id: executionId, tenantId, projectId, workflowId },
        [
          {
            $set: {
              status: 'cancelled',
              cancelledAt: new Date(),
              completedAt: new Date(),
            },
          },
          {
            $set: {
              'context.steps': {
                $arrayToObject: {
                  $map: {
                    input: { $objectToArray: { $ifNull: ['$context.steps', {}] } },
                    as: 'e',
                    in: {
                      k: '$$e.k',
                      v: {
                        $cond: {
                          if: { $in: ['$$e.v.status', ACTIVE_NODE_STATUSES] },
                          then: { $mergeObjects: ['$$e.v', { status: 'cancelled' }] },
                          else: '$$e.v',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      );

      // Cancel any pending/assigned human tasks tied to this execution
      if (deps.humanTaskModel) {
        const cancelledBy = (req as any).tenantContext?.userId ?? 'unknown';
        await deps.humanTaskModel.updateMany(
          {
            'source.executionId': executionId,
            tenantId,
            projectId,
            status: { $in: ['pending', 'assigned', 'in_progress'] },
          },
          {
            $set: {
              status: 'cancelled',
              response: {
                respondedBy: cancelledBy,
                respondedAt: new Date(),
                fields: {},
                notes: 'Workflow run cancelled by user',
                decision: 'cancelled',
              },
            },
          },
        );
      }

      await deps.publisher.publish(
        `workflow:${tenantId}:execution:${executionId}:status`,
        JSON.stringify({ type: 'workflow.cancelled', executionId }),
      );

      return res.json({ success: true, message: 'Execution cancelled' });
    }),
  );

  return router;
}
