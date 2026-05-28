/**
 * Guardrail-specific action types.
 *
 * Separate from ConstraintAction — guardrails support graduated failure
 * actions (warn, fix, reask, filter) that don't apply to flat constraints.
 *
 * See design doc: docs/plans/2026-03-01-guardrails-system-design.md
 * Appendix A.1 and Section 10.
 */

export type GuardrailActionType =
  | 'block' // Terminal: reject content, return error message
  | 'warn' // Non-terminal: log + webhook, continue execution
  | 'redact' // Non-terminal: replace sensitive content, continue
  | 'fix' // Non-terminal: auto-fix violation, continue
  | 'reask' // Conditional: ask LLM to regenerate (output only)
  | 'filter' // Non-terminal: remove violating portions, continue
  | 'escalate'; // Terminal: route to human agent

export type SeverityLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export type FixStrategy = 'truncate' | 'strip_html' | 'redact_pii' | 'normalize' | 'custom';

export interface GuardrailAction {
  type: GuardrailActionType;
  message?: string;
  reason?: string;
  /** For reask: max retry attempts (default: 2) */
  maxReasks?: number;
  /** For fix: fix strategy */
  fixStrategy?: FixStrategy;
  /** For fix with custom strategy: CEL expression that returns fixed content */
  fixExpression?: string;
  /** For fix with truncate strategy: maximum content length */
  maxLength?: number;
  /** For redact: mode to use ('pii' or 'pattern') */
  redactMode?: 'pii' | 'pattern';
  /** For redact with pattern mode: regex pattern to match */
  redactPattern?: string;
  /** For filter: minimum content length after filtering (below this → block) */
  filterMinLength?: number;
}
