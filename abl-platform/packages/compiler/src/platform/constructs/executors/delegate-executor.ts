/**
 * Delegate Executor
 *
 * Pure decision layer for delegate validation. Evaluates delegate preconditions
 * (self-delegation prevention, cycle detection, depth limits, WHEN condition
 * evaluation, input mapping) without side effects.
 *
 * The runtime is responsible for thread management, LLM wiring, timeout
 * enforcement, and recursive executeMessage calls. This executor only answers:
 * "Should this delegation proceed, what input should be passed, and if not, why?"
 *
 * This is the strangler-pattern replacement for the inline validation logic
 * in RoutingExecutor.handleDelegate() and executeDelegate(). During shadow mode
 * the runtime calls both this executor and the old path, compares decisions,
 * and logs mismatches.
 */

import { evaluateConditionDual } from '../dual-evaluator.js';
import type { AgentIR } from '../../ir/schema.js';

// =============================================================================
// TYPES
// =============================================================================

/** Maximum delegate nesting depth to prevent runaway recursion */
const MAX_DELEGATE_DEPTH = 10;

/** Delegate configuration from the IR */
export interface DelegateConfig {
  agent: string;
  when?: string;
  purpose?: string;
  input?: Record<string, string>;
  returns?: Record<string, string>;
  timeout?: string;
  on_failure?: string;
  failure_message?: string;
  use_result?: string;
}

/** Minimal thread info needed for delegate validation */
export interface DelegateThreadInfo {
  agentName: string;
  dataValues: Record<string, unknown>;
}

/** Minimal session info needed for delegate validation */
export interface DelegateSessionInfo {
  delegateStack: string[];
  agentIR: AgentIR | null;
}

/** Input for delegate validation */
export interface DelegateInput {
  target: string;
  input?: Record<string, unknown>;
  message?: string;
}

/** Result of delegate validation */
export interface DelegateValidationResult {
  /** Whether the delegation should proceed */
  allowed: boolean;
  /** If disallowed, the reason */
  reason?: string;
  /** Resolved delegate config from IR (if found) */
  delegateConfig?: DelegateConfig;
  /** Mapped input values for the delegate */
  mappedInput?: Record<string, unknown>;
}

/** Result of mapping delegate input from config */
export interface DelegateMappedInput {
  values: Record<string, unknown>;
  /** Fields that resolved to undefined (dropped) */
  droppedFields: string[];
}

// =============================================================================
// DELEGATE EXECUTOR
// =============================================================================

export class DelegateExecutor {
  /**
   * Validate whether a delegation should proceed.
   *
   * Checks (in order):
   * 1. Self-delegation prevention
   * 2. Cycle detection (A -> B -> A)
   * 3. Depth limit
   * 4. WHEN condition (if defined in delegate config)
   * 5. Target agent exists in registry
   */
  validate(
    currentThread: DelegateThreadInfo,
    session: DelegateSessionInfo,
    input: DelegateInput,
    hasTargetInRegistry: boolean,
  ): DelegateValidationResult {
    const targetAgent = input.target;

    // Find matching delegate config from IR
    const delegateConfig = session.agentIR?.coordination?.delegates?.find(
      (d) => d.agent === targetAgent,
    ) as DelegateConfig | undefined;

    // 1. Prevent self-delegation
    if (currentThread.agentName === targetAgent) {
      return {
        allowed: false,
        reason: `Cannot delegate to yourself (${targetAgent}).`,
      };
    }

    // 2. Prevent delegate cycles (A -> B -> A)
    if (session.delegateStack.includes(targetAgent)) {
      return {
        allowed: false,
        reason: `Delegate cycle detected: ${[...session.delegateStack, targetAgent].join(' → ')}. Agent "${targetAgent}" is already in the active delegate chain.`,
      };
    }

    // 3. Prevent unbounded depth
    if (session.delegateStack.length >= MAX_DELEGATE_DEPTH) {
      return {
        allowed: false,
        reason: `Delegate depth limit reached (${MAX_DELEGATE_DEPTH}). Chain: ${session.delegateStack.join(' → ')}.`,
      };
    }

    // 4. Check WHEN condition if defined
    if (delegateConfig?.when) {
      const evalCtx = currentThread.dataValues;
      const conditionMet = evaluateConditionDual(delegateConfig.when, evalCtx);
      if (!conditionMet) {
        return {
          allowed: false,
          reason: `Delegate to ${targetAgent} blocked: WHEN condition not met (${delegateConfig.when}). Collect the required data first, then retry.`,
          delegateConfig,
        };
      }
    }

    // 5. Target agent must exist in registry
    if (!hasTargetInRegistry) {
      return {
        allowed: false,
        reason: `Agent not found: ${targetAgent}`,
        delegateConfig,
      };
    }

    // All checks passed — map input if config has INPUT mapping
    let mappedInput: Record<string, unknown> | undefined;
    if (!input.input && delegateConfig?.input) {
      const mapped = this.mapInput(delegateConfig.input, currentThread.dataValues);
      mappedInput = mapped.values;
    } else if (input.input && Object.keys(input.input).length > 0) {
      mappedInput = input.input;
    }

    return {
      allowed: true,
      delegateConfig,
      mappedInput,
    };
  }

  /**
   * Map INPUT fields from context to delegate input using dot-path resolution.
   */
  mapInput(
    inputMapping: Record<string, string>,
    context: Record<string, unknown>,
  ): DelegateMappedInput {
    const values: Record<string, unknown> = {};
    const droppedFields: string[] = [];

    for (const [targetKey, sourceExpr] of Object.entries(inputMapping)) {
      const value = resolveValuePath(sourceExpr, context);
      if (value !== undefined) {
        values[targetKey] = value;
      } else {
        droppedFields.push(targetKey);
      }
    }

    return { values, droppedFields };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Resolve a dot-path expression against a context object.
 * E.g., "user.name" resolves to context.user.name
 */
function resolveValuePath(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
