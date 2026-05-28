/**
 * RunLegacyWorkflow — Restate activity service that bridges to Temporal workflows.
 *
 * Takes a Temporal workflow name from the step config, starts it via the
 * Temporal client, waits for the result, and returns it as step output.
 * This allows existing Temporal-based system workflows to be composed into
 * Restate-orchestrated pipelines during the migration period.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';

export const runLegacyWorkflowService = restate.service({
  name: 'RunLegacyWorkflow',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const workflowName = input.config.workflow as string;

      if (!workflowName) {
        return {
          status: 'fail',
          data: {
            error: "RunLegacyWorkflow requires 'workflow' in config",
          },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const result = await ctx.run('run-legacy-workflow', async () => {
          // TODO: Call Temporal client to start and wait for the legacy workflow
          // const temporalClient = getTemporalClient();
          // const handle = await temporalClient.workflow.start(workflowName, {
          //   taskQueue: input.config.taskQueue ?? getDefaultTaskQueue(workflowName),
          //   args: [{ tenantId, projectId, sessionId, ...input.pipelineInput }],
          // });
          // return handle.result();
          ctx.console.log(`[RunLegacyWorkflow] Running Temporal workflow: ${workflowName}`);

          // Stub: return placeholder result
          return {
            data: { workflow: workflowName, status: 'completed' },
          };
        });

        return {
          status: 'success',
          data: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type RunLegacyWorkflowService = typeof runLegacyWorkflowService;
