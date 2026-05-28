/**
 * Shared severity → action resolver used by Tier 1, Tier 2, and Tier 3 evaluators.
 *
 * A guardrail's `severityActions` map lets authors override the default
 * action per detected severity level (low/medium/high/critical). The
 * resolver prefers a severity-specific override when available and falls
 * back to `guardrail.action` otherwise.
 *
 * 'safe' never triggers a severity override — by definition a safe
 * evaluation is not a violation.
 */

import type { Guardrail, GuardrailAction, SeverityLevel } from '../ir/schema.js';

export function resolveAction(guardrail: Guardrail, severity: SeverityLevel): GuardrailAction {
  if (severity !== 'safe' && guardrail.severityActions?.[severity]) {
    return guardrail.severityActions[severity]!;
  }
  return guardrail.action;
}
