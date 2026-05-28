/**
 * PipelineRun — Restate durable workflow that interprets a pipeline DAG.
 *
 * The `run` handler walks through the pipeline's steps array, executing each
 * via the ActivityRouter service. It supports:
 *
 * - Conditional steps (skip based on expression evaluation)
 * - Parallel groups (fan-out via RestatePromise.all, fan-in to collect outputs)
 * - Early stop (step returns data.pipelineShouldStop === true)
 * - Durable state (step progress survives crashes, queryable via getStatus)
 * - Persistence (run result written to MongoDB for long-term history)
 *
 * The `getStatus` shared handler allows the API layer to query live execution
 * progress without blocking the workflow.
 */
import * as restate from '@restatedev/restate-sdk';
import { buildExecutionContext } from '../execution-context.js';
import { evaluateExpression } from '../expression-evaluator.js';
import { resolveTransition } from '../graph-utils.js';
import { buildStepOutputReferences } from '../node-references.js';
import { activityRouter } from './activity-router.service.js';
import { alertEvaluatorService } from '../services/alert-evaluator.service.js';
import { PipelineRunRecordModel } from '../../schemas/pipeline-run-record.schema.js';
import type {
  PipelineDefinition,
  PipelineRunInput,
  PipelineStep,
  PipelineNode,
  ResolvedPipelineConfig,
  StepOutput,
} from '../types.js';
import { PipelineConfigService } from '../services/pipeline-config.service.js';
import type { PipelineType } from '../../schemas/pipeline-config.schema.js';

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('pipeline-run');

const DEFAULT_MAX_VISITS = 1;
const MAX_VISITS_HARD_CAP = 100;

// ---------------------------------------------------------------------------
// Step state shape — stored in Restate durable state, exposed via getStatus
// ---------------------------------------------------------------------------

