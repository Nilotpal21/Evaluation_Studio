/**
 * JudgeConversation — Restate activity for scoring eval conversations.
 *
 * Handles 4 evaluator types:
 * - llm_judge: LLM-based scoring with structured rubric + R1 bias mitigation
 * - code_scorer: Deterministic code-based scoring (built-in scorers)
 * - trajectory: R5 trajectory scoring (milestone, handoff, path, tool)
 * - human_review: Queue for human review (R9)
 *
 * R1 Bias Mitigation:
 * - Position swap: Run judge twice with conversation order swapped, average scores
 * - Blind evaluation: Strip model/agent attribution from transcript
 * - Evidence-first (RULERS): Extract evidence before scoring
 * - Cross-model judge: Use different model family (configurable)
 *
 * Config:
 *   conversation:     ConversationTurn[]
 *   traceEvents:      TraceEvent[]
 *   evaluator:        EvaluatorConfig
 *   persona:          PersonaConfig
 *   scenario:         ScenarioConfig
 *   variantIndex:     number
 *   runId:            string
 *   tenantId:         string
 *   projectId:        string
 *   milestonesHit:    string[]
 *   actualAgentPath:  string[]
 *   toolCallCount:    number
 *   turnCount:        number
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger, parseJSON } from '@abl/compiler/platform';
import { CH_EVAL_DATA_TTL_DAYS } from '@agent-platform/database/constants/eval-limits';
import { EvalHumanReview } from '@agent-platform/database/models';
import type { EvalKnownSource } from '@agent-platform/database';
import { resolvePipelineLLM } from '../llm-client-factory.js';
import { pipelineGenerateText } from '../pipeline-llm-call.js';
import { withCircuitBreaker } from './eval-circuit-breakers.js';
import { checkLLMRateLimit } from './eval-rate-limiter.js';
import { evalMetrics } from './eval-metrics.js';
import { compressString } from './eval-compression.js';
import { getScoreWriter } from './eval-clickhouse-writers.js';
import { computeTrajectoryScores } from './trajectory-scorers.js';
import type { PipelineStepContext, StepOutput } from '../../types.js';
import type {
  ConversationTurn,
  TraceEvent,
  EvaluatorConfig,
  PersonaConfig,
  ScenarioConfig,
  BiasSettings,
  ScoringRubric,
  JudgeResult,
  EvalScoreRow,
  TrajectoryScoreResult,
} from './eval-types.js';
import { toCHDateTime } from './eval-types.js';
import { buildStandardJudgePrompt, buildEvidenceFirstPrompt } from '../../prompts/index.js';

const log = createLogger('eval-judge');

// ── Transcript Formatting ───────────────────────────────────────────

function formatTranscript(conversation: ConversationTurn[]): string {
  return conversation
    .map((t, i) => {
      const role = t.role === 'user' ? 'Customer' : 'Agent';
      return `[Turn ${Math.floor(i / 2) + 1}] ${role}: ${t.content}`;
    })
    .join('\n\n');
}

/**
 * R1: Blind evaluation — strip model/agent attribution.
 */
function stripAttribution(conversation: ConversationTurn[]): string {
  return conversation
    .map((t, i) => {
      const role = t.role === 'user' ? 'Speaker A' : 'Speaker B';
      return `[Turn ${Math.floor(i / 2) + 1}] ${role}: ${t.content}`;
    })
    .join('\n\n');
}

/**
 * Swap conversation order (reverse user/agent roles) for position bias detection.
 * Handles both blind mode (Speaker A/B) and non-blind mode (Customer/Agent) labels.
 */
function swapTranscript(transcript: string): string {
  return transcript
    .replace(/Speaker A:/g, '__TEMP_A__:')
    .replace(/Speaker B:/g, 'Speaker A:')
    .replace(/__TEMP_A__:/g, 'Speaker B:')
    .replace(/Customer:/g, '__TEMP_CUST__:')
    .replace(/Agent:/g, 'Customer:')
    .replace(/__TEMP_CUST__:/g, 'Agent:');
}

// ── LLM Judge Call ──────────────────────────────────────────────────

interface RawJudgeOutput {
  score: number;
  passed: boolean;
  reasoning: string;
  evidence: string | string[];
  confidence: number;
}

