/**
 * EvalRunWorkflow — Restate durable workflow for fan-out eval orchestration.
 *
 * Unlike the generic PipelineRun workflow, eval runs need custom fan-out logic:
 *   1. Load EvalSet from MongoDB (personas, scenarios, evaluators, variants)
 *   2. Fan-out persona × scenario × variant matrix → parallel RunEvalConversation calls
 *   3. Wait for all conversations, then fan-out conversation × evaluator → parallel JudgeConversation calls
 *   4. Call AggregateEvalRun once all judging completes
 *   5. Update EvalRun status to 'running' at start, handles failures
 *
 * Follows the pipeline-run.workflow.ts pattern: restate.workflow(), ctx.serviceClient()
 * for dispatching, CombineablePromise.all() for parallelism, durable state via ctx.set().
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import {
  EvalSet,
  EvalRun,
  EvalPersona,
  EvalScenario,
  EvalEvaluator,
} from '@agent-platform/database/models';
import { runEvalConversationService } from '../services/eval/run-eval-conversation.service.js';
import { judgeConversationService } from '../services/eval/judge-conversation.service.js';
import { aggregateEvalRunService } from '../services/eval/aggregate-eval-run.service.js';
import { runEvalPreflight } from '../services/eval/eval-preflight.js';
import { resolveEvalRunRetention } from '../services/eval/eval-retention.js';
import { getEvalBreakerStates } from '../services/eval/eval-circuit-breakers.js';
import { classifyEvalRunError, type EvalRunErrorCategory } from './eval-run-errors.js';
import type {
  PersonaConfig,
  ScenarioConfig,
  EvaluatorConfig,
  EvalCell,
} from '../services/eval/eval-types.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

const log = createLogger('eval-run-workflow');

const DEFAULT_MAX_CONCURRENCY = 5;

// ── Input ────────────────────────────────────────────────────────────

interface EvalRunWorkflowInput {
  tenantId: string;
  projectId: string;
  runId: string;
  evalSetId: string;
}

interface EvalRunWorkflowResult {
  status: 'completed' | 'failed';
  totalConversations: number;
  totalJudgements: number;
}

interface LoadedEvalPersona {
  _id: string;
  name: string;
  communicationStyle: string;
  domainKnowledge: string;
  behaviorTraits?: string[];
  goals?: string;
  constraints?: string;
  sessionVariables?: Record<string, unknown>;
  isAdversarial?: boolean;
  adversarialType?: string;
  _v?: number;
}

interface LoadedEvalScenario {
  _id: string;
  name: string;
  entryAgent?: string;
  initialMessage?: string;
  expectedOutcome?: string;
  maxTurns?: number;
  expectedMilestones?: string[];
  agentPath?: string[];
  _v?: number;
}

interface LoadedEvalEvaluator {
  _id: string;
  name: string;
  type: EvaluatorConfig['type'];
  category: string;
  judgeModel?: string;
  judgePrompt?: string;
  chainOfThought?: boolean;
  temperature?: number;
  scoringRubric?: EvaluatorConfig['scoringRubric'];
  biasSettings?: EvaluatorConfig['biasSettings'];
  scorerName?: string;
  scorerConfig?: Record<string, unknown>;
  trajectoryMetrics?: string[];
  _v?: number;
}

// ── Batch helper ─────────────────────────────────────────────────────

/** Split array into batches of given size. */
function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// ── Workflow Definition ──────────────────────────────────────────────