interface StepState {
  id: string;
  name: string;
  type: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Failure alert hook — fire-and-forget, never fails the pipeline
// ---------------------------------------------------------------------------

function fireFailureAlertIfNeeded(
  ctx: restate.WorkflowContext,
  overallStatus: string,
  tenantId: string,
  projectId: string,
): void {
  if (overallStatus !== 'failed') return;
  try {
    ctx.serviceSendClient(alertEvaluatorService).execute({
      config: { tenantId, projectId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Failed to fire failure alert hook (non-fatal)', { tenantId, projectId, error: msg });
  }
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export const pipelineRun = restate.workflow({
  name: 'PipelineRun',
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      input: PipelineRunInput,
    ): Promise<{ status: string; stepOutputs: Record<string, StepOutput> }> => {
      const { pipelineDefinition, pipelineInput } = input;
      const sessionId = pipelineInput.sessionId as string | undefined;
      const runId = pipelineInput.runId as string | undefined;

      log.debug('Pipeline run started', {
        runId,
        sessionId,
        pipelineId: pipelineDefinition._id,
        tenantId: pipelineInput.tenantId,
        mode: pipelineDefinition.nodes?.length ? 'graph' : 'legacy',
      });

      // ── Graph mode: nodes[] with transitions ──
      const hasGraphNodes =
        pipelineDefinition.nodes &&
        pipelineDefinition.nodes.length > 0 &&
        pipelineDefinition.entryNodeId;

      if (hasGraphNodes) {
        return await runGraphMode(ctx, input);
      }

      // ── Legacy mode: steps[] array ──
      const steps = input.steps ?? pipelineDefinition.steps ?? [];
      const executionMode = input.executionMode ?? 'batch';
      const triggerId = input.matchedTriggerId ?? 'default';
      const stepOutputs: Record<string, StepOutput> = {};

      // Initialize durable state -- survives crashes, queryable via getStatus.
      // ctx.set() is synchronous (void) in Restate SDK v1.10.
      ctx.set('status', 'running');
      ctx.set(
        'steps',
        steps.map((s) => ({
          id: s.id,
          name: s.name ?? s.id,
          type: s.activity ?? s.type ?? 'unknown',
          status: 'pending',
        })),
      );
      ctx.set('startedAt', await ctx.run('ts-workflow-start', () => Date.now()));

      // Resolve pipeline config (once per run) — skipped for legacy definitions without pipelineType
      let resolvedConfig: ResolvedPipelineConfig | undefined;
      if (pipelineDefinition.pipelineType) {
        resolvedConfig = await ctx.run('resolve-pipeline-config', async () => {
          const svc = new PipelineConfigService();
          const config = await svc.resolveConfig(
            pipelineInput.tenantId,
            pipelineDefinition.pipelineType as PipelineType,
            pipelineInput.projectId,
          );

          if (!config) return undefined;

          const rawConfig = config.config ?? {};
          const {
            stepOverrides = {},
            timeoutOverrides = {},
            ...pipelineWide
          } = rawConfig as Record<string, any>;
          const configSource: 'project' | 'tenant' = config.projectId ? 'project' : 'tenant';

          return {
            pipelineConfig: { ...pipelineWide, timeoutOverrides },
            stepOverrides: stepOverrides as Record<string, Record<string, unknown>>,
            configVersion: config.version,
            configSource,
          };
        });
      }

      // Extract timeout overrides from resolved config (step ID → timeout ms)
      const timeoutOverrides: Record<string, number> =
        ((resolvedConfig?.pipelineConfig as Record<string, any>)?.timeoutOverrides as
          | Record<string, number>
          | undefined) ?? {};

      let i = 0;

      while (i < steps.length) {
        const step = steps[i];

        // -- 1. Evaluate condition ------------------------------------------
        if (step.condition) {
          const conditionExpr =
            typeof step.condition === 'string' ? step.condition : step.condition.expression;
          const shouldRun = evaluateExpression(conditionExpr, stepOutputs, pipelineInput);

          if (!shouldRun) {
            stepOutputs[step.id] = { status: 'skipped', data: {} };
            await updateStepState(ctx, step.id, 'skipped');
            i++;
            continue;
          }
        }

        // -- 2. Parallel group ----------------------------------------------
        if (step.parallel) {
          const groupTag = step.parallel;
          const parallelSteps: PipelineStep[] = [];

          while (i < steps.length && steps[i].parallel === groupTag) {
            parallelSteps.push(steps[i]);
            i++;
          }

          // Mark all as running
          for (const ps of parallelSteps) {
            await updateStepState(ctx, ps.id, 'running');
          }

          // Fan-out: call activity services concurrently via durable RPC
          const results = await restate.CombineablePromise.all(
            parallelSteps.map((ps) =>
              ctx.serviceClient(activityRouter).execute({
                step: applyTimeoutOverride(ps, timeoutOverrides),
                previousSteps: stepOutputs,
                pipelineInput,
                resolvedConfig,
                executionMode,
                triggerId,
                pipelineId: pipelineDefinition._id,
                pipelineName: pipelineDefinition.name,
                pipelineType: pipelineDefinition.tenantId === '__platform__' ? 'builtin' : 'custom',
              }),
            ),
          );

          // Fan-in: collect outputs, update state
          for (let j = 0; j < parallelSteps.length; j++) {
            stepOutputs[parallelSteps[j].id] = results[j];
            await updateStepState(
              ctx,
              parallelSteps[j].id,
              results[j].status,
              results[j].durationMs,
            );
          }

          continue;
        }

        // -- 3. Sequential step ---------------------------------------------
        await updateStepState(ctx, step.id, 'running');

        const result = await ctx.serviceClient(activityRouter).execute({
          step: applyTimeoutOverride(step, timeoutOverrides),
          previousSteps: stepOutputs,
          pipelineInput,
          resolvedConfig,
          executionMode,
          triggerId,
          pipelineId: pipelineDefinition._id,
          pipelineName: pipelineDefinition.name,
          pipelineType: pipelineDefinition.tenantId === '__platform__' ? 'builtin' : 'custom',
        });

        stepOutputs[step.id] = result;
        await updateStepState(ctx, step.id, result.status, result.durationMs);

        // -- 4. Check for early stop ----------------------------------------
        if (result.data?.pipelineShouldStop === true) {
          for (let j = i + 1; j < steps.length; j++) {
            stepOutputs[steps[j].id] = { status: 'skipped', data: {} };
            await updateStepState(ctx, steps[j].id, 'skipped');
          }
          break;
        }

        // -- 4b. Handle step failure strategy --------------------------------
        if (result.status === 'fail') {
          const failureStrategy = step.onFailure ?? pipelineDefinition.onStepFailure ?? 'stop';

          if (failureStrategy === 'stop') {
            // Skip remaining steps and break
            for (let j = i + 1; j < steps.length; j++) {
              stepOutputs[steps[j].id] = { status: 'skipped', data: {} };
              await updateStepState(ctx, steps[j].id, 'skipped');
            }
            break;
          }

          if (failureStrategy === 'skip') {
            // Mark as skipped (overwrite fail) and continue
            stepOutputs[step.id] = { status: 'skipped', data: result.data };
            await updateStepState(ctx, step.id, 'skipped', result.durationMs);
          }
          // 'continue' — keep fail status, proceed to next step
        }

        i++;
      }

      // -- 5. Finalize ------------------------------------------------------
      const overallStatus = Object.values(stepOutputs).some((o) => o.status === 'fail')
        ? 'failed'
        : 'completed';

      if (overallStatus === 'failed') {
        const failedSteps = Object.entries(stepOutputs)
          .filter(([, o]) => o.status === 'fail')
          .map(([id, o]) => ({ stepId: id, error: o.data?.error ?? 'unknown' }));
        log.warn('Pipeline failed', {
          runId,
          sessionId,
          pipelineId: pipelineDefinition._id,
          failedSteps,
        });
      }

      log.debug('Pipeline run completed', {
        runId,
        sessionId,
        pipelineId: pipelineDefinition._id,
        status: overallStatus,
        stepCount: Object.keys(stepOutputs).length,
      });

      ctx.set('status', overallStatus);
      ctx.set('completedAt', await ctx.run('ts-workflow-end', () => Date.now()));

      // Persist to MongoDB for long-term history
      await ctx.run('persist-to-mongo', async () => {
        await persistRunToMongo(ctx.key, {
          pipelineId: pipelineDefinition._id,
          pipelineVersion: pipelineDefinition.version,
          tenantId: pipelineInput.tenantId,
          status: overallStatus,
          stepOutputs,
        });
      });

      // Fire failure alert hook (fire-and-forget, never fails pipeline)
      fireFailureAlertIfNeeded(ctx, overallStatus, pipelineInput.tenantId, pipelineInput.projectId);

      return { status: overallStatus, stepOutputs };
    },

    // -- Shared handler: query live execution status -------------------------
    // Called by the API layer. Does not block the workflow.
    getStatus: restate.handlers.workflow.shared(async (ctx: restate.WorkflowSharedContext) => ({
      status: (await ctx.get<string>('status')) ?? 'unknown',
      steps: (await ctx.get<StepState[]>('steps')) ?? [],
      startedAt: await ctx.get<number>('startedAt'),
      completedAt: await ctx.get<number>('completedAt'),
    })),
  },
});

/** Export the type for use by other Restate services or the client. */
export type PipelineRunWorkflow = typeof pipelineRun;

// ---------------------------------------------------------------------------
// Graph mode — durable graph walker using Restate
// ---------------------------------------------------------------------------

/**
 * Execute a graph-based pipeline inside Restate's durable workflow.
 * Follows transitions from entryNodeId, executing each node via ActivityRouter.
 */
async function runGraphMode(
  ctx: restate.WorkflowContext,
  input: PipelineRunInput,
): Promise<{ status: string; stepOutputs: Record<string, StepOutput> }> {
  const { pipelineDefinition, pipelineInput } = input;
  const nodes = pipelineDefinition.nodes!;
  const entryNodeId = pipelineDefinition.entryNodeId!;
  const executionMode = input.executionMode ?? 'batch';
  const triggerId = input.matchedTriggerId ?? 'default';
  const graphSessionId = pipelineInput.sessionId as string | undefined;
  const graphRunId = pipelineInput.runId as string | undefined;
  const nodeOutputs: Record<string, StepOutput> = {};
  const executionContext: Record<string, Record<string, any>> = {};
  const visitCounts: Record<string, number> = {};
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  log.debug('Graph mode execution started', {
    runId: graphRunId,
    sessionId: graphSessionId,
    pipelineId: pipelineDefinition._id,
    entryNodeId,
    nodeCount: nodes.length,
  });

  // Initialize durable state
  ctx.set('status', 'running');
  ctx.set(
    'steps',
    nodes.map((n) => ({
      id: n.id,
      name: n.label ?? n.id,
      type: n.type,
      status: 'pending',
    })),
  );
  ctx.set('startedAt', await ctx.run('ts-workflow-start', () => Date.now()));

  // Resolve pipeline config
  const resolvedConfig = await resolvePipelineConfig(ctx, pipelineDefinition, pipelineInput);

  let currentNodeId: string | null = entryNodeId;

  while (currentNodeId) {
    const node = nodeMap.get(currentNodeId);
    if (!node) break;

    // Loop guard
    visitCounts[node.id] = (visitCounts[node.id] ?? 0) + 1;
    const maxVisits = Math.min(node.maxVisits ?? DEFAULT_MAX_VISITS, MAX_VISITS_HARD_CAP);

    if (visitCounts[node.id] > maxVisits) {
      nodeOutputs[node.id] = {
        status: 'fail',
        data: { error: `Max visits (${maxVisits}) exceeded for node '${node.id}'` },
      };
      await updateStepState(ctx, node.id, 'fail');
      break;
    }

    // Execute node via ActivityRouter
    await updateStepState(ctx, node.id, 'running');

    const result = await ctx.serviceClient(activityRouter).execute({
      step: {
        id: node.id,
        type: node.type,
        config: node.config,
        timeout: node.timeout,
        retries: node.retries,
        onFailure: node.onFailure,
        ...(node.children ? { children: node.children } : {}),
      },
      previousSteps: buildStepOutputReferences(nodes, nodeOutputs),
      executionContext,
      pipelineInput,
      resolvedConfig,
      executionMode,
      triggerId,
      pipelineId: pipelineDefinition._id,
      pipelineName: pipelineDefinition.name,
      pipelineType: pipelineDefinition.tenantId === '__platform__' ? 'builtin' : 'custom',
    });

    nodeOutputs[node.id] = result;

    // Build execution context — write node output under its contextKey
    buildExecutionContext(executionContext, node.type, result, undefined, node.children);

    await updateStepState(ctx, node.id, result.status, result.durationMs);

    // Handle failure
    if (result.status === 'fail') {
      const failStrategy = node.onFailure ?? pipelineDefinition.onNodeFailure ?? 'stop';
      if (failStrategy === 'stop') {
        break;
      }
    }

    // Early stop
    if (result.data?.pipelineShouldStop === true) {
      break;
    }

    // Resolve next node
    const context = {
      input: pipelineInput,
      nodeOutputs: buildStepOutputReferences(nodes, nodeOutputs),
    };
    currentNodeId = resolveTransition(node.transitions, result, context);
  }

  // Finalize
  const overallStatus = Object.values(nodeOutputs).some((o) => o.status === 'fail')
    ? 'failed'
    : 'completed';

  log.debug('Graph mode execution completed', {
    runId: graphRunId,
    sessionId: graphSessionId,
    pipelineId: pipelineDefinition._id,
    status: overallStatus,
    nodeCount: Object.keys(nodeOutputs).length,
  });

  ctx.set('status', overallStatus);
  ctx.set('completedAt', await ctx.run('ts-workflow-end', () => Date.now()));

  await ctx.run('persist-to-mongo', async () => {
    await persistRunToMongo(ctx.key, {
      pipelineId: pipelineDefinition._id,
      pipelineVersion: pipelineDefinition.version,
      tenantId: pipelineInput.tenantId,
      status: overallStatus,
      stepOutputs: nodeOutputs,
    });
  });

  // Fire failure alert hook (fire-and-forget, never fails pipeline)
  fireFailureAlertIfNeeded(ctx, overallStatus, pipelineInput.tenantId, pipelineInput.projectId);

  return { status: overallStatus, stepOutputs: nodeOutputs };
}

/**
 * Resolve pipeline config — shared between legacy and graph modes.
 */
async function resolvePipelineConfig(
  ctx: restate.WorkflowContext,
  pipelineDefinition: PipelineDefinition,
  pipelineInput: Record<string, any>,
): Promise<ResolvedPipelineConfig | undefined> {
  if (!pipelineDefinition.pipelineType) return undefined;

  return ctx.run('resolve-pipeline-config', async () => {
    const svc = new PipelineConfigService();
    const config = await svc.resolveConfig(
      pipelineInput.tenantId,
      pipelineDefinition.pipelineType as PipelineType,
      pipelineInput.projectId,
    );

    if (!config) return undefined;

    const rawConfig = config.config ?? {};
    const {
      stepOverrides = {},
      timeoutOverrides = {},
      ...pipelineWide
    } = rawConfig as Record<string, any>;
    const configSource: 'project' | 'tenant' = config.projectId ? 'project' : 'tenant';

    return {
      pipelineConfig: { ...pipelineWide, timeoutOverrides },
      stepOverrides: stepOverrides as Record<string, Record<string, unknown>>,
      configVersion: config.version,
      configSource,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Update a single step's status in the workflow's durable state.
 * Makes step progress queryable via the getStatus shared handler.
 *
 * Uses async get + synchronous set pattern: ctx.get() returns Promise,
 * ctx.set() is void. Both are journaled by Restate for deterministic replay.
 */
async function updateStepState(
  ctx: restate.WorkflowContext,
  stepId: string,
  status: string,
  durationMs?: number,
): Promise<void> {
  const steps = (await ctx.get<StepState[]>('steps')) ?? [];
  const step = steps.find((s) => s.id === stepId);
  if (step) {
    step.status = status;
    if (status === 'running') {
      step.startedAt = await ctx.run(`ts-${stepId}-start`, () => Date.now());
    }
    if (status !== 'running' && status !== 'pending') {
      step.completedAt = await ctx.run(`ts-${stepId}-end`, () => Date.now());
      if (durationMs !== undefined) {
        step.durationMs = durationMs;
      }
    }
  }
  ctx.set('steps', steps);
}

/**
 * Apply timeout override from pipeline config to a step.
 * Returns the original step if no override exists.
 */
function applyTimeoutOverride(step: PipelineStep, overrides: Record<string, number>): PipelineStep {
  const override = overrides[step.id];
  if (override !== undefined) {
    return { ...step, timeout: override };
  }
  return step;
}

/**
 * Persist run completion to MongoDB.
 * Updates the run record created by PipelineTrigger with final status and step outputs.
 */
async function persistRunToMongo(
  runId: string,
  data: {
    pipelineId: string;
    pipelineVersion: number;
    tenantId: string;
    status: string;
    stepOutputs: Record<string, StepOutput>;
  },
): Promise<void> {
  log.info('Persisting run to MongoDB', {
    runId,
    pipelineId: data.pipelineId,
    tenantId: data.tenantId,
    status: data.status,
    stepCount: Object.keys(data.stepOutputs).length,
  });
  const now = new Date();
  await PipelineRunRecordModel.findOneAndUpdate(
    { runId, tenantId: data.tenantId },
    {
      $set: {
        status: data.status,
        completedAt: now,
        steps: Object.entries(data.stepOutputs).map(([stepId, output]) => ({
          id: stepId,
          status: output.status === 'success' ? 'completed' : output.status,
          durationMs: output.durationMs,
          output: output.data,
        })),
      },
    },
  );
}
