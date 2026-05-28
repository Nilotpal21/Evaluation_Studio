/**
 * ComputeIntent — Restate activity service for LLM-based intent classification.
 *
 * Classifies conversation intent from the first N user messages.
 * Supports customer-defined taxonomy from pipeline config, or auto-discovery
 * when no taxonomy is provided.
 *
 * Writes results to:
 *   - abl_platform.intent_classifications (one row per session)
 *
 * Reads from: execution context 'conversation' key or previousSteps fallback
 *
 * Spec reference: Phase 2 config schema + Phase 3-5 output/presentation/index design
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger, parseJSON } from '@abl/compiler/platform';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import {
  INTENT_SYSTEM_PROMPT,
  buildTaxonomyPrompt,
  buildIntentUserPrompt,
} from '../prompts/index.js';
import type { TaxonomyCategory } from '../prompts/index.js';

const log = createLogger('compute-intent');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTENT_TABLE = 'abl_platform.intent_classifications';

/** Default confidence threshold — below this, intent is labeled 'unknown'. */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/** Default max user messages to use for classification. */
const DEFAULT_INPUT_MESSAGE_COUNT = 3;

/** Default config version — overridden by resolved pipeline config version. */
const DEFAULT_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IntentLLMResponse {
  intent: string;
  intent_display: string;
  confidence: number;
  secondary_intents?: Array<{
    intent: string;
    confidence: number;
  }>;
  reasoning?: string;
}

