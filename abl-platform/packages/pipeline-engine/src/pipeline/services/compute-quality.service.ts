/**
 * ComputeQuality — Restate activity service for LLM-as-judge quality evaluation.
 *
 * Evaluates conversation quality across configurable dimensions (helpfulness,
 * accuracy, professionalism, etc.) using an LLM judge. Supports customer-defined
 * rubrics with weighted scoring.
 *
 * Writes results to:
 *   - abl_platform.quality_evaluations (one row per session)
 *   - abl_platform.conversation_outcomes (one row per session)
 *
 * Reads from: execution context 'conversation' key or previousSteps fallback
 *
 * Spec reference: Phase 2 config schema + Phase 3-5 output/presentation/index design
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import { buildJudgePrompt, OUTCOME_PROMPT_SECTION } from '../prompts/index.js';
import type { EvaluationDimension } from '../prompts/index.js';

const log = createLogger('compute-quality');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUALITY_TABLE = 'abl_platform.quality_evaluations';

/** Default config version — overridden by resolved pipeline config version. */
const DEFAULT_CONFIG_VERSION = 1;

/** Default flag threshold — scores below trigger a warning. */
const DEFAULT_FLAG_THRESHOLD = 2.5;

const OUTCOMES_TABLE = 'abl_platform.conversation_outcomes';

const VALID_LLM_OUTCOMES = new Set([
  'contained_resolved',
  'contained_partial',
  'contained_unresolved',
]);

const ABANDONED_END_REASONS = new Set(['timeout', 'user_exit', 'user_left']);

// ---------------------------------------------------------------------------
// Default dimensions (used when no custom rubric is provided)
// ---------------------------------------------------------------------------

const DEFAULT_DIMENSIONS: EvaluationDimension[] = [
  {
    name: 'helpfulness',
    displayName: 'Helpfulness',
    description: 'How helpful and complete was the agent response in addressing the user need?',
    scale: { min: 1, max: 5 },
    weight: 1.0,
  },
  {
    name: 'accuracy',
    displayName: 'Accuracy',
    description: 'Were the facts, instructions, and information provided correct and reliable?',
    scale: { min: 1, max: 5 },
    weight: 1.0,
  },
  {
    name: 'professionalism',
    displayName: 'Professionalism',
    description: 'Was the tone professional, polite, and appropriate for the context?',
    scale: { min: 1, max: 5 },
    weight: 0.8,
  },
  {
    name: 'instruction_following',
    displayName: 'Instruction Following',
    description: 'Did the agent follow its guidelines, constraints, and intended workflow?',
    scale: { min: 1, max: 5 },
    weight: 0.8,
  },
];

function parseFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeDimensionScale(value: unknown): { min: number; max: number } {
  if (typeof value === 'number' || typeof value === 'string') {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    const rangeMatch =
      typeof value === 'string'
        ? trimmed.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/)
        : null;
    if (rangeMatch) {
      return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
    }

    const max = parseFiniteNumber(value, 5);
    return { min: 1, max };
  }

  const scale = value as { min?: unknown; max?: unknown } | undefined;
  return {
    min: parseFiniteNumber(scale?.min, 1),
    max: parseFiniteNumber(scale?.max, 5),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QualityLLMResponse {
  dimensions: Array<{
    name: string;
    score: number;
    rationale: string;
  }>;
  overall_reasoning: string;
  confidence: number;
  flag_reasons: string[];
}

interface OutcomeLLMResponse {
  outcome: string;
  goal_detected: string;
  goal_achieved: boolean;
  outcome_reasoning: string;
}

interface ConversationOutcomeRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  outcome: string;
  outcome_method: string;
  confidence: number;
  goal_detected: string | null;
  goal_achieved: number | null;
  outcome_reasoning: string | null;
  agent_name: string;
  channel: string;
  message_count: number;
  handoff_count: number;
  escalation_reason: string | null;
  duration_ms: number;
  model_id: string;
  config_version: number;
  processing_ms: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
}