export const evalRunWorkflow = restate.workflow({
  name: 'EvalRunWorkflow',
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      input: EvalRunWorkflowInput,
    ): Promise<EvalRunWorkflowResult> => {
      const { tenantId, projectId, runId, evalSetId } = input;
      let conversationsCompleted = 0;
      let totalJudgements = 0;

      ctx.set('status', 'loading');
      ctx.set('startedAt', await ctx.run('ts-start', () => Date.now()));

      try {
        // ── 1. Load eval set + referenced entities from MongoDB ─────────
        const loaded = await ctx.run('load-eval-set', async () => {
          const evalSet = await EvalSet.findOne({ _id: evalSetId, tenantId, projectId }).lean();
          if (!evalSet) {
            throw new restate.TerminalError(`EvalSet ${evalSetId} not found`);
          }
          const run = await EvalRun.findOne({ _id: runId, tenantId, projectId })
            .select('knownSource')
            .lean();
          if (!run) {
            throw new restate.TerminalError('Run cancelled or not found');
          }

          const [personas, scenarios, evaluators] = (await Promise.all([
            EvalPersona.find({ _id: { $in: evalSet.personaIds }, tenantId, projectId }).lean(),
            EvalScenario.find({ _id: { $in: evalSet.scenarioIds }, tenantId, projectId }).lean(),
            EvalEvaluator.find({ _id: { $in: evalSet.evaluatorIds }, tenantId, projectId }).lean(),
          ])) as [LoadedEvalPersona[], LoadedEvalScenario[], LoadedEvalEvaluator[]];

          if (personas.length !== evalSet.personaIds.length)
            throw new restate.TerminalError('One or more personas not found or access denied');
          if (scenarios.length !== evalSet.scenarioIds.length)
            throw new restate.TerminalError('One or more scenarios not found or access denied');
          if (evaluators.length !== evalSet.evaluatorIds.length)
            throw new restate.TerminalError('One or more evaluators not found or access denied');

          return {
            retention: await resolveEvalRunRetention(tenantId, run.knownSource),
            variants: evalSet.variants ?? 1,
            maxConcurrency: evalSet.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
            baselineRunId: evalSet.baselineRunId,
            regressionThreshold: evalSet.regressionThreshold,
            personaModel: evalSet.personaModel,
            personaModelConfig: evalSet.personaModelConfig,
            personas: personas.map(
              (p): PersonaConfig => ({
                _id: String(p._id),
                name: p.name,
                communicationStyle: p.communicationStyle,
                domainKnowledge: p.domainKnowledge,
                behaviorTraits: p.behaviorTraits ?? [],
                goals: p.goals ?? '',
                constraints: p.constraints ?? '',
                sessionVariables: p.sessionVariables,
                isAdversarial: p.isAdversarial ?? false,
                adversarialType: p.adversarialType,
                version: p._v ?? 1,
              }),
            ),
            scenarios: scenarios.map(
              (s): ScenarioConfig => ({
                _id: String(s._id),
                name: s.name,
                entryAgent: s.entryAgent,
                initialMessage: s.initialMessage,
                expectedOutcome: s.expectedOutcome,
                maxTurns: s.maxTurns ?? 10,
                expectedMilestones: s.expectedMilestones ?? [],
                agentPath: s.agentPath ?? [],
                version: s._v ?? 1,
              }),
            ),
            evaluators: evaluators.map(
              (e): EvaluatorConfig => ({
                _id: String(e._id),
                name: e.name,
                type: e.type,
                category: e.category,
                judgeModel: e.judgeModel,
                judgePrompt: e.judgePrompt,
                chainOfThought: e.chainOfThought ?? true,
                temperature: e.temperature ?? 0,
                scoringRubric: e.scoringRubric,
                biasSettings: e.biasSettings ?? {
                  positionSwapEnabled: false,
                  blindEvaluation: false,
                  crossModelJudge: false,
                  evidenceFirstMode: false,
                },
                scorerName: e.scorerName,
                scorerConfig: e.scorerConfig,
                trajectoryMetrics: e.trajectoryMetrics,
                version: e._v ?? 1,
              }),
            ),
          };
        });

        const {
          personas,
          scenarios,
          evaluators,
          variants,
          maxConcurrency,
          baselineRunId,
          regressionThreshold,
          personaModel,
          personaModelConfig,
          retention,
        } = loaded;

        // ── 1b. Preflight validation ──────────────────────────────────
        const judgeModels = evaluators.flatMap((e) =>
          e.type === 'llm_judge' && e.judgeModel ? [e.judgeModel] : [],
        );
        const preflightResult = await ctx.run('preflight', async () => {
          try {
            return await runEvalPreflight(tenantId, projectId, { evaluatorModels: judgeModels });
          } catch (err) {
            // restate.TerminalError carries only `message`; log the original
            // error with stack so the underlying I/O failure is recoverable
            // from service logs even after the workflow terminates.
            log.error('Preflight failed inside eval workflow; wrapping in TerminalError', {
              tenantId,
              projectId,
              runId,
              err: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
            throw new restate.TerminalError(err instanceof Error ? err.message : String(err));
          }
        });
        if (preflightResult.overall === 'fail') {
          const failedChecks = preflightResult.checks
            .filter((c) => c.status === 'fail')
            .map((c) => `${c.name}: ${c.message}`)
            .join('; ');
          await ctx.run('mark-preflight-failed', async () => {
            await EvalRun.findOneAndUpdate(
              { _id: runId, tenantId, projectId },
              {
                $set: {
                  status: 'failed',
                  completedAt: new Date(),
                  preflightResult,
                },
              },
            );
          });
          throw new restate.TerminalError(`Eval preflight failed: ${failedChecks}`);
        }

        // ── 2. Mark run as 'running' ────────────────────────────────────
        await ctx.run('mark-running', async () => {
          const updated = await EvalRun.findOneAndUpdate(
            { _id: runId, tenantId, projectId, status: { $ne: 'cancelled' } },
            { $set: { status: 'running' }, $min: { startedAt: new Date() } },
            { new: true },
          );
          if (!updated) throw new restate.TerminalError('Run cancelled or not found');
          return true;
        });

        ctx.set('status', 'running');

        // ── 3. Build matrix: persona × scenario × variant ──────────────
        const cells: EvalCell[] = [];
        for (const persona of personas) {
          for (const scenario of scenarios) {
            for (let v = 0; v < variants; v++) {
              cells.push({ personaId: persona._id, scenarioId: scenario._id, variantIndex: v });
            }
          }
        }

        ctx.set('totalCells', cells.length);
        log.info('Eval run matrix built', {
          runId,
          personas: personas.length,
          scenarios: scenarios.length,
          variants,
          totalCells: cells.length,
        });

        // ── 4. Fan-out conversations in batches (maxConcurrency) ───────
        const conversationResults: Array<{ cell: EvalCell; output: StepOutput }> = [];
        const cellBatches = batch(cells, maxConcurrency);

        for (let batchIdx = 0; batchIdx < cellBatches.length; batchIdx++) {
          const currentBatch = cellBatches[batchIdx];

          const results = await restate.CombineablePromise.all(
            currentBatch.map((cell) => {
              const persona = personas.find((p) => p._id === cell.personaId)!;
              const scenario = scenarios.find((s) => s._id === cell.scenarioId)!;

              const stepCtx: PipelineStepContext = {
                tenantId,
                projectId,
                config: {
                  persona,
                  scenario,
                  variantIndex: cell.variantIndex,
                  tenantId,
                  projectId,
                  runId,
                  knownSource: retention.knownSource,
                  evalConversationTtlDays: retention.evalConversationTtlDays,
                  personaModel,
                  personaTemperature: personaModelConfig?.temperature,
                  personaMaxTokens: personaModelConfig?.maxTokens,
                },
                previousSteps: {},
                pipelineInput: { tenantId, projectId, runId, evalSetId },
              };

              return ctx.serviceClient(runEvalConversationService).execute(stepCtx);
            }),
          );

          for (let i = 0; i < currentBatch.length; i++) {
            conversationResults.push({ cell: currentBatch[i], output: results[i] });
          }

          conversationsCompleted = conversationResults.length;
          ctx.set('conversationsCompleted', conversationsCompleted);
        }

        // ── 4b. Build diagnostic summary from conversation results ────
        const failedConvResults = conversationResults.filter(
          (cr) => cr.output.status !== 'success',
        );
        if (failedConvResults.length > 0) {
          const diagnosticSummary = await ctx.run('build-diagnostics', () => {
            // Group errors by pattern
            const errorCounts = new Map<string, { count: number; sample: string }>();
            for (const cr of failedConvResults) {
              const errMsg =
                cr.output.data?.errorMessage ?? cr.output.data?.error ?? 'Unknown error';
              const pattern = String(errMsg)
                .replace(/[0-9a-f]{24}/gi, '<id>')
                .substring(0, 200);
              const existing = errorCounts.get(pattern);
              if (existing) {
                existing.count++;
              } else {
                errorCounts.set(pattern, { count: 1, sample: String(errMsg) });
              }
            }

            return {
              failedConversations: failedConvResults.length,
              totalConversations: conversationResults.length,
              errorCategories: Array.from(errorCounts.entries()).map(([pattern, info]) => ({
                pattern,
                count: info.count,
                sample: info.sample,
              })),
              circuitBreakerStates: getEvalBreakerStates(),
            };
          });

          ctx.set('diagnosticSummary', diagnosticSummary);

          // Persist to EvalRun document for Studio visibility
          await ctx.run('write-diagnostics', async () => {
            await EvalRun.findOneAndUpdate(
              { _id: runId, tenantId, projectId },
              { $set: { diagnosticSummary } },
            );
          });

          log.warn('Eval run has failed conversations', {
            runId,
            failedConversations: diagnosticSummary.failedConversations,
            totalConversations: diagnosticSummary.totalConversations,
            errorCategories: diagnosticSummary.errorCategories.length,
          });
        }

        // ── 5. Fan-out judging in batches ──────────────────────────────
        interface JudgeTask {
          cell: EvalCell;
          evaluator: EvaluatorConfig;
          conversationOutput: StepOutput;
        }

        const judgeTasks: JudgeTask[] = [];
        for (const cr of conversationResults) {
          if (cr.output.status !== 'success') continue;
          for (const evaluator of evaluators) {
            judgeTasks.push({ cell: cr.cell, evaluator, conversationOutput: cr.output });
          }
        }

        totalJudgements = judgeTasks.length;
        ctx.set('totalJudgements', totalJudgements);

        const judgeBatches = batch(judgeTasks, maxConcurrency);
        let judgementsCompleted = 0;

        for (const currentBatch of judgeBatches) {
          await restate.CombineablePromise.all(
            currentBatch.map((task) => {
              const persona = personas.find((p) => p._id === task.cell.personaId)!;
              const scenario = scenarios.find((s) => s._id === task.cell.scenarioId)!;
              const convData = task.conversationOutput.data ?? {};

              const stepCtx: PipelineStepContext = {
                tenantId,
                projectId,
                config: {
                  conversation: convData.conversation ?? [],
                  traceEvents: convData.traceEvents ?? [],
                  evaluator: task.evaluator,
                  persona,
                  scenario,
                  variantIndex: task.cell.variantIndex,
                  runId,
                  knownSource: retention.knownSource,
                  evalScoreTtlDays: retention.evalScoreTtlDays,
                  tenantId,
                  projectId,
                  milestonesHit: convData.milestonesHit ?? [],
                  actualAgentPath: convData.actualAgentPath ?? [],
                  toolCallCount: convData.toolCallCount ?? 0,
                  turnCount: convData.turnCount ?? 0,
                },
                previousSteps: {},
                pipelineInput: { tenantId, projectId, runId, evalSetId },
              };

              return ctx.serviceClient(judgeConversationService).execute(stepCtx);
            }),
          );

          judgementsCompleted += currentBatch.length;
          ctx.set('judgementsCompleted', judgementsCompleted);
        }

        // ── 6. Aggregate ───────────────────────────────────────────────
        ctx.set('status', 'aggregating');

        const aggregateCtx: PipelineStepContext = {
          tenantId,
          projectId,
          config: {
            runId,
            tenantId,
            projectId,
            evalSetId,
            baselineRunId,
            regressionThreshold,
            variants,
          },
          previousSteps: {},
          pipelineInput: { tenantId, projectId, runId, evalSetId },
        };

        const aggregateResult = await ctx
          .serviceClient(aggregateEvalRunService)
          .execute(aggregateCtx);

        // ── 7. Finalize ────────────────────────────────────────────────
        const finalStatus = aggregateResult.status === 'success' ? 'completed' : 'failed';
        ctx.set('status', finalStatus);
        ctx.set('completedAt', await ctx.run('ts-end', () => Date.now()));

        // Update run status if aggregation failed (aggregation service handles success case)
        if (finalStatus === 'failed') {
          await ctx.run('mark-failed', async () => {
            await EvalRun.findOneAndUpdate(
              { _id: runId, tenantId, projectId, status: { $nin: ['cancelled', 'completed'] } },
              { $set: { status: 'failed', completedAt: new Date() } },
            );
          });
        }

        return {
          status: finalStatus,
          totalConversations: conversationResults.length,
          totalJudgements,
        };
      } catch (error) {
        const classified = classifyEvalRunError(error);
        const isTerminal = error instanceof restate.TerminalError || classified.terminal;
        const errorCategory: EvalRunErrorCategory = isTerminal
          ? classified.category === 'unknown'
            ? 'terminal_error'
            : classified.category
          : classified.category;

        if (!isTerminal) {
          throw error;
        }

        log.warn('Eval run failed with terminal error', {
          runId,
          evalSetId,
          category: errorCategory,
          error: classified.message,
        });

        ctx.set('status', 'failed');
        ctx.set('completedAt', await ctx.run('ts-terminal-end', () => Date.now()));

        await ctx.run('mark-terminal-failed', async () => {
          await EvalRun.findOneAndUpdate(
            { _id: runId, tenantId, projectId, status: { $nin: ['cancelled', 'completed'] } },
            { $set: { status: 'failed', completedAt: new Date() } },
          );
        });

        return {
          status: 'failed',
          totalConversations: conversationsCompleted,
          totalJudgements,
        };
      }
    },

    getStatus: restate.handlers.workflow.shared(async (ctx: restate.WorkflowSharedContext) => ({
      status: (await ctx.get<string>('status')) ?? 'unknown',
      startedAt: await ctx.get<number>('startedAt'),
      completedAt: await ctx.get<number>('completedAt'),
      totalCells: await ctx.get<number>('totalCells'),
      conversationsCompleted: await ctx.get<number>('conversationsCompleted'),
      totalJudgements: await ctx.get<number>('totalJudgements'),
      diagnosticSummary: await ctx.get('diagnosticSummary'),
      judgementsCompleted: await ctx.get<number>('judgementsCompleted'),
    })),
  },
});

export type EvalRunWorkflowType = typeof evalRunWorkflow;
