/**
 * PipelineScheduler -- Restate virtual object for cron-based pipeline execution.
 *
 * Keyed by pipeline ID, providing single-writer guarantee that prevents
 * duplicate schedule instances for the same pipeline.
 *
 * Uses Restate's durable sleep + loop pattern:
 *   1. Compute next cron execution time
 *   2. Sleep until that time (durable -- survives crashes)
 *   3. Fire-and-forget trigger to PipelineTrigger.triggerManual
 *   4. Loop back to step 1 (unless stopped)
 *
 * The `stop` handler sets the "active" flag to false. On next wake-up,
 * the loop exits cleanly.
 *
 * The `getScheduleStatus` shared handler allows concurrent read access
 * without blocking the exclusive start/stop handlers.
 */
import * as restate from '@restatedev/restate-sdk';
import { pipelineTrigger } from './pipeline-trigger.service.js';
import { getNextCronTime } from '../utils/cron.js';

export const pipelineScheduler = restate.object({
  name: 'PipelineScheduler',
  handlers: {
    /**
     * Start a cron schedule for a pipeline.
     * Uses Restate durable sleep + self-invocation pattern.
     * Keyed by pipeline ID -- single-writer guarantee prevents duplicates.
     */
    start: async (
      ctx: restate.ObjectContext,
      input: {
        pipelineId: string;
        tenantId: string;
        projectId: string;
        schedule: string;
        triggerId?: string;
      },
    ): Promise<void> => {
      ctx.set('active', true);
      ctx.set('schedule', input.schedule);
      ctx.set('pipelineId', input.pipelineId);
      ctx.set('tenantId', input.tenantId);

      while ((await ctx.get<boolean>('active')) === true) {
        const now = Date.now();
        const nextRun = getNextCronTime(input.schedule, now);
        const delay = nextRun - now;

        if (delay > 0) {
          await ctx.sleep(delay);
        }

        // Check if still active after waking up
        if ((await ctx.get<boolean>('active')) !== true) {
          break;
        }

        // Trigger the pipeline (fire-and-forget via send client)
        ctx.serviceSendClient(pipelineTrigger).triggerManual({
          pipelineId: input.pipelineId,
          tenantId: input.tenantId,
          projectId: input.projectId,
          triggeredBy: 'scheduler',
          triggerId: input.triggerId ?? 'default',
          data: { scheduledAt: new Date().toISOString() },
        });
      }
    },

    /**
     * Stop a running schedule.
     */
    stop: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.set('active', false);
    },

    /**
     * Query schedule status (shared handler -- doesn't block main handler).
     */
    getScheduleStatus: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => ({
      active: (await ctx.get<boolean>('active')) ?? false,
      schedule: await ctx.get<string>('schedule'),
      pipelineId: await ctx.get<string>('pipelineId'),
    })),
  },
});

/** Export the type for use by other Restate services or the client. */
export type PipelineSchedulerObject = typeof pipelineScheduler;