async function callJudgeLLM(
  prompt: string,
  evaluator: EvaluatorConfig,
  tenantId: string,
  projectId: string,
): Promise<{
  score: number;
  passed: boolean;
  reasoning: string;
  evidence: string;
  confidence: number;
  tokensUsed: number;
  cost: number;
  latencyMs: number;
}> {
  const startTime = Date.now();
  const resolved = await resolvePipelineLLM(tenantId, projectId, evaluator.judgeModel, {
    allowFallbackOnExplicitModel: false,
  });

  const response = await withCircuitBreaker('eval-judge-llm', async () => {
    return pipelineGenerateText(
      resolved,
      {
        system: prompt,
        messages: [
          {
            role: 'user' as const,
            content: 'Evaluate the conversation above and provide your assessment as JSON.',
          },
        ],
        maxOutputTokens: 2048,
        temperature: evaluator.temperature,
      },
      { service: 'eval-judge-conversation', tenantId },
    );
  });

  const latencyMs = Date.now() - startTime;
  const tokensUsed = response.inputTokens + response.outputTokens;

  // Parse JSON response (parseJSON strips markdown code fences)
  const parsedResult = parseJSON<RawJudgeOutput>(response.content);
  let parsed: RawJudgeOutput;
  if (!parsedResult) {
    log.warn('Judge response not valid JSON, extracting manually', {
      evaluatorId: evaluator._id,
      content: response.content.slice(0, 200),
    });
    parsed = {
      score: 0,
      passed: false,
      reasoning: response.content,
      evidence: '',
      confidence: 0.5,
    };
  } else {
    parsed = parsedResult;
  }

  // Normalize evidence to string
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.join('; ')
    : String(parsed.evidence ?? '');

  // Estimate cost (rough: $3/M input, $15/M output for Sonnet-class)
  const cost = (response.inputTokens * 3 + response.outputTokens * 15) / 1_000_000;

  return {
    score: Number(parsed.score) || 0,
    passed: Boolean(parsed.passed),
    reasoning: String(parsed.reasoning ?? ''),
    evidence,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
    tokensUsed,
    cost,
    latencyMs,
  };
}

// ── Evaluator Type Handlers ─────────────────────────────────────────

async function runLLMJudge(
  conversation: ConversationTurn[],
  evaluator: EvaluatorConfig,
  biasSettings: BiasSettings,
  tenantId: string,
  projectId: string,
): Promise<JudgeResult> {
  // Format transcript (R1: blind evaluation strips attribution)
  const transcript = biasSettings.blindEvaluation
    ? stripAttribution(conversation)
    : formatTranscript(conversation);

  // Build prompt (R1: evidence-first mode)
  const judgePrompt = biasSettings.evidenceFirstMode
    ? buildEvidenceFirstPrompt(evaluator, transcript)
    : buildStandardJudgePrompt(evaluator, transcript);

  // R1: Position swap — run twice with swapped order
  if (biasSettings.positionSwapEnabled) {
    const swappedPrompt = biasSettings.evidenceFirstMode
      ? buildEvidenceFirstPrompt(evaluator, swapTranscript(transcript))
      : buildStandardJudgePrompt(evaluator, swapTranscript(transcript));

    const [scoreOriginal, scoreSwapped] = await Promise.all([
      callJudgeLLM(judgePrompt, evaluator, tenantId, projectId),
      callJudgeLLM(swappedPrompt, evaluator, tenantId, projectId),
    ]);

    const avgScore = (scoreOriginal.score + scoreSwapped.score) / 2;
    const delta = Math.abs(scoreOriginal.score - scoreSwapped.score);

    if (delta > 1.0) {
      log.warn('Bias inconsistency detected', {
        tenantId,
        evaluatorId: evaluator._id,
        scoreOriginal: scoreOriginal.score,
        scoreSwapped: scoreSwapped.score,
        delta,
      });
    }

    return {
      score: avgScore,
      passed: evaluator.scoringRubric?.scaleType === 'pass-fail' ? avgScore >= 1 : avgScore >= 3,
      reasoning: scoreOriginal.reasoning,
      evidence: scoreOriginal.evidence,
      confidence: scoreOriginal.confidence,
      scoreOriginal: scoreOriginal.score,
      scoreSwapped: scoreSwapped.score,
      wasPositionSwapped: true,
      judgeTokensUsed: scoreOriginal.tokensUsed + scoreSwapped.tokensUsed,
      judgeCost: scoreOriginal.cost + scoreSwapped.cost,
      judgeLatencyMs: Math.max(scoreOriginal.latencyMs, scoreSwapped.latencyMs),
      needsHumanReview: scoreOriginal.confidence < (evaluator.humanReviewThreshold ?? 0),
    };
  }

  // Standard single-pass judging
  const result = await callJudgeLLM(judgePrompt, evaluator, tenantId, projectId);
  return {
    score: result.score,
    passed:
      evaluator.scoringRubric?.scaleType === 'pass-fail' ? result.score >= 1 : result.score >= 3,
    reasoning: result.reasoning,
    evidence: result.evidence,
    confidence: result.confidence,
    wasPositionSwapped: false,
    judgeTokensUsed: result.tokensUsed,
    judgeCost: result.cost,
    judgeLatencyMs: result.latencyMs,
    needsHumanReview: result.confidence < (evaluator.humanReviewThreshold ?? 0),
  };
}

