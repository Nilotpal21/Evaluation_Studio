/**
 * LLMEvaluate — Restate activity service for tag-driven LLM evaluations.
 *
 * Replaces the former call-llm service. When `tag` is present in config,
 * results are persisted to the `llm_evaluate` ClickHouse table. When tag
 * is absent (backward-compat call-llm alias), behaves as a pure LLM call
 * with no storage.
 *
 * Config:
 *   tag:             Evaluation tag identifier (required for storage)
 *   systemPrompt:    System instructions
 *   userPrompt:      User prompt — {{...}} templates are auto-resolved
 *   outputSchema?:   JSON schema for expected output (injected into system prompt)
 *   strict?:         Retry on schema/parse failure (max 2 retries)
 *   scoreField?:     Output field to extract as score (default: "score")
 *   model?:          LLM model override
 *   temperature?:    LLM temperature (default: 0)
 *   maxTokens?:      Max output tokens (default: 1024)
 */
import * as restate from '@restatedev/restate-sdk';
import AjvDefault from 'ajv';
import type { ErrorObject } from 'ajv';
import { createLogger, parseJSON } from '@abl/compiler/platform';
import { resolveExpression } from '../expression-evaluator.js';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';

const log = createLogger('llm-evaluate');

const MAX_STRICT_RETRIES = 2;
const DATABASE = 'abl_platform';

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

const TEMPLATE_PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

