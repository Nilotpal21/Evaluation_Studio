/**
 * Constraint Checker
 *
 * Checks all constraints (guardrails + constraints) and handles violations.
 * Delegates to checkConstraintsCore from @abl/compiler.
 */

import {
  checkConstraintsCore,
  evaluateConditionDual,
  extractVariableReferences,
  DEFAULT_MESSAGES,
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
} from '@abl/compiler';
import type { ConstraintCheckInfo } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { buildHandoffExecutionResult } from './types.js';
import type { RuntimeSession, ExecutionResult, HandoffExecutionResult } from './types.js';
import { interpolateTemplate } from './value-resolution.js';
import { promptTemplateLoader } from './prompt-template-loader.js';
import { emitProtectedExecutionResult } from './session-output-protection.js';
import { emitDecisionEvent } from './trace-helpers.js';
import { resolveLocalizedAgentMessageWithMetadata } from './localized-messages.js';

const log = createLogger('constraint-checker');

/** Maximum number of times a constraint can backtrack to the same step before escalating. */
export const MAX_BACKTRACKS_PER_STEP = 3;

/**
 * Directive returned by interpretConstraintControlFlow when a constraint violation
 * has a non-terminal control flow action (collect_field, goto_step, retry_step).
 */
export interface ConstraintControlFlowDirective {
  type: 'collect_field' | 'goto_step' | 'retry_step';
  /** Fields to collect for collect_field */
  fields?: string[];
  /** Target step for goto_step */
  targetStep?: string;
  /** Optional follow-up step after a collect_field directive succeeds */
  thenStep?: string;
  /** What to do after collection */
  thenAction?: 'continue' | 'retry';
  /** Response message to show user */
  respond?: string;
  /** The constraint condition that triggered this */
  constraintCondition: string;
}

export interface ConstraintCheckpoint {
  kind: 'tool_call' | 'response';
  target?: string;
}

/**
 * Narrow post-violation field clearing to the fields referenced by the failing
 * condition when possible. Falls back to all extracted fields if the condition
 * doesn't reference any of them.
 */
export function getConstraintFieldsToClear(extractedFields: string[], condition: string): string[] {
  if (extractedFields.length === 0) {
    return [];
  }

  const referencedFields = new Set(
    extractVariableReferences(condition).map((reference) => reference.split('.')[0]),
  );
  const matchingFields = extractedFields.filter((field) => referencedFields.has(field));

  return matchingFields.length > 0 ? matchingFields : extractedFields;
}

/**
 * Refresh the current-turn input context used by input-aware constraints.
 * `input` reflects the sanitized/current message, while `_raw_input` keeps the
 * original user text for callers that need the pre-guardrail version.
 */
export function setCurrentTurnInputContext(
  session: RuntimeSession,
  input: string,
  rawInput: string = input,
): void {
  session.data.values['input'] = input;
  session.data.values['_raw_input'] = rawInput;
}

/**
 * Check only flat constraints (no guardrails).
 * Input guardrails should go through the GuardrailPipelineImpl for proper
 * Tier-1/2/3 evaluation and policy resolution. This function keeps
 * the legacy constraint path for non-guardrail checks.
 */
