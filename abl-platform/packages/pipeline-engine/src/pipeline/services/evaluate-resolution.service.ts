/**
 * EvaluateResolution — Restate activity service for primary-intent resolution evaluation.
 *
 * Takes the classification row from the preceding compute-intent step (which runs
 * with skipDirectWrite: true in the batch strategy), evaluates whether the
 * primary intent was resolved by session end via a single LLM call, and writes
 * one unified row to abl_platform.intent_classifications carrying both the
 * classification fields and the new resolution columns.
 *
 * Only runs in the batch strategy — resolution requires the full conversation.
 *
 * Failure mode: if the LLM call or parse fails, the row is still written with
 * empty resolution fields so the classification data is never lost.
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger, parseJSON } from '@abl/compiler/platform';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import { RESOLUTION_SYSTEM_PROMPT, buildResolutionUserPrompt } from '../prompts/index.js';

const log = createLogger('evaluate-resolution');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTENT_TABLE = 'abl_platform.intent_classifications';
const VALID_STATUSES = new Set<string>(['resolved', 'partial', 'unresolved']);
const MAX_REASON_LEN = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolutionLLMResponse {
  resolution_status: string;
  resolution_confidence: number;
  resolution_reason: string;
}

/** Mirrors compute-intent's IntentClassificationRow plus the 3 new resolution columns. */
interface IntentClassificationRowWithResolution {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  agent_name: string;
  channel: string;
  intent: string;
  intent_display: string;
  sub_intent: string;
  confidence: number;
  secondary_intents: string[];
  is_auto_discovered: number;
  model_id: string;
  config_version: number;
  taxonomy_version: string;
  processing_ms: number;
  input_tokens: number;
  output_tokens: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
  resolution_status: string;
  resolution_reason: string;
  resolution_confidence: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const evaluateResolutionService = restate.service({
  name: 'EvaluateResolution',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // Require conversation data (full transcript)
      const conversationData = resolveContextInput(input, 'conversation');
      if (!conversationData) {
        return {
          status: 'skipped',
          data: { reason: 'No conversation data available for resolution evaluation' },
          durationMs: Date.now() - startTime,
        };
      }

      // Require a successful prior compute-intent step that exported the full row
      const intentStep = input.previousSteps?.['compute-intent'];
      const classificationRow = intentStep?.data?.classificationRow as
        | IntentClassificationRowWithResolution
        | undefined;
      if (
        !intentStep ||
        intentStep.status !== 'success' ||
        !intentStep.data?.intent ||
        !classificationRow
      ) {
        return {
          status: 'skipped',
          data: {
            reason:
              'No classificationRow on compute-intent output — set skipDirectWrite: true on compute-intent for batch resolution',
          },
          durationMs: Date.now() - startTime,
        };
      }

      const messages = conversationData.messages as
        | Array<{ role: string; content: string; timestamp?: string }>
        | undefined;

      if (!messages || messages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No messages found for resolution evaluation' },
          durationMs: Date.now() - startTime,
        };
      }

      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);
      const primaryIntent = intentStep.data.intent as string;
      const intentDisplay = (intentStep.data.intentDisplay as string) ?? primaryIntent;

      // Try the LLM evaluation. If it fails for any reason, we still write the row
      // with empty resolution fields so the classification data is preserved.
      let resolutionStatus = '';
      let resolutionReason = '';
      let resolutionConfidence = 0;
      let resolutionInputTokens = 0;
      let resolutionOutputTokens = 0;
      let resolutionModelId = '';
      let evalError: string | null = null;

      try {
        const userPrompt = buildResolutionUserPrompt(messages, primaryIntent, intentDisplay);

        const llmResult = await ctx.run('evaluate-resolution-llm', async () => {
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
              system: RESOLUTION_SYSTEM_PROMPT,
              messages: [{ role: 'user' as const, content: userPrompt }],
              maxOutputTokens: 256,
              temperature: 0,
            },
            {
              service: 'evaluate-resolution',
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId,
            },
          );
        });

        const parsed = parseJSON<ResolutionLLMResponse>(llmResult.content);
        if (parsed && VALID_STATUSES.has(parsed.resolution_status)) {
          resolutionStatus = parsed.resolution_status;
          resolutionReason = (parsed.resolution_reason ?? '').slice(0, MAX_REASON_LEN);
          resolutionConfidence = Math.round((parsed.resolution_confidence ?? 0) * 1000) / 1000;
        } else {
          evalError = 'Failed to parse resolution LLM response or invalid status';
        }
        resolutionInputTokens = llmResult.inputTokens ?? 0;
        resolutionOutputTokens = llmResult.outputTokens ?? 0;
        resolutionModelId = llmResult.model;
      } catch (error) {
        evalError = error instanceof Error ? error.message : String(error);
        log.error('Resolution evaluation LLM failed — writing row without resolution', {
          tenantId: input.tenantId,
          sessionId,
          error: evalError,
        });
      }

      // Build the unified row: all classification fields + resolution columns.
      // Combine token usage and processing time across both LLM calls; tag with
      // the resolution model id since this row is the consolidated end-state.
      const now = new Date();
      const totalProcessingMs = (classificationRow.processing_ms ?? 0) + (Date.now() - startTime);
      const row: IntentClassificationRowWithResolution = {
        ...classificationRow,
        processed_at: toCHDateTime(now),
        processing_ms: totalProcessingMs,
        input_tokens: (classificationRow.input_tokens ?? 0) + resolutionInputTokens,
        output_tokens: (classificationRow.output_tokens ?? 0) + resolutionOutputTokens,
        model_id: resolutionModelId || classificationRow.model_id,
        resolution_status: resolutionStatus,
        resolution_reason: resolutionReason,
        resolution_confidence: resolutionConfidence,
      };

      try {
        await ctx.run('store-intent-with-resolution', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: INTENT_TABLE,
            values: [row],
            format: 'JSONEachRow',
          });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Failed to write intent_classifications row from evaluate-resolution', {
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

      log.debug('Intent resolution evaluation complete', {
        tenantId: input.tenantId,
        sessionId,
        intent: primaryIntent,
        resolutionStatus: resolutionStatus || '(none)',
        evalError,
      });

      return {
        status: 'success',
        data: {
          intent: primaryIntent,
          resolutionStatus,
          resolutionConfidence,
          resolutionReason,
          inputTokens: resolutionInputTokens,
          outputTokens: resolutionOutputTokens,
          ...(evalError ? { evalError } : {}),
        },
        durationMs: Date.now() - startTime,
      };
    },
  },
});

export type EvaluateResolutionService = typeof evaluateResolutionService;
