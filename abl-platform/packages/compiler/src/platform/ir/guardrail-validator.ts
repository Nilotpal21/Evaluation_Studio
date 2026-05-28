/**
 * Compile-time validation for guardrail action+kind combinations.
 *
 * Enforces rules such as:
 * - `reask` is only valid on output guardrails (needs LLM regeneration)
 * - `fix` and `filter` are not valid on handoff guardrails (content is opaque at handoff)
 * - `fix` without a `fixStrategy` is a warning (falls back to block at runtime)
 *
 * See design doc: docs/plans/2026-03-01-guardrails-system-design.md
 */

import type { AgentIR, Guardrail, GuardrailKind } from './schema.js';
import type { GuardrailAction, GuardrailActionType } from './guardrail-action.js';
import type { ValidationDiagnostic as IRValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';

export interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  guardrailName: string;
  message: string;
}

/**
 * Allowed action types per guardrail kind.
 *
 * - `reask` is output-only: it triggers LLM regeneration, which only makes sense
 *   when evaluating model output.
 * - `fix` and `filter` are not valid on handoff: handoff payloads are opaque
 *   inter-agent messages that cannot be meaningfully auto-fixed or filtered.
 */
const ALLOWED_ACTIONS: Record<GuardrailKind, GuardrailActionType[]> = {
  input: ['block', 'warn', 'redact', 'fix', 'filter', 'escalate'],
  output: ['block', 'warn', 'redact', 'fix', 'reask', 'filter', 'escalate'],
  tool_input: ['block', 'warn', 'redact', 'fix', 'filter', 'escalate'],
  tool_output: ['block', 'warn', 'redact', 'fix', 'filter', 'escalate'],
  handoff: ['block', 'warn', 'redact', 'escalate'],
};

/**
 * Validate an array of guardrails for action+kind compatibility.
 *
 * Checks both the default `action` and any `severityActions` overrides.
 * Returns an array of diagnostics (errors and warnings). An empty array
 * means all guardrails are valid.
 */
export function validateGuardrails(guardrails: Guardrail[]): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  for (const g of guardrails) {
    validateAction(g.name, g.kind, g.action, diagnostics);

    if (g.severityActions) {
      for (const [, action] of Object.entries(g.severityActions)) {
        if (action) {
          validateAction(g.name, g.kind, action, diagnostics);
        }
      }
    }
  }

  return diagnostics;
}

/**
 * Adapter that validates guardrails from an AgentIR and returns diagnostics
 * in the orchestrator's ValidationDiagnostic shape (compatible with validateIR).
 */
export function validateGuardrailsForIR(agent: AgentIR): IRValidationDiagnostic[] {
  const guardrails = agent.constraints?.guardrails ?? [];
  if (guardrails.length === 0) return [];

  const localDiags = validateGuardrails(guardrails);
  return localDiags.map((d) => ({
    agent: agent.metadata.name,
    message: `Guardrail "${d.guardrailName}": ${d.message}`,
    type: 'validation' as const,
    severity: d.severity,
    code:
      d.severity === 'error'
        ? VALIDATION_CODES.INVALID_GUARDRAIL_ACTION
        : VALIDATION_CODES.GUARDRAIL_ACTION_WARNING,
    path: `constraints.guardrails.${d.guardrailName}`,
  }));
}

function validateAction(
  guardrailName: string,
  kind: GuardrailKind,
  action: GuardrailAction,
  diagnostics: ValidationDiagnostic[],
): void {
  const allowed = ALLOWED_ACTIONS[kind];
  if (!allowed.includes(action.type)) {
    diagnostics.push({
      severity: 'error',
      guardrailName,
      message: `Action '${action.type}' is not valid for kind '${kind}'. Allowed: ${allowed.join(', ')}`,
    });
  }

  if (action.type === 'fix' && !action.fixStrategy) {
    diagnostics.push({
      severity: 'warning',
      guardrailName,
      message: `Action 'fix' should have a fixStrategy. Without one, it falls back to 'block' at runtime.`,
    });
  }

  // Validate maxReasks bounds for reask actions
  if (action.type === 'reask' && action.maxReasks !== undefined) {
    if (action.maxReasks > 5) {
      diagnostics.push({
        severity: 'error',
        guardrailName,
        message: `maxReasks must be between 1 and 5 (got ${action.maxReasks}). Higher values cause excessive latency and cost.`,
      });
    }
    if (action.maxReasks < 1) {
      diagnostics.push({
        severity: 'error',
        guardrailName,
        message: `maxReasks must be at least 1 (got ${action.maxReasks}). Use action 'block' instead of reask with 0 retries.`,
      });
    }
  }
}
