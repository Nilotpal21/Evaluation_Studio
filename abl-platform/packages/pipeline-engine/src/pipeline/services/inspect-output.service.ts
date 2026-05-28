import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

export const inspectOutputService = restate.service({
  name: 'InspectOutput',
  handlers: {
    execute: async (_ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const sourceStep = input.config.sourceStep;
      const fieldPath = input.config.fieldPath;

      if (typeof sourceStep !== 'string' || sourceStep.trim() === '') {
        return {
          status: 'fail',
          data: { error: "Inspect Output requires a 'sourceStep' config value" },
          durationMs: Date.now() - startTime,
        };
      }

      const trimmedSource = sourceStep.trim();
      const trimmedFieldPath = typeof fieldPath === 'string' ? fieldPath.trim() : '';
      const expression = trimmedFieldPath
        ? `steps.${trimmedSource}.output.${trimmedFieldPath}`
        : `steps.${trimmedSource}.output`;
      const value = resolveExpression(expression, input.previousSteps, input.pipelineInput);

      return {
        status: 'success',
        data: {
          sourceStep: trimmedSource,
          fieldPath: trimmedFieldPath || undefined,
          output: value,
        },
        durationMs: Date.now() - startTime,
      };
    },
  },
});

export type InspectOutputService = typeof inspectOutputService;
