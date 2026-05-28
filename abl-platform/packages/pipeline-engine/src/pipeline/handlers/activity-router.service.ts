/**
 * ActivityRouter — Restate service that routes step execution to activity services.
 *
 * Dispatches to the real activity service handler based on step.type.
 * Handlers are called directly (not via ctx.serviceClient) since:
 * 1. The workflow already calls ActivityRouter via ctx.serviceClient (durability boundary)
 * 2. Each handler manages its own ctx.run() blocks for journal durability
 * 3. Nested ctx.run() calls would violate Restate's journal model
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { ACTIVITY_TYPES } from '../activity-metadata.js';
import type {
  PipelineStep,
  PipelineStepContext,
  ResolvedPipelineConfig,
  StepOutput,
} from '../types.js';

const log = createLogger('activity-router');

// Import real service modules
import { evaluateMetricsService } from '../services/evaluate-metrics.service.js';
import { evaluatePolicyService } from '../services/evaluate-policy.service.js';
import { sendNotificationService } from '../services/send-notification.service.js';
import { storeResultsService } from '../services/store-results.service.js';
import { transformService } from '../services/transform.service.js';
import { inspectOutputService } from '../services/inspect-output.service.js';
import { runLegacyWorkflowService } from '../services/run-legacy-workflow.service.js';
import { storeInsightService } from '../services/store-insight.service.js';
import { computeToxicityService } from '../services/compute-toxicity.service.js';
import { computeToolEffectivenessService } from '../services/compute-tool-effectiveness.service.js';
import { llmEvaluateService } from '../services/llm-evaluate.service.js';
import { readConversationService } from '../services/read-conversation.service.js';
import { computeSentimentService } from '../services/compute-sentiment.service.js';
import { computeIntentService } from '../services/compute-intent.service.js';
import { evaluateResolutionService } from '../services/evaluate-resolution.service.js';
import { computeQualityService } from '../services/compute-quality.service.js';
import { conversationAnalyzerService } from '../services/compute-llm-evaluation.service.js';
import { computeStatisticalService } from '../services/compute-statistical.service.js';
import { computePredictiveFeaturesService } from '../services/compute-predictive-features.service.js';
import { computeMentionsService } from '../services/compute-mentions.service.js';
import { computeGoalCompletionService } from '../services/compute-goal-completion.service.js';
import { readMessageWindowService } from '../services/read-message-window.service.js';
import { httpRequestService } from '../services/http-request.service.js';

// Extended node types
import { subPipelineService } from '../services/sub-pipeline.service.js';
import { dbQueryService } from '../services/db-query.service.js';
import { filterService } from '../services/filter.service.js';
import { aggregateService } from '../services/aggregate.service.js';
import { sendEmailService } from '../services/send-email.service.js';
import { sendSlackService } from '../services/send-slack.service.js';
import { publishKafkaService } from '../services/publish-kafka.service.js';

// Eval pipeline services
import { simulatePersonaService } from '../services/eval/simulate-persona.service.js';
import { executeAgentTurnService } from '../services/eval/execute-agent-turn.service.js';
import { runEvalConversationService } from '../services/eval/run-eval-conversation.service.js';
import { judgeConversationService } from '../services/eval/judge-conversation.service.js';
import { aggregateEvalRunService } from '../services/eval/aggregate-eval-run.service.js';

/** Input shape for the execute handler. */
export interface ActivityRouterInput {
  step: PipelineStep;
  previousSteps: Record<string, StepOutput>;
  executionContext?: Record<string, Record<string, any>>;
  pipelineInput: Record<string, any>;
  resolvedConfig?: ResolvedPipelineConfig;
  executionMode?: 'batch' | 'realtime';
  triggerId?: string;
  pipelineId?: string;
  pipelineName?: string;
  pipelineType?: 'builtin' | 'custom';
}

/**
 * Dispatch table: maps activity type → raw handler function.
 *
 * Restate wraps service definitions so handlers are at .service.execute,
 * not .handlers.execute. Using `as any` because the Restate SDK types
 * don't expose the internal service property.
 */
const SERVICE_HANDLERS: Record<
  string,
  (ctx: restate.Context, input: PipelineStepContext) => Promise<StepOutput>