export function checkFlatConstraints(
  session: RuntimeSession,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): ConstraintCheckInfo | null {
  const ir = session.agentIR;
  const profileConstraints = session._effectiveConfig?.additionalConstraints ?? [];
  if (!ir?.constraints && profileConstraints.length === 0) {
    return null;
  }

  const baseConstraints = ir?.constraints ?? { constraints: [], guardrails: [] };

  // ── Skip constraints referencing ungathered GATHER fields ──
  // Constraints that reference GATHER fields not yet collected are "not
  // applicable yet." Evaluating them prematurely produces false violations
  // because the dual-evaluator injects null for missing variables. For
  // OR-only conditions the compiler's autoGuardConstraint deliberately
  // skips auto-guarding (to avoid tautologies), so a REQUIRE like
  //   device_type == "iPhone" OR device_type == "iPad" OR ...
  // fails on turn 1 when device_type hasn't been gathered — and the
  // ON_FAIL message silently replaces the LLM's actual response.
  const gatherFieldNames = new Set((ir?.gather?.fields ?? []).map((f: { name: string }) => f.name));
  let allConstraints = [...(baseConstraints.constraints ?? []), ...profileConstraints];
  if (gatherFieldNames.size > 0) {
    allConstraints = allConstraints.filter((c) => {
      const refs = extractVariableReferences(c.condition);
      const ungathered = refs.filter((ref) => {
        const root = ref.split('.')[0];
        return gatherFieldNames.has(root) && !session.data.gatheredKeys.has(root);
      });
      if (ungathered.length > 0) {
        if (onTraceEvent) {
          onTraceEvent({
            type: 'constraint_guard_skipped',
            data: {
              agentName: session.agentName,
              condition: c.condition,
              reason: 'ungathered_gather_fields',
              ungatheredFields: ungathered,
            },
          });
        }
        return false;
      }
      return true;
    });
  }

  const constraintConfig = {
    ...baseConstraints,
    constraints: allConstraints,
    guardrails: [], // no guardrails — those go through the pipeline
  };

  const context = session.data.values;
  const warnings: ConstraintCheckInfo[] = [];

  const result = checkConstraintsCore(constraintConfig, context, {
    evaluateCondition: evaluateConditionDual,
    onCheck: (info) => {
      if (!info.passed && info.severity === 'warning') {
        warnings.push(info);
      }

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'constraint_check', {
        outcome: info.passed ? 'pass' : (info.action?.type ?? 'fail'),
        condition: info.condition,
        matched: info.passed,
        field: info.name,
        violation: info.passed ? undefined : info.severity,
      });

      if (onTraceEvent) {
        const varMatches = info.condition.match(/\b([a-z_][a-z0-9_]*)\b/gi) || [];
        const relevantContext: Record<string, unknown> = {};
        for (const varName of varMatches) {
          if (context[varName] !== undefined) {
            relevantContext[varName] = context[varName];
          }
        }
        onTraceEvent({
          type: info.guardSkipped
            ? 'constraint_guard_skipped'
            : info.severity === 'warning' && !info.passed
              ? 'constraint_warning'
              : 'constraint_check',
          data: {
            agentName: session.agentName,
            constraintType: info.type,
            severity: info.severity || 'error',
            name: info.name,
            condition: info.condition,
            passed: info.passed,
            guardSkipped: info.guardSkipped,
            relevantContext,
            onFail: info.action,
          },
        });
      }
    },
  });

  if (warnings.length > 0) {
    const warningMessages = warnings.map((w) =>
      interpolateTemplate(
        w.action?.message || `Warning: constraint ${w.condition} not met`,
        context,
      ),
    );
    session.data.values._constraint_warnings = warningMessages;
  } else {
    delete session.data.values._constraint_warnings;
  }

  return result;
}

/**
 * Check flat constraints while injecting a temporary structural checkpoint
 * context. Compiler-lowered BEFORE constraints key off these values so they
 * only activate at the intended execution boundary.
 */
export function checkFlatConstraintsAtCheckpoint(
  session: RuntimeSession,
  checkpoint: ConstraintCheckpoint,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): ConstraintCheckInfo | null {
  const hadKind = Object.prototype.hasOwnProperty.call(
    session.data.values,
    CONSTRAINT_CHECKPOINT_KIND_KEY,
  );
  const previousKind = session.data.values[CONSTRAINT_CHECKPOINT_KIND_KEY];
  const hadTarget = Object.prototype.hasOwnProperty.call(
    session.data.values,
    CONSTRAINT_CHECKPOINT_TARGET_KEY,
  );
  const previousTarget = session.data.values[CONSTRAINT_CHECKPOINT_TARGET_KEY];

  session.data.values[CONSTRAINT_CHECKPOINT_KIND_KEY] = checkpoint.kind;
  if (checkpoint.target) {
    session.data.values[CONSTRAINT_CHECKPOINT_TARGET_KEY] = checkpoint.target;
  } else {
    delete session.data.values[CONSTRAINT_CHECKPOINT_TARGET_KEY];
  }

  try {
    return checkFlatConstraints(session, onTraceEvent);
  } finally {
    if (hadKind) {
      session.data.values[CONSTRAINT_CHECKPOINT_KIND_KEY] = previousKind;
    } else {
      delete session.data.values[CONSTRAINT_CHECKPOINT_KIND_KEY];
    }

    if (hadTarget) {
      session.data.values[CONSTRAINT_CHECKPOINT_TARGET_KEY] = previousTarget;
    } else {
      delete session.data.values[CONSTRAINT_CHECKPOINT_TARGET_KEY];
    }
  }
}

/**
 * Check all constraints (guardrails + constraints).
 * Delegates to checkConstraintsCore from @abl/compiler.
 * Returns null if all pass, or a ConstraintCheckInfo if any fail.
 */