function resolveTemplate(
  template: string,
  previousSteps: Record<string, StepOutput>,
  pipelineInput: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_PLACEHOLDER_RE, (_match, path: string) => {
    const trimmedPath = path.trim();
    const value = resolveExpression(trimmedPath, previousSteps, pipelineInput);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function hasTemplatePlaceholders(text: string): boolean {
  TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
  return TEMPLATE_PLACEHOLDER_RE.test(text);
}

// ---------------------------------------------------------------------------
// ClickHouse helpers
// ---------------------------------------------------------------------------

function toCHDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

// Handle CJS/ESM interop for NodeNext moduleResolution
const Ajv = (AjvDefault as any).default ?? AjvDefault;
const ajv = new Ajv({ allErrors: true, strict: false });

function validateAgainstSchema(data: unknown, schema: Record<string, unknown>): string[] {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) return [];
  return (validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '/'}: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const llmEvaluateService = restate.service({
  name: 'LLMEvaluate',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // --- Extract config ---
      const tag = input.config.tag as string | undefined;
      const systemPrompt = input.config.systemPrompt as string | undefined;
      const userPrompt = input.config.userPrompt as string | undefined;
      const outputSchema = input.config.outputSchema as Record<string, unknown> | undefined;
      const strict = (input.config.strict as boolean) ?? false;
      const scoreField = (input.config.scoreField as string) ?? 'score';
      const model = input.config.model as string | undefined;
      const temperature = input.config.temperature as number | undefined;
      const maxTokens = input.config.maxTokens as number | undefined;

      // backward-compat: call-llm alias may use responseFormat
      const responseFormat = (input.config.responseFormat as 'json' | 'text') ?? 'json';

      try {
        // --- Validate required fields ---
        if (!userPrompt) {
          return {
            status: 'fail',
            data: {
              error: 'LLMEvaluate requires userPrompt in config',
            },
            durationMs: Date.now() - startTime,
          };
        }

        // --- Resolve user prompt templates ---
        let resolvedUserPrompt = userPrompt;
        TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
        if (hasTemplatePlaceholders(userPrompt)) {
          TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
          resolvedUserPrompt = resolveTemplate(
            userPrompt,
            input.previousSteps,
            input.pipelineInput,
          );
        }

        // --- Build system prompt (inject schema if provided) ---
        let finalSystemPrompt = systemPrompt ?? '';
        if (outputSchema) {
          finalSystemPrompt +=
            '\n\nYou MUST respond with valid JSON matching this schema:\n```json\n' +
            JSON.stringify(outputSchema, null, 2) +
            '\n```';
        }

        // --- Build initial messages ---
        const messages: { role: string; content: string }[] = [];
        if (finalSystemPrompt) {
          messages.push({ role: 'system', content: finalSystemPrompt });
        }
        messages.push({ role: 'user', content: resolvedUserPrompt });

        log.debug('LLMEvaluate executing', {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          tag,
          hasSchema: !!outputSchema,
          strict,
        });

        // --- LLM call with strict retry loop ---
        let parsed: Record<string, unknown> | null = null;
        let raw = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let usedModel = '';
        let attempt = 0;

        while (attempt <= MAX_STRICT_RETRIES) {
          const llmResult = await ctx.run(`llm-evaluate-attempt-${attempt}`, async () => {
            let resolved;
            try {
              resolved = await resolvePipelineLLM(input.tenantId, input.projectId, model);
            } catch (err) {
              throw new restate.TerminalError(
                `LLM resolution failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // Separate system prompt from user messages for pipelineGenerateText
            const systemMsg = messages.find((m) => m.role === 'system');
            const nonSystemMessages = messages.filter((m) => m.role !== 'system');
            return pipelineGenerateText(
              resolved,
              {
                ...(systemMsg ? { system: systemMsg.content } : {}),
                messages: nonSystemMessages.map((m) => ({
                  role: m.role as 'user' | 'assistant',
                  content: m.content,
                })),
                maxOutputTokens: maxTokens ?? 1024,
                temperature: temperature ?? 0,
              },
              {
                service: 'llm-evaluate',
                tenantId: input.tenantId,
                projectId: input.projectId,
                sessionId: input.sessionId,
              },
            );
          });

          raw = llmResult.content;
          totalInputTokens += llmResult.inputTokens;
          totalOutputTokens += llmResult.outputTokens;
          usedModel = llmResult.model;

          // Step A: Parse JSON (parseJSON strips markdown code fences)
          parsed = parseJSON<Record<string, unknown>>(raw);
          if (!parsed) {
            if (strict && attempt < MAX_STRICT_RETRIES) {
              messages.push({ role: 'assistant', content: raw });
              messages.push({
                role: 'user',
                content: 'Your response was not valid JSON. Please respond with valid JSON only.',
              });
              attempt++;
              continue;
            }
            // Non-strict or max retries: fail if tag required, else return raw
            if (tag) {
              return {
                status: 'fail',
                data: { error: 'LLM response was not valid JSON', raw },
                durationMs: Date.now() - startTime,
              };
            }
            // call-llm compat: return raw
            parsed = null;
            break;
          }

          // Step B: Validate against schema
          if (outputSchema && parsed) {
            const errors = validateAgainstSchema(parsed, outputSchema);
            if (errors.length > 0 && strict && attempt < MAX_STRICT_RETRIES) {
              messages.push({ role: 'assistant', content: raw });
              messages.push({
                role: 'user',
                content:
                  'Your response did not match the required schema.\n' +
                  'Validation errors:\n' +
                  errors.map((e) => `- ${e}`).join('\n') +
                  '\n\nPlease respond again with valid JSON matching the schema.',
              });
              attempt++;
              continue;
            }
            // Non-strict or valid: continue with whatever we have
          }

          break; // valid or not strict or max retries
        }

        // --- Extract score ---
        let score: number | null = null;
        if (parsed && scoreField in parsed) {
          const val = parsed[scoreField];
          if (typeof val === 'number' && !isNaN(val)) {
            score = val;
            if (score < 0 || score > 1) {
              log.warn('Score outside 0-1 range', {
                tenantId: input.tenantId,
                sessionId: input.sessionId,
                tag,
                score,
                scoreField,
              });
            }
          }
        }

        // --- Write to ClickHouse (only when tag is present) ---
        if (tag && parsed) {
          const metadata = (input.pipelineInput.metadata ?? {}) as Record<string, unknown>;
          const row = {
            tenant_id: input.tenantId,
            project_id: input.projectId ?? '',
            session_id: input.sessionId ?? (input.pipelineInput.sessionId as string) ?? '',
            session_started_at: toCHDateTime(new Date()),
            tag,
            score,
            output: JSON.stringify(parsed),
            agent_name: (metadata.agentName as string) ?? '',
            channel: (metadata.channel as string) ?? '',
            model_id: usedModel,
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            processing_ms: Date.now() - startTime,
            pipeline_id: input.pipelineId ?? '',
            pipeline_type: input.pipelineType ?? '',
            source: (input.pipelineInput.executionMode as string) ?? 'batch',
            config_version: Number(input.config.configVersion) || 1,
            processed_at: toCHDateTime(new Date()),
          };

          await ctx.run('store-llm-evaluate', async () => {
            const client = getClickHouseClient();
            await client.insert({
              table: `${DATABASE}.llm_evaluate`,
              values: [row],
              format: 'JSONEachRow',
            });
          });

          log.debug('LLM evaluation stored', {
            tenantId: input.tenantId,
            sessionId: input.sessionId,
            tag,
            score,
          });
        }

        // --- Return ---
        return {
          status: 'success',
          data: {
            tag,
            score,
            ...(parsed ?? {}),
            parsed: parsed ?? undefined,
            raw,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: usedModel,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('LLMEvaluate failed', {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          tag,
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

export type LLMEvaluateService = typeof llmEvaluateService;
