/**
 * Loop Step Executor
 *
 * Iterates over a collection resolved from the workflow context.
 * The actual per-item step execution and loop-local variable binding are
 * handled by the workflow handler. This executor only resolves the collection.
 */

import { resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';

export interface LoopStep {
  id: string;
  type: 'loop';
  config: {
    collection: string; // Expression resolving to an array, e.g. "{{trigger.payload.items}}"
    itemVariable: string; // Variable name for current item in root context
    maxIterations?: number; // Safety limit (default 1000)
    body?: string[]; // Step IDs to execute per iteration (set by canvas-to-steps)
    bodyInDegreeMap?: Record<string, number>; // In-degree per body step for fan-in (branching+merging)
    bodyOutputMappings?: Array<{
      name: string;
      expression: string;
      type?: 'string' | 'number' | 'boolean' | 'json';
      description?: string;
    }>; // Output mappings configured on the loop body
    outputField?: string; // Optional field/variable for per-iteration End mapped outputs
    mode?: 'sequential' | 'parallel';
    onError?: 'continue' | 'terminate' | 'remove_failed';
    concurrencyLimit?: number;
    stagger?: number;
  };
}

export interface LoopResult {
  iterations: number;
}

const MAX_ITERATIONS_DEFAULT = 1000;

/**
 * Resolve the loop collection and prepare iteration metadata.
 */
export function resolveLoopItems(step: LoopStep, ctx: WorkflowContextData): unknown[] {
  const collection = resolveExpressionTyped(step.config.collection, ctx);
  if (!Array.isArray(collection)) {
    throw new Error(`Loop collection did not resolve to an array: ${step.config.collection}`);
  }

  const maxIterations = step.config.maxIterations ?? MAX_ITERATIONS_DEFAULT;
  return collection.slice(0, maxIterations);
}

export function executeLoop(step: LoopStep, ctx: WorkflowContextData): LoopResult {
  const items = resolveLoopItems(step, ctx);
  return { iterations: items.length };
}