export function checkConstraints(
  session: RuntimeSession,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): ConstraintCheckInfo | null {
  const ir = session.agentIR;
  const profileConstraints = session._effectiveConfig?.additionalConstraints ?? [];
  // No IR constraints and no profile constraints — nothing to check
  if (!ir?.constraints && profileConstraints.length === 0) {
    return null;
  }

  // Input-kind guardrails are evaluated by the pipeline (flow-step-executor
  // / reasoning-executor) before this function runs — re-evaluating them
  // here would double-fire trace events and waste CEL cycles. Other kinds
  // (tool_input, tool_output, handoff, output) evaluate at their own
  // execution points, so they never reach this code path either. That
  // leaves `checkConstraints` responsible for non-guardrail constraints
  // only; guardrails are cleared out of its config.
  const baseConstraints = ir?.constraints ?? { constraints: [], guardrails: [] };
  const constraintConfig = {
    ...baseConstraints,
    constraints: [...(baseConstraints.constraints ?? []), ...profileConstraints],
    guardrails: [],
  };

  const context = session.data.values;
  const warnings: ConstraintCheckInfo[] = [];

  const result = checkConstraintsCore(constraintConfig, context, {
    evaluateCondition: evaluateConditionDual,
    onCheck: (info) => {
      // Collect warnings (non-blocking constraint failures)
      if (!info.passed && info.severity === 'warning') {
        warnings.push(info);
      }

      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'constraint_check', {
        outcome: info.passed ? 'pass' : (info.action?.type ?? 'fail'),
        condition: info.condition,
        matched: info.passed,
        field: info.name,
        violation: info.passed ? undefined : info.severity,
      });

      if (onTraceEvent) {
        // Extract variable names from condition for context display
        const varMatches = info.condition.match(/\b([a-z_][a-z0-9_]*)\b/gi) || [];
        const relevantContext: Record<string, unknown> = {};
        for (const varName of varMatches) {
          if (context[varName] !== undefined) {
            relevantContext[varName] = context[varName];
          }
        }
        onTraceEvent({
          type: info.guardSkipped
            ? 'constraint_guard_skipped'
            : info.severity === 'warning' && !info.passed
              ? 'constraint_warning'
              : 'constraint_check',
          data: {
            agentName: session.agentName,
            constraintType: info.type,
            severity: info.severity || 'error',
            name: info.name,
            condition: info.condition,
            passed: info.passed,
            guardSkipped: info.guardSkipped,
            relevantContext,
            onFail: info.action,
          },
        });
      }
    },
  });

  // Store warning messages on the session so the LLM can inform the user
  if (warnings.length > 0) {
    const warningMessages = warnings.map((w) =>
      interpolateTemplate(
        w.action?.message || `Warning: constraint ${w.condition} not met`,
        context,
      ),
    );
    session.data.values._constraint_warnings = warningMessages;
  } else {
    delete session.data.values._constraint_warnings;
  }

  return result;
}

/**
 * Examine a constraint violation and determine if it has a non-terminal
 * control flow action. Returns a ConstraintControlFlowDirective for
 * collect_field, goto_step, or retry_step actions. Returns null for
 * terminal actions (respond, escalate, handoff, block, redact).
 */
export function interpretConstraintControlFlow(
  session: RuntimeSession,
  violation: ConstraintCheckInfo,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): ConstraintControlFlowDirective | null {
  const action = violation.action;
  const verbosity = session.traceVerbosity ?? 'standard';
  const emitDecisionTrace = onTraceEvent && (verbosity === 'verbose' || verbosity === 'debug');

  switch (action.type) {
    case 'collect_field': {
      if (emitDecisionTrace) {
        onTraceEvent!({
          type: 'constraint_directive',
          data: {
            directiveType: 'control_flow',
            directiveAction: 'collect_field',
            constraintName: violation.name,
            condition: violation.condition,
            fields: action.collect_fields || [],
          },
        });
      }
      return {
        type: 'collect_field',
        fields: action.collect_fields || [],
        thenAction: action.then_action || 'continue',
        thenStep: action.then_step,
        respond: action.message,
        constraintCondition: violation.condition,
      };
    }

    case 'goto_step': {
      // Check backtrack limit
      const stepName = action.then_step ?? action.target ?? '';
      const counts = session.backtrackCounts || {};
      const currentCount = counts[stepName] || 0;

      if (currentCount >= MAX_BACKTRACKS_PER_STEP) {
        // Exceeded max backtracks - return null to fall through to terminal handling
        if (emitDecisionTrace) {
          onTraceEvent!({
            type: 'constraint_backtrack_limit',
            data: {
              fallbackAction: 'escalate',
              originalAction: 'goto_step',
              targetStep: stepName,
              count: currentCount,
              limit: MAX_BACKTRACKS_PER_STEP,
              constraintName: violation.name,
              condition: violation.condition,
            },
          });
        }
        return null;
      }

      if (emitDecisionTrace) {
        onTraceEvent!({
          type: 'constraint_backtrack',
          data: {
            count: currentCount,
            limit: MAX_BACKTRACKS_PER_STEP,
            targetStep: stepName,
            constraintName: violation.name,
            condition: violation.condition,
          },
        });
        onTraceEvent!({
          type: 'constraint_directive',
          data: {
            directiveType: 'control_flow',
            directiveAction: 'goto_step',
            constraintName: violation.name,
            condition: violation.condition,
            targetStep: stepName,
          },
        });
      }

      return {
        type: 'goto_step',
        targetStep: stepName,
        respond: action.message,
        constraintCondition: violation.condition,
      };
    }

    case 'retry_step': {
      if (emitDecisionTrace) {
        onTraceEvent!({
          type: 'constraint_directive',
          data: {
            directiveType: 'control_flow',
            directiveAction: 'retry_step',
            constraintName: violation.name,
            condition: violation.condition,
          },
        });
      }
      return {
        type: 'retry_step',
        respond: action.message,
        constraintCondition: violation.condition,
      };
    }

    case 'respond': {
      if (emitDecisionTrace) {
        onTraceEvent!({
          type: 'constraint_directive',
          data: {
            directiveType: 'terminal',
            directiveAction: 'respond',
            constraintName: violation.name,
            condition: violation.condition,
          },
        });
      }
      return null;
    }

    default:
      // Terminal actions (escalate, handoff, block, redact)
      return null;
  }
}

