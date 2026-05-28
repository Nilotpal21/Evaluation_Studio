/**
 * Aggregate — Restate activity service that aggregates values from previous node outputs.
 *
 * Supports operations: count, sum, avg, min, max, collect.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';

type AggOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'collect';

interface AggOperation {
  field: string;
  op: AggOp;
  as: string;
}

export const aggregateService = restate.service({
  name: 'AggregateService',
  handlers: {
    execute: async (_ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { config, previousSteps, pipelineInput } = input;

      const sourcePath = config.source as string;
      const operations = config.operations as AggOperation[];

      if (!sourcePath || !operations || !Array.isArray(operations)) {
        return {
          status: 'fail',
          data: { error: "aggregate requires 'source' and 'operations' (array) in config" },
        };
      }

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

      const result: Record<string, unknown> = {};

      for (const op of operations) {
        const values = sourceArray.map((item: any) => resolvePath(op.field, item));
        result[op.as] = computeAggregation(op.op, values);
      }

      return {
        status: 'success',
        data: { ...result, sourceCount: sourceArray.length },
      };
    },
  },
});

function computeAggregation(op: AggOp, values: unknown[]): unknown {
  const nums = values.filter((v): v is number => typeof v === 'number');

  switch (op) {
    case 'count':
      return values.length;
    case 'sum':
      return nums.reduce((acc, v) => acc + v, 0);
    case 'avg':
      return nums.length > 0 ? nums.reduce((acc, v) => acc + v, 0) / nums.length : 0;
    case 'min':
      return nums.length > 0 ? Math.min(...nums) : null;
    case 'max':
      return nums.length > 0 ? Math.max(...nums) : null;
    case 'collect':
      return values;
    default:
      return null;
  }
}

function resolvePath(path: string, obj: any): any {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

export type AggregateService = typeof aggregateService;
