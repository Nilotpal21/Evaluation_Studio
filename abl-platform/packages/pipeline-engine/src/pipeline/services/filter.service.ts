/**
 * Filter — Restate activity service that filters arrays from previous node outputs.
 *
 * Evaluates a simple expression per item to include/exclude from the result.
 */
import * as restate from '@restatedev/restate-sdk';
import { splitTopLevelComparison } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

export const filterService = restate.service({
  name: 'FilterService',
  handlers: {
    execute: async (_ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { config, previousSteps, pipelineInput } = input;

      const sourcePath = config.source as string;
      const expression = config.expression as string;

      if (!sourcePath || !expression) {
        return {
          status: 'fail',
          data: { error: "filter requires 'source' and 'expression' in config" },
        };
      }

      // Resolve source array from context
      const context: Record<string, any> = {
        input: pipelineInput,
        nodeOutputs: previousSteps,
      };

      const sourceArray = resolvePath(sourcePath, context);
      if (!Array.isArray(sourceArray)) {
        return {
          status: 'fail',
          data: {
            error: `Source path '${sourcePath}' did not resolve to an array`,
            resolvedType: typeof sourceArray,
          },
        };
      }

      // Filter items using expression
      const filtered = sourceArray.filter((item: any) => {
        return evaluateFilterExpression(expression, item);
      });

      return {
        status: 'success',
        data: { items: filtered, count: filtered.length, originalCount: sourceArray.length },
      };
    },
  },
});

function resolvePath(path: string, obj: Record<string, any>): unknown {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function evaluateFilterExpression(expression: string, item: any): boolean {
  try {
    // Support simple comparisons: item.field == 'value', item.field > 0, etc.
    const trimmed = expression.trim();

    const comparison = splitTopLevelComparison(trimmed);
    if (comparison) {
      const left = resolveExprValue(comparison.leftExpr, item);
      const right = resolveExprValue(comparison.rightExpr, item);

      switch (comparison.op) {
        case '==':
          return left == right;
        case '!=':
          return left != right;
        case '>':
          return (left as number) > (right as number);
        case '<':
          return (left as number) < (right as number);
        case '>=':
          return (left as number) >= (right as number);
        case '<=':
          return (left as number) <= (right as number);
      }
    }

    // Truthy check
    return Boolean(resolveExprValue(trimmed, item));
  } catch {
    return false;
  }
}

function resolveExprValue(token: string, item: any): unknown {
  const t = token.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;

  // Dot-path resolution — 'item.role' resolves to item.role
  const parts = t.split('.');
  let current: any = parts[0] === 'item' ? item : { item };
  const startIdx = parts[0] === 'item' ? 1 : 0;
  for (let i = startIdx; i < parts.length; i++) {
    if (current == null) return undefined;
    current = current[parts[i]];
  }
  return current;
}

export type FilterService = typeof filterService;