/**
 * Shared trace emission for constraint failures.
 */
function emitConstraintViolationTrace(
  session: RuntimeSession,
  violation: ConstraintCheckInfo,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): void {
  if (onTraceEvent) {
    onTraceEvent({
      type: 'constraint_violation',
      data: {
        agentName: session.agentName,
        stepName: session.currentFlowStep,
        constraintType: violation.type,
        name: violation.name,
        condition: violation.condition,
        action: violation.action,
        relevantContext: session.data.values,
      },
    });
  }
}

function applyConstraintResponseSideEffects(
  session: RuntimeSession,
  result: ExecutionResult,
  onChunk?: (chunk: string) => void,
): ExecutionResult {
  return emitProtectedExecutionResult(session, result, onChunk).result;
}

function resolveConstraintViolationResult(
  session: RuntimeSession,
  violation: ConstraintCheckInfo,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): { result: ExecutionResult; shouldEmitResponse: boolean } {
  const context = session.data.values;

  emitConstraintViolationTrace(session, violation, onTraceEvent);

  const action = violation.action;

  switch (action.type) {
    case 'respond': {
      const message = interpolateTemplate(
        action.message ||
          session.promptOverrides?.['message.constraint_respond'] ||
          promptTemplateLoader.getMessage('constraint_respond'),
        context,
      );
      return {
        result: {
          response: message,
          action: { type: 'constraint_blocked', constraint: violation.condition },
        },
        shouldEmitResponse: true,
      };
    }

    case 'escalate': {
      session.isEscalated = true;
      session.escalationReason = action.reason || `Constraint violation: ${violation.condition}`;
      const message = `🔔 **Escalated to Human Agent**\nReason: ${session.escalationReason}`;

      if (onTraceEvent) {
        onTraceEvent({
          type: 'escalation',
          data: {
            reason: session.escalationReason,
            priority: 'high',
            agent: session.agentName,
            source: 'constraint_violation',
            constraint: violation.condition,
          },
        });
      }

      return {
        result: {
          response: message,
          action: { type: 'escalate', reason: session.escalationReason },
        },
        shouldEmitResponse: true,
      };
    }

    case 'handoff': {
      // Trigger handoff to specified target
      const target = action.target || 'supervisor';
      return {
        result: {
          response: `Routing to ${target} for assistance.`,
          action: { type: 'handoff', target },
        },
        shouldEmitResponse: false,
      };
    }

    case 'collect_field': {
      // Non-terminal: handled by interpretConstraintControlFlow()
      // If we get here, it means the caller didn't check for control flow first
      const message =
        action.message ||
        session.promptOverrides?.['message.constraint_collect'] ||
        promptTemplateLoader.getMessage('constraint_collect');
      return {
        result: {
          response: message,
          action: { type: 'constraint_collect', fields: action.collect_fields || [] },
        },
        shouldEmitResponse: true,
      };
    }

    case 'goto_step': {
      const target = action.then_step ?? action.target ?? '';
      const message =
        action.message ||
        session.promptOverrides?.['message.constraint_backtrack'] ||
        promptTemplateLoader.getMessage('constraint_backtrack');
      return {
        result: {
          response: message,
          action: { type: 'goto_step', target },
        },
        shouldEmitResponse: true,
      };
    }

    case 'retry_step': {
      const message =
        action.message ||
        session.promptOverrides?.['message.constraint_retry'] ||
        promptTemplateLoader.getMessage('constraint_retry');
      return {
        result: {
          response: message,
          action: { type: 'retry_step' },
        },
        shouldEmitResponse: true,
      };
    }

    case 'redact': {
      const message =
        action.message ||
        session.promptOverrides?.['message.constraint_redact'] ||
        promptTemplateLoader.getMessage('constraint_redact');
      return {
        result: {
          response: message,
          action: { type: 'redacted', reason: violation.condition },
        },
        shouldEmitResponse: true,
      };
    }

    case 'block':
    default: {
      if (action.type !== 'block') {
        log.warn('Unknown constraint violation action type, treating as block', {
          actionType: action.type,
          agentName: session.agentName,
        });
      }
      const localizedBlockMessage = resolveLocalizedAgentMessageWithMetadata({
        session,
        messageKey: 'constraint_blocked',
        fallbackMessage:
          session.agentIR?.messages?.constraint_blocked || DEFAULT_MESSAGES.constraint_blocked,
      });
      const message = action.message || action.reason || localizedBlockMessage.text;
      return {
        result: {
          response: message,
          localization:
            action.message || action.reason ? undefined : localizedBlockMessage.localization,
          action: { type: 'blocked', reason: action.reason || violation.condition },
        },
        shouldEmitResponse: true,
      };
    }
  }
}