> = {
  'evaluate-metrics': (evaluateMetricsService as any).service.execute,
  'evaluate-policy': (evaluatePolicyService as any).service.execute,
  'send-notification': (sendNotificationService as any).service.execute,
  'store-results': (storeResultsService as any).service.execute,
  transform: (transformService as any).service.execute,
  'inspect-output': (inspectOutputService as any).service.execute,
  'run-legacy-workflow': (runLegacyWorkflowService as any).service.execute,
  'store-insight': (storeInsightService as any).service.execute,
  'compute-toxicity': (computeToxicityService as any).service.execute,
  'compute-tool-effectiveness': (computeToolEffectivenessService as any).service.execute,
  'llm-evaluate': (llmEvaluateService as any).service.execute,
  'call-llm': (llmEvaluateService as any).service.execute,
  'read-conversation': (readConversationService as any).service.execute,
  'read-message-window': (readMessageWindowService as any).service.execute,
  'compute-sentiment': (computeSentimentService as any).service.execute,
  'compute-intent': (computeIntentService as any).service.execute,
  'evaluate-resolution': (evaluateResolutionService as any).service.execute,
  'compute-quality': (computeQualityService as any).service.execute,
  'conversation-analyzer': (conversationAnalyzerService as any).service.execute,
  'compute-statistical': (computeStatisticalService as any).service.execute,
  'compute-predictive-features': (computePredictiveFeaturesService as any).service.execute,
  'compute-mentions': (computeMentionsService as any).service.execute,
  'compute-goal-completion': (computeGoalCompletionService as any).service.execute,
  'http-request': (httpRequestService as any).service.execute,
  // Extended node types
  'sub-pipeline': (subPipelineService as any).service.execute,
  'db-query': (dbQueryService as any).service.execute,
  filter: (filterService as any).service.execute,
  aggregate: (aggregateService as any).service.execute,
  'send-email': (sendEmailService as any).service.execute,
  'send-slack': (sendSlackService as any).service.execute,
  'publish-kafka': (publishKafkaService as any).service.execute,
  // Eval pipeline services
  'simulate-persona': (simulatePersonaService as any).service.execute,
  'execute-agent-turn': (executeAgentTurnService as any).service.execute,
  'run-eval-conversation': (runEvalConversationService as any).service.execute,
  'judge-conversation': (judgeConversationService as any).service.execute,
  'aggregate-eval-run': (aggregateEvalRunService as any).service.execute,
};

/**
 * Export the dispatch table so preview.service.ts can call handlers directly
 * (with a mock Restate context) without spinning up a Restate workflow.
 */
export { SERVICE_HANDLERS };

