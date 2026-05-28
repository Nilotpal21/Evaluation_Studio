/**
 * LLM Field Validator -- Validates extracted field values using LLM when
 * validation_process is set to 'llm' in the gather field definition.
 *
 * Fail-open: LLM errors -> field treated as valid (non-blocking).
 */

import type { ValidationRule } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { SessionLLMClient } from '../llm/session-llm-client.js';
import { promptTemplateLoader } from './prompt-template-loader.js';
import { interpolateTemplate } from './value-resolution.js';
import { getModelCapabilities, calculateCost, hasKnownPricing } from '../llm/model-router.js';

const log = createLogger('llm-field-validator');

const MAX_VALIDATION_PROMPT_LENGTH = 2000;

type TraceCallback = (event: { type: string; data: Record<string, unknown> }) => void;

type LLMClient = Pick<SessionLLMClient, 'chatWithToolUse'>;

interface LLMValidationResult {
  valid: boolean;
  error?: string;
  reason?: string;
}

/**
 * Validate a single field value using LLM.
 * Returns { valid: true } on success, { valid: false, error, reason } on failure.
 * Fail-open: returns { valid: true } on LLM errors.
 */
export async function validateFieldWithLLM(
  fieldName: string,
  value: unknown,
  rule: string,
  llmClient: LLMClient,
  onTraceEvent?: TraceCallback,
  promptOverride?: string,
  agentName?: string,
): Promise<LLMValidationResult> {
  // Guard: oversized value
  const valueStr = JSON.stringify(value);
  if (valueStr.length > MAX_VALIDATION_PROMPT_LENGTH) {
    return {
      valid: false,
      error: `Value exceeds maximum validation size (${valueStr.length} chars)`,
      reason: 'oversized',
    };
  }

  const systemPrompt = interpolateTemplate(
    promptOverride ?? promptTemplateLoader.getLLMPrompt('field_validation'),
    { rule, fieldName, valueStr },
  );

  try {
    const startTime = Date.now();
    const response = await llmClient.chatWithToolUse(
      systemPrompt,
      [{ role: 'user' as const, content: `Validate this value: ${valueStr}` }],
      [],
      'validation',
    );
    const durationMs = Date.now() - startTime;

    onTraceEvent?.({
      type: 'llm_call',
      data: {
        purpose: 'field_validation',
        responseContribution: 'internal_only',
        agent: agentName,
        fieldName,
        value: valueStr.slice(0, 200),
        rule,
        durationMs,
        model: response.resolvedModel?.modelId || 'unknown',
        provider: response.resolvedModel?.provider,
        source: response.resolvedModel?.source,
        usage: response.usage,
        tokensIn: response.usage?.inputTokens || 0,
        tokensOut: response.usage?.outputTokens || 0,
        totalTokens: (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0),
        stopReason: response.stopReason,
        cost: (() => {
          const mid = response.resolvedModel?.modelId;
          const tIn = response.usage?.inputTokens || 0;
          const tOut = response.usage?.outputTokens || 0;
          if (mid && mid !== 'unknown' && hasKnownPricing(mid) && (tIn > 0 || tOut > 0)) {
            const caps = getModelCapabilities(mid);
            return calculateCost(caps.inputCostPer1k, caps.outputCostPer1k, tIn, tOut);
          }
          return undefined;
        })(),
      },
    });

    const text = response.text || '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        // Can't parse LLM response -- fail-open
        log.warn('LLM validation response unparseable, fail-open', {
          fieldName,
          text: text.slice(0, 200),
        });
        return { valid: true };
      }
    }

    if (parsed.valid === false) {
      return {
        valid: false,
        error: String(parsed.reason || 'LLM validation failed'),
        reason: String(parsed.reason || ''),
      };
    }
    return { valid: true };
  } catch (err) {
    // Fail-open: LLM error -> treat as valid
    log.warn('LLM validation call failed, fail-open', { fieldName, error: String(err) });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'validateFieldWithLLM', fieldName, error: String(err) },
    });
    return { valid: true };
  }
}

/**
 * Batch-validate all fields with type: 'llm' validation rules.
 * Returns a map of field -> error message for fields that failed validation.
 * Runs validations in parallel. Fail-open on errors.
 */
export async function validateFieldsWithLLM(
  values: Record<string, unknown>,
  gatherFields: Array<{ name: string; validation?: ValidationRule }>,
  llmClient: LLMClient,
  onTraceEvent?: TraceCallback,
  promptOverride?: string,
  agentName?: string,
): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};

  // Find fields with LLM validation
  const llmValidationFields = gatherFields.filter(
    (f) => f.validation?.type === 'llm' && values[f.name] !== undefined && values[f.name] !== null,
  );

  if (llmValidationFields.length === 0) return errors;

  // Run all LLM validations in parallel
  const results = await Promise.all(
    llmValidationFields.map(async (field) => {
      const result = await validateFieldWithLLM(
        field.name,
        values[field.name],
        field.validation!.rule,
        llmClient,
        onTraceEvent,
        promptOverride,
        agentName,
      );
      return { field: field.name, result };
    }),
  );

  for (const { field, result } of results) {
    if (!result.valid && result.error) {
      errors[field] = result.error;
    }
  }

  return errors;
}