/**
 * Handle a constraint violation - returns the action to take
 */
export function handleConstraintViolation(
  session: RuntimeSession,
  violation: ConstraintCheckInfo,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): ExecutionResult {
  let { result, shouldEmitResponse } = resolveConstraintViolationResult(
    session,
    violation,
    onTraceEvent,
  );

  if (shouldEmitResponse) {
    result = applyConstraintResponseSideEffects(session, result, onChunk);
  }

  return result;
}

export async function executeConstraintViolation(
  session: RuntimeSession,
  violation: ConstraintCheckInfo,
  options: {
    onChunk?: (chunk: string) => void;
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    executeHandoff?: (
      input: Record<string, unknown>,
      onChunk?: (chunk: string) => void,
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    ) => Promise<HandoffExecutionResult>;
    applyResponseSideEffects?: boolean;
  } = {},
): Promise<ExecutionResult> {
  const { onChunk, onTraceEvent, executeHandoff, applyResponseSideEffects = true } = options;

  if (violation.action.type === 'handoff' && executeHandoff) {
    emitConstraintViolationTrace(session, violation, onTraceEvent);

    // The compiler may encode "HANDOFF AgentName reason text" as a single target string.
    // Split the first word as the agent name and the rest as the message when no explicit
    // message is provided.
    let target = violation.action.target || 'supervisor';
    let handoffMessage = violation.action.message
      ? interpolateTemplate(violation.action.message, session.data.values)
      : undefined;

    if (!handoffMessage && target.includes(' ')) {
      const firstSpace = target.indexOf(' ');
      const parsedTarget = target.slice(0, firstSpace);
      const parsedMessage = target.slice(firstSpace + 1).trim();
      target = parsedTarget;
      if (parsedMessage) {
        handoffMessage = interpolateTemplate(parsedMessage, session.data.values);
      }
    }
    const handoffResult = await executeHandoff(
      {
        target,
        ...(handoffMessage ? { message: handoffMessage, reason: handoffMessage } : {}),
        context: { ...session.data.values },
      },
      onChunk,
      onTraceEvent,
    );

    if (handoffResult.success) {
      return buildHandoffExecutionResult(session, target, handoffResult);
    }

    log.warn('Constraint handoff execution failed', {
      agentName: session.agentName,
      condition: violation.condition,
      target,
      error: handoffResult.error,
    });

    const failureResult: ExecutionResult = {
      response: handoffResult.error || `Unable to route to ${target} right now.`,
      action: {
        type: 'blocked',
        reason: handoffResult.error || `Constraint handoff failed for ${target}`,
      },
    };

    if (applyResponseSideEffects) {
      return applyConstraintResponseSideEffects(session, failureResult, onChunk);
    }

    return failureResult;
  }

  let { result, shouldEmitResponse } = resolveConstraintViolationResult(
    session,
    violation,
    onTraceEvent,
  );

  if (applyResponseSideEffects && shouldEmitResponse) {
    result = applyConstraintResponseSideEffects(session, result, onChunk);
  }

  return result;
}
