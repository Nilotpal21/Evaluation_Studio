/**
 * TransformData — Restate activity service for reshaping pipeline data.
 *
 * Takes a mapping config where each key is an output field name and each value
 * is a dot-path expression (e.g. "steps.eval.output.scores.toxicity").
 * Resolves all expressions against previous step outputs and returns the
 * transformed result.
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

export const transformService = restate.service({
  name: 'TransformData',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const mapping = input.config.mapping as Record<string, string>;

      if (!mapping || typeof mapping !== 'object') {
        return {
          status: 'fail',
          data: { error: "Transform requires a 'mapping' config object" },
          durationMs: Date.now() - startTime,
        };
      }

      const result: Record<string, unknown> = {};

      for (const [outputKey, expression] of Object.entries(mapping)) {
        result[outputKey] = resolveExpression(expression, input.previousSteps, input.pipelineInput);
      }

      return {
        status: 'success',
        data: result as Record<string, any>,
        durationMs: Date.now() - startTime,
      };
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type TransformService = typeof transformService;