function runCodeScorer(
  conversation: ConversationTurn[],
  traceEvents: TraceEvent[],
  evaluator: EvaluatorConfig,
): JudgeResult {
  // Built-in code scorers
  const scorerName = evaluator.scorerName ?? 'default';
  let score = 0;
  let reasoning = '';

  switch (scorerName) {
    case 'toolSuccessScorer': {
      const toolCalls = traceEvents.filter((e) => e.type === 'tool_call');
      const successCount = toolCalls.filter((e) => e.data.success !== false).length;
      score = toolCalls.length > 0 ? (successCount / toolCalls.length) * 5 : 5;
      reasoning = `${successCount}/${toolCalls.length} tool calls succeeded`;
      break;
    }
    case 'responseLengthScorer': {
      const agentResponses = conversation.filter((t) => t.role === 'agent');
      const avgLength =
        agentResponses.reduce((sum, t) => sum + t.content.length, 0) /
        Math.max(agentResponses.length, 1);
      score = avgLength > 50 && avgLength < 2000 ? 5 : avgLength <= 50 ? 2 : 3;
      reasoning = `Average response length: ${Math.round(avgLength)} chars`;
      break;
    }
    case 'errorFreeScorer': {
      const errorEvents = traceEvents.filter((e) => e.type === 'error');
      score = errorEvents.length === 0 ? 5 : Math.max(1, 5 - errorEvents.length);
      reasoning = `${errorEvents.length} errors detected`;
      break;
    }
    default: {
      score = 3;
      reasoning = `Unknown code scorer: ${scorerName}`;
    }
  }

  return {
    score,
    passed: score >= 3,
    reasoning,
    evidence: '',
    confidence: 1.0,
    wasPositionSwapped: false,
    judgeTokensUsed: 0,
    judgeCost: 0,
    judgeLatencyMs: 0,
    needsHumanReview: false,
  };
}

interface TrajectoryJudgeResult {
  judgeResult: JudgeResult;
  trajectoryScores: TrajectoryScoreResult;
}

function runTrajectoryScorer(
  evaluator: EvaluatorConfig,
  milestonesHit: string[],
  actualAgentPath: string[],
  scenario: ScenarioConfig,
  toolCallCount: number,
  turnCount: number,
): TrajectoryJudgeResult {
  const trajectoryScores = computeTrajectoryScores({
    milestonesHit,
    expectedMilestones: scenario.expectedMilestones,
    actualAgentPath,
    expectedAgentPath: scenario.agentPath,
    toolCallCount,
    maxToolCalls: scenario.maxToolCalls,
    turnCount,
  });

  // Average all applicable trajectory metrics
  const metrics = evaluator.trajectoryMetrics ?? [
    'milestone_completion',
    'handoff_correctness',
    'path_efficiency',
  ];

  const scores: number[] = [];
  const details: string[] = [];

  if (metrics.includes('milestone_completion')) {
    scores.push(trajectoryScores.milestoneCompletionRate);
    details.push(
      `Milestone completion: ${(trajectoryScores.milestoneCompletionRate * 100).toFixed(0)}%`,
    );
  }
  if (metrics.includes('handoff_correctness')) {
    scores.push(trajectoryScores.handoffCorrectnessRate);
    details.push(
      `Handoff correctness: ${(trajectoryScores.handoffCorrectnessRate * 100).toFixed(0)}%`,
    );
  }
  if (metrics.includes('path_efficiency')) {
    scores.push(trajectoryScores.pathEfficiencyScore);
    details.push(`Path efficiency: ${(trajectoryScores.pathEfficiencyScore * 100).toFixed(0)}%`);
  }
  if (metrics.includes('tool_sequence') && trajectoryScores.toolSequenceScore !== undefined) {
    scores.push(trajectoryScores.toolSequenceScore);
    details.push(`Tool sequence: ${(trajectoryScores.toolSequenceScore * 100).toFixed(0)}%`);
  }

  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  // Scale 0-1 to rubric scale (1-5)
  const scaledScore = 1 + avgScore * 4;

  return {
    judgeResult: {
      score: Math.round(scaledScore * 10) / 10,
      passed: avgScore >= 0.5,
      reasoning: details.join('. '),
      evidence: JSON.stringify({
        milestonesHit,
        expectedMilestones: scenario.expectedMilestones,
        actualAgentPath,
        expectedAgentPath: scenario.agentPath,
        toolCallCount,
        maxToolCalls: scenario.maxToolCalls,
      }),
      confidence: 1.0,
      wasPositionSwapped: false,
      judgeTokensUsed: 0,
      judgeCost: 0,
      judgeLatencyMs: 0,
      needsHumanReview: false,
    },
    trajectoryScores,
  };
}