export const activityRouter = restate.service({
  name: 'ActivityRouter',
  handlers: {
    execute: async (ctx: restate.Context, input: ActivityRouterInput): Promise<StepOutput> => {
      const {
        step,
        previousSteps,
        executionContext,
        pipelineInput,
        resolvedConfig,
        executionMode,
        triggerId,
        pipelineId,
        pipelineName,
        pipelineType,
      } = input;
      const startTime = Date.now();

      const activityType = step.activity ?? step.type;

      // Handle node-group: fan out children in parallel
      if (activityType === 'node-group' && (step as any).children) {
        return await executeNodeGroup(ctx, input);
      }

      // Handle wait-for-event: suspend until external signal via awakeable
      if (activityType === 'wait-for-event') {
        const config = step.config ?? {};
        const eventName = config.eventName;
        if (!eventName) {
          return {
            status: 'fail',
            data: { error: 'wait-for-event requires eventName in config' },
            durationMs: Date.now() - startTime,
          };
        }
        try {
          // Create awakeable — suspends until resolved externally via resolveAwakeable
          const awakeable = ctx.awakeable<Record<string, any>>();
          const data = await awakeable.promise;
          return {
            status: 'success',
            data: { ...(data ?? {}), eventName, awakeableId: awakeable.id },
            durationMs: Date.now() - startTime,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            status: 'fail',
            data: { error: `wait-for-event failed: ${msg}` },
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Handle delay: durable sleep
      if (activityType === 'delay') {
        const config = step.config ?? {};
        const durationMs = config.durationMs;
        if (!durationMs || typeof durationMs !== 'number') {
          return {
            status: 'fail',
            data: { error: 'delay requires durationMs (number) in config' },
            durationMs: Date.now() - startTime,
          };
        }
        await ctx.sleep(durationMs);
        return {
          status: 'success',
          data: { delayed: durationMs },
          durationMs: Date.now() - startTime,
        };
      }

      const metadata = activityType ? ACTIVITY_TYPES[activityType] : undefined;
      if (!metadata) {
        return {
          status: 'fail',
          data: { error: `Unknown activity type: '${activityType}'` },
        };
      }

      // Merge config: pipeline-wide config < step overrides < trigger step overrides < definition step.config
      // Step config from the definition always has highest priority.
      const mergedConfig = mergeStepConfig(step, resolvedConfig, triggerId);

      const sessionId = pipelineInput.sessionId as string | undefined;

      log.debug('Routing activity', {
        stepId: step.id,
        activityType,
        sessionId,
        pipelineId,
        runId: pipelineInput.runId,
      });

      const stepContext: PipelineStepContext = {
        tenantId: pipelineInput.tenantId,
        projectId: pipelineInput.projectId,
        sessionId: pipelineInput.sessionId,
        executionMode: executionMode ?? 'batch',
        triggerId: triggerId ?? 'default',
        pipelineId,
        pipelineName,
        pipelineType,
        stepId: step.id,
        stepType: activityType,
        config: mergedConfig,
        previousSteps,
        executionContext,
        pipelineInput,
      };

      try {
        const handler = activityType ? SERVICE_HANDLERS[activityType] : undefined;
        if (!handler) {
          return {
            status: 'fail',
            data: { error: `No handler registered for activity type: '${activityType}'` },
            durationMs: Date.now() - startTime,
          };
        }

        // Call handler directly — it manages its own ctx.run() blocks.
        // Do NOT wrap in ctx.run() (would nest ctx.run calls, breaking Restate journal).
        const result = await handler(ctx, stepContext);

        if (result.status === 'fail') {
          log.warn('Step failed', {
            stepId: step.id,
            activityType,
            sessionId,
            pipelineId,
            runId: pipelineInput.runId,
            error: result.data?.error ?? 'unknown',
          });
        } else {
          log.debug('Step completed', {
            stepId: step.id,
            activityType,
            sessionId,
            pipelineId,
            runId: pipelineInput.runId,
            status: result.status,
            durationMs: Date.now() - startTime,
          });
        }

        return { ...result, durationMs: Date.now() - startTime };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Step threw exception', {
          stepId: step.id,
          activityType,
          sessionId,
          pipelineId,
          runId: pipelineInput.runId,
          error: msg,
        });
        return {
          status: 'fail',
          data: {
            error: msg,
            type: activityType,
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type ActivityRouterService = typeof activityRouter;

// ---------------------------------------------------------------------------
// Config merge helper
// ---------------------------------------------------------------------------

/**
 * Merge config layers for a step. Later layers win.
 *
 * Merge order:
 *   1. Pipeline-wide config (minus stepOverrides/triggerConfigs keys)
 *   2. Per-step overrides from pipeline config (stepOverrides[step.id])
 *   3. Trigger-specific step overrides (triggerConfigs[triggerId].stepOverrides[step.id])
 *   4. Step config from definition (highest priority)
 *   5. configVersion metadata injected from resolved config
 */
function mergeStepConfig(
  step: PipelineStep,
  resolvedConfig?: ResolvedPipelineConfig,
  triggerId?: string,
): Record<string, any> {
  if (!resolvedConfig) {
    return step.config ?? {};
  }

  const { pipelineConfig, stepOverrides, configVersion } = resolvedConfig;

  // Layer 1: pipeline-wide config (exclude internal keys)
  const {
    stepOverrides: _ignored,
    triggerConfigs: _ignored2,
    ...pipelineWide
  } = pipelineConfig as Record<string, any>;

  // Layer 2: per-step overrides
  const perStep = stepOverrides[step.id] ?? {};

  // Layer 3: trigger-specific step overrides
  let triggerStepOverrides: Record<string, any> = {};
  if (triggerId) {
    const triggerConfigs = (pipelineConfig as Record<string, any>).triggerConfigs;
    if (triggerConfigs) {
      // Support both Map (Mongoose) and plain object (lean) access
      const triggerConfig =
        typeof triggerConfigs.get === 'function'
          ? triggerConfigs.get(triggerId)
          : triggerConfigs[triggerId];
      if (triggerConfig?.stepOverrides) {
        const so = triggerConfig.stepOverrides;
        triggerStepOverrides =
          typeof so.get === 'function' ? (so.get(step.id) ?? {}) : (so[step.id] ?? {});
      }
    }
  }

  // Layer 4: definition step config (highest priority)
  // Layer 5: inject configVersion metadata
  return {
    ...pipelineWide,
    ...perStep,
    ...triggerStepOverrides,
    ...step.config,
    configVersion,
  };
}

// ---------------------------------------------------------------------------
// Node-group parallel execution
// ---------------------------------------------------------------------------

/**
 * Execute a node-group's children in parallel via recursive ActivityRouter calls.
 * Children cannot have transitions — only the parent group can.
 */
async function executeNodeGroup(
  ctx: restate.Context,
  input: ActivityRouterInput,
): Promise<StepOutput> {
  const {
    step,
    previousSteps,
    executionContext,
    pipelineInput,
    resolvedConfig,
    executionMode,
    triggerId,
    pipelineId,
    pipelineName,
    pipelineType,
  } = input;
  const children = (step as any).children as Array<{
    id: string;
    type: string;
    config: Record<string, any>;
    timeout?: number;
    retries?: number;
    onFailure?: 'stop' | 'skip' | 'continue';
  }>;

  if (!children || children.length === 0) {
    return { status: 'success', data: { children: [] } };
  }

  const startTime = Date.now();

  const childSteps: PipelineStep[] = children.map((child) => ({
    id: child.id,
    type: child.type,
    config: child.config,
    timeout: child.timeout,
    retries: child.retries,
    onFailure: child.onFailure,
  }));

  const results = await restate.CombineablePromise.all(
    childSteps.map((childStep) =>
      ctx.serviceClient(activityRouter).execute({
        step: childStep,
        previousSteps,
        executionContext,
        pipelineInput,
        resolvedConfig,
        executionMode,
        triggerId,
        pipelineId,
        pipelineName,
        pipelineType,
      }),
    ),
  );

  const childOutputs: Record<string, StepOutput> = {};
  for (let i = 0; i < children.length; i++) {
    childOutputs[children[i].id] = results[i];
  }

  const hasFail = results.some((r) => r.status === 'fail');
  return {
    status: hasFail ? 'fail' : 'success',
    data: { children: childOutputs },
    durationMs: Date.now() - startTime,
  };
}
