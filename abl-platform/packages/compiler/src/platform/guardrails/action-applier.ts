/**
 * Action Applier — applies non-terminal guardrail actions to content.
 *
 * After the pipeline evaluates guardrails and collects violations,
 * this module applies content-modifying actions (redact, fix, filter)
 * to produce `modifiedContent` on the pipeline result.
 *
 * Terminal actions (block, escalate) are not applied here — they stop
 * the pipeline. Non-terminal actions that modify content are applied
 * in priority order (lower priority number = applied first).
 */

import type { GuardrailAction } from '../ir/schema.js';
import type { GuardrailPipelineResult } from './types.js';
import { addViolation } from './types.js';
import { executeRedact } from './action-executors.js';
import { executeFix } from './action-executors.js';
import { executeFilter } from './action-executors.js';
import { createLogger } from '../logger.js';
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';

const log = createLogger('guardrail-action-applier');

/** Actions that modify content (non-terminal, non-warn) */
const CONTENT_MODIFYING_ACTIONS = new Set<string>(['redact', 'fix', 'filter']);

/**
 * Apply non-terminal guardrail actions to content and set `modifiedContent`
 * on the pipeline result.
 *
 * @param result - The pipeline result (modified in place)
 * @param content - The original content to modify
 * @param actionContexts - Map of guardrail name → action for applicable guardrails
 */
export function applyActions(
  result: GuardrailPipelineResult,
  content: string,
  actionContexts: Map<string, GuardrailAction>,
  options?: { piiRecognizerRegistry?: PIIRecognizerRegistry },
): void {
  // Collect violations that have content-modifying actions
  const modifyingViolations = result.violations
    .filter((v) => CONTENT_MODIFYING_ACTIONS.has(v.action))
    .sort((a, b) => a.priority - b.priority);

  if (modifyingViolations.length === 0) return;

  let modified = content;
  let wasModified = false;

  for (const violation of modifyingViolations) {
    // Prefer the violation's resolved action (includes severity-specific
    // payload like redactMode, fixStrategy, filterMinLength). Fall back to
    // the default action via actionContexts for legacy callers that have
    // not yet populated resolvedAction.
    const action = violation.resolvedAction ?? actionContexts.get(violation.name);
    if (!action) continue;

    try {
      switch (action.type) {
        case 'redact': {
          const before = modified;
          modified = executeRedact(
            modified,
            action.redactMode ?? 'pii',
            action.redactPattern,
            options?.piiRecognizerRegistry,
          );
          if (modified !== before) wasModified = true;
          break;
        }
        case 'fix': {
          if (action.fixStrategy) {
            const before = modified;
            modified = executeFix(
              modified,
              action.fixStrategy,
              action.maxLength,
              options?.piiRecognizerRegistry,
            );
            if (modified !== before) wasModified = true;
          }
          break;
        }
        case 'filter': {
          const patterns = violation.label ? [violation.label] : [];
          if (violation.category) patterns.push(violation.category);
          const filterResult = executeFilter(modified, patterns, action.filterMinLength ?? 10);
          if (filterResult === null) {
            // Too much content removed — escalate to block
            log.warn('Filter removed too much content, escalating to block', {
              guardrailName: violation.name,
            });
            addViolation(result, {
              ...violation,
              action: 'block',
              message: guardrailMessage(GuardrailErrorCode.FILTER_ESCALATED, {
                guardrailName: violation.name,
              }),
            });
            result.passed = false;
            return; // Stop applying further actions
          }
          if (filterResult !== modified) {
            modified = filterResult;
            wasModified = true;
          }
          break;
        }
      }
    } catch (err) {
      log.warn('Action application failed for guardrail', {
        guardrailName: violation.name,
        action: action.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (wasModified) {
    result.modifiedContent = modified;
  }
}
