/**
 * SubPipeline — Restate activity service that executes another pipeline as a node.
 *
 * Starts a nested PipelineRun workflow and returns its result.
 * Requires the PipelineDefinitionModel for loading the sub-pipeline definition.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineStepContext, StepOutput } from '../types.js';

const log = createLogger('sub-pipeline');
const MAX_SUB_PIPELINE_DEPTH = 3;

export const subPipelineService = restate.service({
  name: 'SubPipelineService',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { config, pipelineInput } = input;
      const pipelineId = config.pipelineId as string;

      if (!pipelineId) {
        return {
          status: 'fail',
          data: { error: "sub-pipeline requires 'pipelineId' in config" },
        };
      }

      // Depth guard
      const currentDepth = (pipelineInput._subPipelineDepth as number) ?? 0;
      if (currentDepth >= MAX_SUB_PIPELINE_DEPTH) {
        return {
          status: 'fail',
          data: {
            error: `Max sub-pipeline depth (${MAX_SUB_PIPELINE_DEPTH}) exceeded`,
            depth: currentDepth,
          },
        };
      }

      // Load sub-pipeline definition from MongoDB
      let subPipeline: Record<string, unknown> | null;
      try {
        const { PipelineDefinitionModel } =
          await import('../../schemas/pipeline-definition.schema.js');
        subPipeline = await ctx.run('load-sub-pipeline', async () => {
          return PipelineDefinitionModel.findOne({
            _id: pipelineId,
            tenantId: { $in: ['__platform__', pipelineInput.tenantId] },
            status: 'active',
          }).lean();
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Failed to load sub-pipeline', {
          pipelineId,
          sessionId: input.sessionId,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: `Failed to load sub-pipeline '${pipelineId}'` },
        };
      }

      if (!subPipeline) {
        return {
          status: 'fail',
          data: { error: `Sub-pipeline '${pipelineId}' not found or not active` },
        };
      }

      // Map input
      const subInput = config.inputMapping
        ? applyMapping(config.inputMapping as Record<string, string>, pipelineInput, input)
        : { ...pipelineInput, _subPipelineDepth: currentDepth + 1 };

      // Start nested PipelineRun workflow via Restate
      try {
        const { pipelineRun } = await import('../handlers/pipeline-run.workflow.js');
        const result = await ctx.serviceClient(pipelineRun as any).run({
          pipelineDefinition: subPipeline,
          pipelineInput: subInput,
        });

        return {
          status: (result as any).status === 'completed' ? 'success' : 'fail',
          data: (result as any).stepOutputs ?? {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Sub-pipeline execution failed', {
          pipelineId,
          sessionId: input.sessionId,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: 'Sub-pipeline execution failed' },
        };
      }
    },
  },
});

function applyMapping(
  mapping: Record<string, string>,
  pipelineInput: Record<string, any>,
  input: PipelineStepContext,
): Record<string, any> {
  const result: Record<string, any> = {
    tenantId: pipelineInput.tenantId,
    projectId: pipelineInput.projectId,
    _subPipelineDepth: ((pipelineInput._subPipelineDepth as number) ?? 0) + 1,
  };

  for (const [targetKey, sourcePath] of Object.entries(mapping)) {
    const parts = sourcePath.split('.');
    let current: any = { input: pipelineInput, nodeOutputs: input.previousSteps };
    for (const part of parts) {
      if (current == null) break;
      current = current[part];
    }
    result[targetKey] = current;
  }

  return result;
}

export type SubPipelineService = typeof subPipelineService;