// ── Service Definition ──────────────────────────────────────────────

export const judgeConversationService = restate.service({
  name: 'JudgeConversation',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const {
        conversation,
        traceEvents = [],
        evaluator,
        persona,
        scenario,
        variantIndex = 0,
        runId,
        tenantId: configTenantId,
        projectId: configProjectId,
        knownSource = 'eval',
        evalScoreTtlDays = CH_EVAL_DATA_TTL_DAYS,
        milestonesHit = [],
        actualAgentPath = [],
        toolCallCount = 0,
        turnCount = 0,
      } = input.config as {
        conversation: ConversationTurn[];
        traceEvents: TraceEvent[];
        evaluator: EvaluatorConfig;
        persona: PersonaConfig;
        scenario: ScenarioConfig;
        variantIndex: number;
        runId: string;
        tenantId?: string;
        projectId?: string;
        knownSource?: EvalKnownSource;
        evalScoreTtlDays?: number;
        milestonesHit: string[];
        actualAgentPath: string[];
        toolCallCount: number;
        turnCount: number;
      };

      const tenantId = configTenantId ?? input.tenantId;
      const projectId = configProjectId ?? input.projectId ?? '';
      const attrs = {
        tenant_id: tenantId,
        project_id: projectId,
        evaluator_type: evaluator.type,
      };

      if (!conversation || !evaluator) {
        return {
          status: 'fail',
          data: { error: 'JudgeConversation requires conversation and evaluator' },
          durationMs: Date.now() - startTime,
        };
      }

      evalMetrics.judgeCallsStarted.add(1, attrs);
      evalMetrics.activeJudgeCalls.add(1, attrs);

      try {
        let judgeResult: JudgeResult;
        let cachedTrajectoryScoreResult: TrajectoryScoreResult | undefined;

        switch (evaluator.type) {
          case 'llm_judge': {
            judgeResult = await ctx.run('llm-judge', async () => {
              if (!checkLLMRateLimit(tenantId)) {
                throw new Error('LLM rate limit exceeded for tenant');
              }
              return runLLMJudge(
                conversation,
                evaluator,
                evaluator.biasSettings,
                tenantId,
                projectId,
              );
            });
            break;
          }
          case 'code_scorer': {
            judgeResult = runCodeScorer(conversation, traceEvents, evaluator);
            break;
          }
          case 'trajectory': {
            const trajectoryResult = runTrajectoryScorer(
              evaluator,
              milestonesHit,
              actualAgentPath,
              scenario,
              toolCallCount,
              turnCount,
            );
            judgeResult = trajectoryResult.judgeResult;
            cachedTrajectoryScoreResult = trajectoryResult.trajectoryScores;
            break;
          }
          case 'human_review': {
            // Queue for human review — score as pending
            judgeResult = {
              score: 0,
              passed: false,
              reasoning: 'Queued for human review',
              evidence: '',
              confidence: 0,
              wasPositionSwapped: false,
              judgeTokensUsed: 0,
              judgeCost: 0,
              judgeLatencyMs: 0,
              needsHumanReview: true,
            };
            await ctx.run('create-human-review', async () => {
              const reviewId = `${runId}:${evaluator._id}:${persona._id}:${scenario._id}:v${variantIndex}`;
              await EvalHumanReview.updateOne(
                { _id: reviewId },
                {
                  $setOnInsert: {
                    _id: reviewId,
                    tenantId,
                    projectId,
                    runId,
                    evaluatorId: evaluator._id,
                    personaId: persona._id,
                    scenarioId: scenario._id,
                    variantIndex,
                    llmScore: 0,
                    llmReasoning: 'Queued for human review',
                    llmConfidence: 0,
                    status: 'pending',
                  },
                },
                { upsert: true },
              );
            });
            break;
          }
          default: {
            return {
              status: 'fail',
              data: { error: `Unknown evaluator type: ${evaluator.type}` },
              durationMs: Date.now() - startTime,
            };
          }
        }

        const durationMs = Date.now() - startTime;

        // Write score to ClickHouse via buffered writer
        const scoreRow: EvalScoreRow = {
          tenant_id: tenantId,
          project_id: projectId,
          run_id: runId,
          persona_id: persona._id,
          scenario_id: scenario._id,
          variant_index: variantIndex,
          evaluator_id: evaluator._id,
          score: judgeResult.score,
          passed: judgeResult.passed ? 1 : 0,
          reasoning: await compressString(judgeResult.reasoning),
          evidence: await compressString(judgeResult.evidence),
          confidence: judgeResult.confidence,
          score_original: judgeResult.scoreOriginal ?? judgeResult.score,
          score_swapped: judgeResult.scoreSwapped ?? judgeResult.score,
          was_position_swapped: judgeResult.wasPositionSwapped ? 1 : 0,
          milestone_completion_rate: 0,
          handoff_correctness_rate: 0,
          path_efficiency_score: 0,
          known_source: knownSource,
          ttl_override_days: evalScoreTtlDays,
          needs_human_review: judgeResult.needsHumanReview ? 1 : 0,
          human_score: null,
          human_reviewed_at: null,
          judge_tokens_used: judgeResult.judgeTokensUsed,
          judge_cost: judgeResult.judgeCost,
          judge_latency_ms: judgeResult.judgeLatencyMs,
          evaluator_version: evaluator.version,
          created_at: toCHDateTime(),
        };

        // Fill trajectory scores if this was a trajectory evaluator (reuse cached scores)
        if (evaluator.type === 'trajectory' && cachedTrajectoryScoreResult) {
          scoreRow.milestone_completion_rate = cachedTrajectoryScoreResult.milestoneCompletionRate;
          scoreRow.handoff_correctness_rate = cachedTrajectoryScoreResult.handoffCorrectnessRate;
          scoreRow.path_efficiency_score = cachedTrajectoryScoreResult.pathEfficiencyScore;
        }

        await ctx.run('write-score-ch', () => {
          getScoreWriter().insert(scoreRow);
        });

        // Record metrics
        evalMetrics.judgeCallsCompleted.add(1, attrs);
        evalMetrics.judgeDuration.record(durationMs, attrs);
        evalMetrics.scoreValue.record(judgeResult.score, attrs);
        if (judgeResult.judgeTokensUsed > 0) {
          evalMetrics.judgeTokensUsed.add(judgeResult.judgeTokensUsed, attrs);
          evalMetrics.judgeCost.record(judgeResult.judgeCost, attrs);
        }

        log.debug('Judge score produced', {
          sessionId: input.sessionId,
          runId,
          evaluatorId: evaluator._id,
          evaluatorType: evaluator.type,
          score: judgeResult.score,
          confidence: judgeResult.confidence,
          durationMs,
          tokensUsed: judgeResult.judgeTokensUsed,
        });

        return {
          status: 'success',
          data: {
            ...judgeResult,
            evaluatorId: evaluator._id,
            personaId: persona._id,
            scenarioId: scenario._id,
            variantIndex,
          },
          durationMs,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        evalMetrics.judgeCallsFailed.add(1, attrs);
        log.error('Judge call failed', {
          sessionId: input.sessionId,
          runId,
          evaluatorId: evaluator._id,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: msg, evaluatorId: evaluator._id },
          durationMs: Date.now() - startTime,
        };
      } finally {
        evalMetrics.activeJudgeCalls.add(-1, attrs);
      }
    },
  },
});

export type JudgeConversationService = typeof judgeConversationService;
