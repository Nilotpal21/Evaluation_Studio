/**
 * Guardrail i18n message helper.
 *
 * Centralizes guardrail message resolution via ErrorCatalog codes.
 * All user-facing guardrail messages should go through this module.
 */

import { formatErrorSync } from '@agent-platform/i18n';
import type { MessageParams } from '@agent-platform/i18n';

/** Guardrail error code constants for type safety */
export const GuardrailErrorCode = {
  INPUT_BLOCKED: 'GUARDRAIL_INPUT_BLOCKED',
  POLICY_BLOCKED: 'GUARDRAIL_POLICY_BLOCKED',
  TOOL_INPUT_BLOCKED: 'GUARDRAIL_TOOL_INPUT_BLOCKED',
  TOOL_OUTPUT_BLOCKED: 'GUARDRAIL_TOOL_OUTPUT_BLOCKED',
  HANDOFF_BLOCKED: 'GUARDRAIL_HANDOFF_BLOCKED',
  STREAM_TERMINATED: 'GUARDRAIL_STREAM_TERMINATED',
  MESSAGE_UNPROCESSABLE: 'GUARDRAIL_MESSAGE_UNPROCESSABLE',
  EVALUATOR_UNAVAILABLE: 'GUARDRAIL_EVALUATOR_UNAVAILABLE',
  EVAL_FAILED: 'GUARDRAIL_EVAL_FAILED',
  PROVIDER_NOT_REGISTERED: 'GUARDRAIL_PROVIDER_NOT_REGISTERED',
  FILTER_ESCALATED: 'GUARDRAIL_FILTER_ESCALATED',
} as const;

/**
 * Resolve a guardrail message from the i18n ErrorCatalog.
 * Returns the formatted English message string.
 */
export function guardrailMessage(code: string, params?: MessageParams): string {
  return formatErrorSync(code, params).message;
}
