import type { GuardrailViolation, GuardrailPipelineResult } from './types.js';
import { createEmptyPipelineResult, isTerminalAction } from './types.js';
import { ACTION_PRECEDENCE } from './constants.js';
export { ACTION_PRECEDENCE };

/**
 * Aggregate individual guardrail violations into a single pipeline result.
 *
 * Rules:
 *   1. `warn` violations are separated into `warnings` — they never fail the pipeline.
 *   2. Terminal actions (block, escalate) cause `passed = false`.
 *   3. Non-terminal actions (redact, fix, filter) are tracked as violations
 *      but do not fail the pipeline on their own.
 *   4. When terminal violations exist, the one with the highest ACTION_PRECEDENCE
 *      becomes `primaryViolation`.
 *
 * @param allViolations - Violations collected across all tiers
 * @param originalContent - The original content before any modifications
 * @returns Aggregated pipeline result
 */
export function aggregateResults(
  allViolations: GuardrailViolation[],
  originalContent: string,
  totalChecksCount?: number,
): GuardrailPipelineResult {
  const result = createEmptyPipelineResult();

  const warnings: GuardrailViolation[] = [];
  const terminalViolations: GuardrailViolation[] = [];
  const nonTerminalViolations: GuardrailViolation[] = [];

  for (const v of allViolations) {
    if (v.action === 'warn') {
      warnings.push(v);
    } else if (isTerminalAction(v.action)) {
      terminalViolations.push(v);
    } else {
      nonTerminalViolations.push(v);
    }
  }

  result.warnings = warnings;
  result.metrics.warnings = warnings.length;

  if (terminalViolations.length > 0) {
    result.passed = false;
    result.violations = [...terminalViolations, ...nonTerminalViolations];
    result.metrics.failed = result.violations.length;
    // Primary = highest precedence terminal action
    result.primaryViolation = terminalViolations.sort(
      (a, b) => (ACTION_PRECEDENCE[b.action] ?? 0) - (ACTION_PRECEDENCE[a.action] ?? 0),
    )[0];
  } else {
    result.passed = true;
    result.violations = nonTerminalViolations;
    result.metrics.failed = nonTerminalViolations.length;
  }

  result.metrics.totalChecks = totalChecksCount ?? allViolations.length;
  result.metrics.passed =
    result.metrics.totalChecks - result.metrics.failed - result.metrics.warnings;

  return result;
}