interface QualityEvaluationRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  agent_name: string;
  agent_version: string;
  channel: string;
  overall_score: number;
  helpfulness: number;
  accuracy: number;
  professionalism: number;
  instruction_following: number;
  custom_dimensions: string;
  flagged: number;
  flag_reasons: string[];
  reasoning: string;
  model_id: string;
  config_version: number;
  pipeline_version: string;
  confidence: number;
  processing_ms: number;
  input_tokens: number;
  output_tokens: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ClickHouse DateTime64(3) format — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Compute overall score from per-dimension scores using weighted average.
 * Normalizes all scores to 0-5 scale before averaging.
 */
function computeOverallScore(
  dimensions: EvaluationDimension[],
  scores: Map<string, number>,
): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const dim of dimensions) {
    const rawScore = scores.get(dim.name);
    if (rawScore === undefined) continue;

    // Normalize to 0-5 scale
    const range = dim.scale.max - dim.scale.min;
    const normalized = range > 0 ? ((rawScore - dim.scale.min) / range) * 5 : rawScore;

    weightedSum += normalized * dim.weight;
    totalWeight += dim.weight;
  }

  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 1000) / 1000;
}

function classifyOutcomeHeuristic(
  escalations: Array<{ reason?: string }>,
  endReason?: string,
): { outcome: string; escalationReason: string | null } | null {
  if (escalations.length > 0) {
    return {
      outcome: 'escalated',
      escalationReason: escalations[0]?.reason ?? null,
    };
  }
  if (endReason && ABANDONED_END_REASONS.has(endReason)) {
    return { outcome: 'abandoned', escalationReason: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeQualityService = restate.service({
  name: 'ComputeQuality',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // Read conversation data from a prior step or execution context
      const conversationData = resolveContextInput(input, 'conversation');
      if (!conversationData) {
        return {
          status: 'fail',
          data: {
            error:
              'ComputeQuality requires conversation data (from read-conversation or execution context)',
          },
          durationMs: Date.now() - startTime,
        };
      }

      const messages = conversationData.messages as
        | Array<{
            messageId: string;
            role: string;
            content: string;
            timestamp: string;
            channel?: string;
          }>
        | undefined;
      const metadata = conversationData.metadata as
        | { agentName?: string; channel?: string; messageCount: number; durationMs?: number }
        | undefined;
      const escalations =
        (conversationData.escalations as Array<{
          reason?: string;
          severity?: string;
          timestamp?: string;
        }>) ?? [];
      const endReason = input.pipelineInput.endReason as string | undefined;

      if (!messages || messages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No messages found in conversation data' },
          durationMs: Date.now() - startTime,
        };
      }

      // Need at least one user and one assistant message for quality evaluation
      const hasUserMsg = messages.some((m) => m.role === 'user');
      const hasAssistantMsg = messages.some((m) => m.role === 'assistant');
      if (!hasUserMsg || !hasAssistantMsg) {
        return {
          status: 'skipped',
          data: { reason: 'Quality evaluation requires both user and assistant messages' },
          durationMs: Date.now() - startTime,
        };
      }

      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);
      const configVersion =
        (input.config.configVersion as number | undefined) ?? DEFAULT_CONFIG_VERSION;

      // Extract config values — normalize pipeline config format to EvaluationDimension
      // Config format:    { name, description, scale: 5, weight: 0.25 }
      // Internal format:  { name, displayName, description, scale: { min: 1, max: 5 }, weight }
      const rawDimensions = input.config.dimensions as Record<string, unknown>[] | undefined;
      const dimensions: EvaluationDimension[] = rawDimensions
        ? rawDimensions.map((d) => ({
            name: (d.name as string) ?? '',
            displayName: (d.displayName as string) ?? (d.name as string) ?? '',
            description: (d.description as string) ?? '',
            scale: normalizeDimensionScale(d.scale),
            weight: parseFiniteNumber(d.weight, 1.0),
            criteria: d.criteria as string[] | undefined,
          }))
        : DEFAULT_DIMENSIONS;
      const domainContext = input.config.domainContext as string | undefined;
      const flagThreshold = (input.config.flagThreshold as number) ?? DEFAULT_FLAG_THRESHOLD;

      try {
        log.debug('Computing quality evaluation', {
          tenantId: input.tenantId,
          sessionId,
          dimensionCount: dimensions.length,
          messageCount: messages.length,
        });

        // Classify outcome via heuristic (escalated / abandoned)
        const heuristicOutcome = classifyOutcomeHeuristic(escalations, endReason);

        // Build conversation transcript for the judge
        const transcript = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n\n');

        const systemPrompt =
          buildJudgePrompt(dimensions, domainContext) +
          (heuristicOutcome ? '' : OUTCOME_PROMPT_SECTION);
        const userPrompt = `Evaluate this conversation:\n\n${transcript}`;

        // Call LLM
        const llmResult = await ctx.run('compute-quality-llm', async () => {
          let resolved;
          try {
            resolved = await resolvePipelineLLM(
              input.tenantId,
              input.projectId,
              input.config.model as string | undefined,
            );
          } catch (err) {
            throw new restate.TerminalError(
              `LLM resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return pipelineGenerateText(
            resolved,
            {
              system: systemPrompt,
              messages: [{ role: 'user' as const, content: userPrompt }],
              maxOutputTokens: 1024,
              temperature: 0.1,
            },
            {
              service: 'compute-quality',
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId,
            },
          );
        });

        // Parse LLM response — strip markdown fences if present
        let parsed: QualityLLMResponse;
        try {
          let raw = llmResult.content.trim();
          // Strip ```json ... ``` or ``` ... ``` wrapping
          const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
          if (fenceMatch) {
            raw = fenceMatch[1].trim();
          }
          parsed = JSON.parse(raw) as QualityLLMResponse;
        } catch {
          return {
            status: 'fail',
            data: { error: 'Failed to parse quality LLM response as JSON', raw: llmResult.content },
            durationMs: Date.now() - startTime,
          };
        }

        // Map dimension scores
        const scoreMap = new Map<string, number>();
        for (const dimResult of parsed.dimensions) {
          scoreMap.set(dimResult.name, dimResult.score);
        }

        // Compute overall score
        const overallScore = computeOverallScore(dimensions, scoreMap);

        // Check flagging
        const isFlagged = overallScore < flagThreshold;

        // Build custom dimensions JSON for non-standard dimensions
        const standardDims = new Set([
          'helpfulness',
          'accuracy',
          'professionalism',
          'instruction_following',
        ]);
        const customDimsMap: Record<string, number> = {};
        for (const [name, score] of scoreMap.entries()) {
          if (!standardDims.has(name)) {
            customDimsMap[name] = score;
          }
        }

        // Determine outcome classification
        let outcomeValue: string;
        let outcomeMethod: string;
        let outcomeData: OutcomeLLMResponse | null = null;

        if (heuristicOutcome) {
          outcomeValue = heuristicOutcome.outcome;
          outcomeMethod = 'heuristic';
        } else {
          const rawOutcome = (parsed as any).outcome as OutcomeLLMResponse | undefined;
          if (rawOutcome && VALID_LLM_OUTCOMES.has(rawOutcome.outcome)) {
            outcomeValue = rawOutcome.outcome;
            outcomeMethod = 'llm_evaluated';
            outcomeData = rawOutcome;
          } else {
            outcomeValue = 'contained';
            outcomeMethod = 'heuristic_fallback';
            log.warn('Invalid LLM outcome, falling back to heuristic', {
              sessionId,
              rawOutcome: rawOutcome?.outcome,
            });
          }
        }

        // Build ClickHouse row
        const now = new Date();
        const processedAt = toCHDateTime(now);
        const processingMs = Date.now() - startTime;

        const sessionStartedAt = messages[0]?.timestamp
          ? toCHDateTime(new Date(messages[0].timestamp))
          : processedAt;

        const row: QualityEvaluationRow = {
          tenant_id: input.tenantId,
          project_id: input.projectId ?? '',
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          processed_at: processedAt,
          agent_name: metadata?.agentName ?? '',
          agent_version: '',
          channel: metadata?.channel ?? '',
          overall_score: overallScore,
          helpfulness: scoreMap.get('helpfulness') ?? 0,
          accuracy: scoreMap.get('accuracy') ?? 0,
          professionalism: scoreMap.get('professionalism') ?? 0,
          instruction_following: scoreMap.get('instruction_following') ?? 0,
          custom_dimensions:
            Object.keys(customDimsMap).length > 0 ? JSON.stringify(customDimsMap) : '',
          flagged: isFlagged ? 1 : 0,
          flag_reasons: parsed.flag_reasons ?? [],
          reasoning: parsed.overall_reasoning ?? '',
          model_id: llmResult.model,
          config_version: configVersion,
          pipeline_version: '1.0.0',
          confidence: Math.round((parsed.confidence ?? 0.8) * 1000) / 1000,
          processing_ms: processingMs,
          input_tokens: llmResult.inputTokens ?? 0,
          output_tokens: llmResult.outputTokens ?? 0,
          run_id: (input.pipelineInput?.runId as string) ?? '',
          pipeline_id: input.pipelineId ?? '',
          pipeline_type: input.pipelineType ?? '',
        };

        // Write quality evaluation to ClickHouse
        await ctx.run('store-quality-results', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: QUALITY_TABLE,
            values: [row],
            format: 'JSONEachRow',
          });
        });

        // Write outcome classification to ClickHouse
        const outcomeRow: ConversationOutcomeRow = {
          tenant_id: input.tenantId,
          project_id: input.projectId ?? '',
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          processed_at: processedAt,
          outcome: outcomeValue,
          outcome_method: outcomeMethod,
          confidence: outcomeData ? Math.round((parsed.confidence ?? 0.8) * 1000) / 1000 : 1.0,
          goal_detected: outcomeData?.goal_detected ?? null,
          goal_achieved: outcomeData ? (outcomeData.goal_achieved ? 1 : 0) : null,
          outcome_reasoning: outcomeData?.outcome_reasoning ?? null,
          agent_name: metadata?.agentName ?? '',
          channel: metadata?.channel ?? '',
          message_count: messages.length,
          handoff_count: escalations.length,
          escalation_reason: heuristicOutcome?.escalationReason ?? null,
          duration_ms: metadata?.durationMs ?? 0,
          model_id: outcomeMethod === 'llm_evaluated' ? llmResult.model : '',
          config_version: configVersion,
          processing_ms: Date.now() - startTime,
          run_id: (input.pipelineInput?.runId as string) ?? '',
          pipeline_id: input.pipelineId ?? '',
          pipeline_type: input.pipelineType ?? '',
        };

        await ctx.run('store-outcome-results', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: OUTCOMES_TABLE,
            values: [outcomeRow],
            format: 'JSONEachRow',
          });
        });

        log.debug('Quality evaluation complete', {
          tenantId: input.tenantId,
          sessionId,
          overallScore,
          flagged: isFlagged,
          dimensionCount: parsed.dimensions.length,
          outcome: outcomeValue,
          outcomeMethod,
        });

        return {
          status: 'success',
          data: {
            overallScore,
            dimensions: Object.fromEntries(scoreMap),
            flagged: isFlagged,
            flagReasons: parsed.flag_reasons,
            confidence: parsed.confidence,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            outcome: outcomeValue,
            outcomeMethod,
            goalDetected: outcomeData?.goal_detected ?? null,
            goalAchieved: outcomeData?.goal_achieved ?? null,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ComputeQuality failed', {
          tenantId: input.tenantId,
          sessionId,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type ComputeQualityService = typeof computeQualityService;