interface IntentClassificationRow {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ClickHouse DateTime64(3) format — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Select messages for classification based on the configured strategy.
 * Defaults to first N user messages.
 */
function selectInputMessages(
  messages: Array<{
    role: string;
    content: string;
    messageId: string;
    timestamp: string;
    channel?: string;
  }>,
  strategy: string,
  count: number,
): Array<{
  role: string;
  content: string;
  messageId: string;
  timestamp: string;
  channel?: string;
}> {
  switch (strategy) {
    case 'first_user': {
      const first = messages.find((m) => m.role === 'user');
      return first ? [first] : [];
    }
    case 'first_n_user': {
      const userMsgs = messages.filter((m) => m.role === 'user');
      return userMsgs.slice(0, count);
    }
    case 'all_user':
      return messages.filter((m) => m.role === 'user');
    case 'full_transcript':
      return messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    default:
      // Default: first N user messages
      return messages.filter((m) => m.role === 'user').slice(0, count);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeIntentService = restate.service({
  name: 'ComputeIntent',
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
              'ComputeIntent requires conversation data (from read-conversation or execution context)',
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Support both read-conversation and read-message-window output shapes
      let messages:
        | Array<{
            messageId: string;
            role: string;
            content: string;
            timestamp: string;
            channel?: string;
          }>
        | undefined;
      let metadata:
        | { agentName?: string; channel?: string; messageCount: number; durationMs?: number }
        | undefined;

      if (conversationData.triggeringMessage && input.config.mode) {
        // read-message-window output: convert to messages array
        const trigger = conversationData.triggeringMessage as {
          role: string;
          content: string;
          messageIndex: number;
          messageId: string;
        };
        const window =
          (conversationData.windowMessages as Array<{
            messageId: string;
            role: string;
            content: string;
            timestamp: string;
            channel?: string;
          }>) ?? [];
        const wmeta =
          (conversationData.metadata as {
            sessionId?: string;
            agentName?: string;
            channel?: string;
            windowSize?: number;
            totalSessionMessages?: number;
          }) ?? {};
        messages = [
          ...window,
          {
            messageId: trigger.messageId,
            role: trigger.role,
            content: trigger.content,
            timestamp: new Date().toISOString(),
            channel: wmeta.channel,
          },
        ];
        metadata = {
          agentName: wmeta.agentName,
          channel: wmeta.channel,
          messageCount: wmeta.totalSessionMessages ?? messages.length,
        };
      } else {
        messages = conversationData.messages as typeof messages;
        metadata = conversationData.metadata as typeof metadata;
      }

      if (!messages || messages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No messages found in conversation data' },
          durationMs: Date.now() - startTime,
        };
      }

      // Check for user messages
      const hasUserMessages = messages.some((m) => m.role === 'user');
      if (!hasUserMessages) {
        return {
          status: 'skipped',
          data: { reason: 'No user messages found in conversation' },
          durationMs: Date.now() - startTime,
        };
      }

      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);
      const configVersion =
        (input.config.configVersion as number | undefined) ?? DEFAULT_CONFIG_VERSION;

      // Extract config values
      const taxonomy = (input.config.taxonomy as TaxonomyCategory[] | undefined) ?? [];
      const confidenceThreshold =
        (input.config.confidenceThreshold as number) ?? DEFAULT_CONFIDENCE_THRESHOLD;
      const inputMessageStrategy = (input.config.inputMessageStrategy as string) ?? 'first_n_user';
      const inputMessageCount =
        (input.config.inputMessageCount as number) ?? DEFAULT_INPUT_MESSAGE_COUNT;
      const taxonomyVersion = (input.config.taxonomyVersion as string) ?? '0';
      const unknownIntentLabel = (input.config.unknownIntentLabel as string) ?? 'unknown';

      try {
        // Select messages for classification
        const inputMessages = selectInputMessages(
          messages,
          inputMessageStrategy,
          inputMessageCount,
        );

        if (inputMessages.length === 0) {
          return {
            status: 'skipped',
            data: { reason: 'No messages matched the input strategy' },
            durationMs: Date.now() - startTime,
          };
        }

        log.debug('Computing intent classification', {
          tenantId: input.tenantId,
          sessionId,
          inputMessageCount: inputMessages.length,
          hasTaxonomy: taxonomy.length > 0,
        });

        // Build LLM prompt
        let systemPrompt = (input.config.classificationPrompt as string) ?? INTENT_SYSTEM_PROMPT;
        if (taxonomy.length > 0) {
          systemPrompt += buildTaxonomyPrompt(taxonomy);
        }

        const userPrompt = buildIntentUserPrompt(inputMessages);

        // Call LLM
        const llmResult = await ctx.run('compute-intent-llm', async () => {
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
              temperature: 0,
            },
            {
              service: 'compute-intent',
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId,
            },
          );
        });

        // Parse LLM response (parseJSON strips markdown code fences)
        const parsed = parseJSON<IntentLLMResponse>(llmResult.content);
        if (!parsed) {
          return {
            status: 'fail',
            data: { error: 'Failed to parse intent LLM response as JSON' },
            durationMs: Date.now() - startTime,
          };
        }

        // Apply confidence threshold
        const isConfident = parsed.confidence >= confidenceThreshold;
        const finalIntent = isConfident ? parsed.intent : unknownIntentLabel;
        const finalDisplay = isConfident
          ? parsed.intent_display
          : unknownIntentLabel.charAt(0).toUpperCase() + unknownIntentLabel.slice(1);

        // Check if intent was auto-discovered (not in taxonomy)
        const taxonomyNames = new Set(
          taxonomy.flatMap((cat) => [cat.name, ...(cat.subCategories?.map((s) => s.name) ?? [])]),
        );
        const isAutoDiscovered = taxonomy.length > 0 && !taxonomyNames.has(parsed.intent) ? 1 : 0;

        // Build secondary intents array
        const secondaryIntents = (parsed.secondary_intents ?? [])
          .filter((s) => s.confidence > 0.2)
          .map((s) => s.intent);

        // Build ClickHouse row
        const now = new Date();
        const processedAt = toCHDateTime(now);
        const processingMs = Date.now() - startTime;

        const sessionStartedAt = messages[0]?.timestamp
          ? toCHDateTime(new Date(messages[0].timestamp))
          : processedAt;

        const row: IntentClassificationRow = {
          tenant_id: input.tenantId,
          project_id: input.projectId ?? '',
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          processed_at: processedAt,
          agent_name: metadata?.agentName ?? '',
          channel: metadata?.channel ?? '',
          intent: finalIntent,
          intent_display: finalDisplay,
          sub_intent: '',
          confidence: Math.round(parsed.confidence * 1000) / 1000,
          secondary_intents: secondaryIntents,
          is_auto_discovered: isAutoDiscovered,
          model_id: llmResult.model,
          config_version: configVersion,
          taxonomy_version: taxonomyVersion,
          processing_ms: processingMs,
          input_tokens: llmResult.inputTokens ?? 0,
          output_tokens: llmResult.outputTokens ?? 0,
          run_id: (input.pipelineInput?.runId as string) ?? '',
          pipeline_id: input.pipelineId ?? '',
          pipeline_type: input.pipelineType ?? '',
        };

        // Write to ClickHouse (skipped when store-results handles persistence)
        if (!input.config.skipDirectWrite) {
          await ctx.run('store-intent-results', async () => {
            const client = getClickHouseClient();
            await client.insert({
              table: INTENT_TABLE,
              values: [row],
              format: 'JSONEachRow',
            });
          });
        }

        log.debug('Intent classification complete', {
          tenantId: input.tenantId,
          sessionId,
          intent: finalIntent,
          confidence: parsed.confidence,
          isAutoDiscovered,
        });

        return {
          status: 'success',
          data: {
            intent: finalIntent,
            intentDisplay: finalDisplay,
            confidence: parsed.confidence,
            secondaryIntents,
            isAutoDiscovered: isAutoDiscovered === 1,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            // Full row carried forward when downstream steps (e.g. evaluate-resolution)
            // need to write a unified intent_classifications row in batch mode.
            classificationRow: row,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ComputeIntent failed', {
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
export type ComputeIntentService = typeof computeIntentService;
