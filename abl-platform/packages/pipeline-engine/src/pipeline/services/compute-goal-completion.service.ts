/**
 * ComputeGoalCompletion — Restate activity service for evaluating goal completion
 * in customer service conversations.
 *
 * Uses an LLM to analyze whether the agent successfully completed the customer's
 * goal, evaluating each criterion on a 0-1 scale.
 *
 * Writes results to:
 *   - abl_platform.goal_completions (one row per session)
 *
 * Reads from: execution context 'conversation' key or previousSteps fallback
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';

const log = createLogger('compute-goal-completion');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOAL_COMPLETIONS_TABLE = 'abl_platform.goal_completions';

/** Default config version — overridden by resolved pipeline config version. */
const DEFAULT_CONFIG_VERSION = 1;

/** Default threshold for goal_achieved — overall_goal_completion >= this means achieved. */
const GOAL_ACHIEVED_THRESHOLD = 0.7;

const DEFAULT_SYSTEM_PROMPT = `You are a goal completion evaluator for customer service conversations.
Analyze the conversation and determine if the agent successfully completed the customer's goal.
Evaluate each criterion on a 0-1 scale.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoalCompletionLLMResponse {
  criteria: Record<string, { score: number; evidence: string }>;
  overall_goal_completion: number;
  summary: string;
}

interface GoalCompletionRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  agent_name: string;
  channel: string;
  overall_score: number;
  goal_detected: string;
  goal_achieved: number;
  summary: string;
  criteria: string;
  model_id: string;
  config_version: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
  source: string;
  processing_ms: number;
  input_tokens: number;
  output_tokens: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ClickHouse DateTime64(3) format — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeGoalCompletionService = restate.service({
  name: 'ComputeGoalCompletion',
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
              'ComputeGoalCompletion requires conversation data (from read-conversation or execution context)',
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

      if (!messages || messages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No messages found in conversation data' },
          durationMs: Date.now() - startTime,
        };
      }

      // Need at least one user and one assistant message for evaluation
      const hasUserMsg = messages.some((m) => m.role === 'user');
      const hasAssistantMsg = messages.some((m) => m.role === 'assistant');
      if (!hasUserMsg || !hasAssistantMsg) {
        return {
          status: 'skipped',
          data: { reason: 'Goal completion evaluation requires both user and assistant messages' },
          durationMs: Date.now() - startTime,
        };
      }

      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);
      const configVersion =
        (input.config.configVersion as number | undefined) ?? DEFAULT_CONFIG_VERSION;

      // Extract config values
      const customSystemPrompt = input.config.systemPrompt as string | undefined;
      const criteria = (input.config.criteria as string[] | undefined) ?? [];

      try {
        log.debug('Computing goal completion evaluation', {
          tenantId: input.tenantId,
          sessionId,
          criteriaCount: criteria.length,
          messageCount: messages.length,
        });

        // Build conversation transcript (user + assistant only)
        const transcript = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n\n');

        // Build system prompt
        const systemPrompt = customSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

        // Build user prompt with transcript and criteria
        const criteriaSection =
          criteria.length > 0
            ? `\n\nEvaluate the following criteria:\n${criteria.map((c) => `- ${c}`).join('\n')}`
            : '\n\nIdentify and evaluate the relevant goal completion criteria.';

        const userPrompt = `Evaluate this conversation for goal completion:

${transcript}
${criteriaSection}

Respond in JSON format:
{
  "criteria": { "<criterion_name>": { "score": <0-1>, "evidence": "<brief evidence>" } },
  "overall_goal_completion": <0-1>,
  "summary": "<brief summary of goal completion evaluation>"
}`;

        // Call LLM
        const llmResult = await ctx.run('compute-goal-completion-llm', async () => {
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
              service: 'compute-goal-completion',
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId,
            },
          );
        });

        // Parse LLM response — strip markdown fences if present
        let parsed: GoalCompletionLLMResponse;
        try {
          let raw = llmResult.content.trim();
          // Strip ```json ... ``` or ``` ... ``` wrapping
          const fenceMatch = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
          if (fenceMatch) {
            raw = fenceMatch[1].trim();
          }
          parsed = JSON.parse(raw) as GoalCompletionLLMResponse;
        } catch {
          return {
            status: 'fail',
            data: {
              error: 'Failed to parse goal completion LLM response as JSON',
              raw: llmResult.content,
            },
            durationMs: Date.now() - startTime,
          };
        }

        // Compute goal_achieved: 1 if overall_goal_completion >= threshold, else 0
        const overallScore = Math.round((parsed.overall_goal_completion ?? 0) * 1000) / 1000;
        const goalAchieved = overallScore >= GOAL_ACHIEVED_THRESHOLD ? 1 : 0;

        // Detect goal from summary or criteria
        const goalDetected = parsed.summary ?? '';

        // Build ClickHouse row
        const now = new Date();
        const processedAt = toCHDateTime(now);
        const processingMs = Date.now() - startTime;

        const sessionStartedAt = messages[0]?.timestamp
          ? toCHDateTime(new Date(messages[0].timestamp))
          : processedAt;

        const row: GoalCompletionRow = {
          tenant_id: input.tenantId,
          project_id: input.projectId ?? '',
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          processed_at: processedAt,
          agent_name: metadata?.agentName ?? '',
          channel: metadata?.channel ?? '',
          overall_score: overallScore,
          goal_detected: goalDetected,
          goal_achieved: goalAchieved,
          summary: parsed.summary ?? '',
          criteria: JSON.stringify(parsed.criteria ?? {}),
          model_id: llmResult.model,
          config_version: configVersion,
          run_id: (input.pipelineInput?.runId as string) ?? '',
          pipeline_id: input.pipelineId ?? '',
          pipeline_type: input.pipelineType ?? '',
          source: input.executionMode ?? 'batch',
          processing_ms: processingMs,
          input_tokens: llmResult.inputTokens ?? 0,
          output_tokens: llmResult.outputTokens ?? 0,
        };

        // Write goal completion to ClickHouse
        await ctx.run('store-goal-completion-results', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: GOAL_COMPLETIONS_TABLE,
            values: [row],
            format: 'JSONEachRow',
          });
        });

        log.debug('Goal completion evaluation complete', {
          tenantId: input.tenantId,
          sessionId,
          overallScore,
          goalAchieved: goalAchieved === 1,
          criteriaCount: Object.keys(parsed.criteria ?? {}).length,
        });

        return {
          status: 'success',
          data: {
            overallScore,
            goalDetected,
            goalAchieved: goalAchieved === 1,
            summary: parsed.summary ?? '',
            criteria: parsed.criteria ?? {},
            inputTokens: llmResult.inputTokens ?? 0,
            outputTokens: llmResult.outputTokens ?? 0,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ComputeGoalCompletion failed', {
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
export type ComputeGoalCompletionService = typeof computeGoalCompletionService;
