/**
 * Transform Step Executor
 *
 * Evaluates an expression and stores the result in a named context variable.
 * Used to reshape data between steps (e.g. extract a nested field, combine values).
 */

import { resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';

export interface TransformStep {
  id: string;
  type: 'transform';
  config: {
    inputExpression: string; // Expression to evaluate
    outputVariable: string; // Variable name to store result in root context
  };
}

export interface TransformResult {
  value: unknown;
  outputVariable: string;
}

/**
 * Resolve the input expression and return the named output variable.
 *
 * Replay safety: we intentionally do NOT write to the context here. The step
 * runs inside `restateCtx.run()` in `dispatchWithRetry`, so a direct mutation
 * would not be journaled — on replay Restate returns the journaled
 * `TransformResult` but does not re-execute this function. `workflowStep`
 * re-applies `{ outputVariable, value }` into the root context once ctx.run
 * resolves (see workflow-handler.ts step-completion block), which covers
 * both first-run and replay with a single authoritative write. Mutating here
 * was the source of a double-write on first run.
 */
export function executeTransform(step: TransformStep, ctx: WorkflowContextData): TransformResult {
  const value = resolveExpressionTyped(step.config.inputExpression, ctx);
  return { value, outputVariable: step.config.outputVariable };
}
