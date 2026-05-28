/**
 * EvalRetentionScheduler — Restate-backed nightly eval run cleanup.
 *
 * This intentionally uses a Restate virtual object durable sleep loop instead
 * of an app/runtime timer so only one scheduler key owns cleanup state and the
 * next wakeup survives process restarts.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { runEvalRetentionCleanup } from '../services/eval/eval-retention-cleanup.js';

const log = createLogger('eval-retention-scheduler');

function nextNightlyDelayMs(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(2, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export const evalRetentionSweepService = restate.service({
  name: 'EvalRetentionSweep',
  handlers: {
    runOnce: async () => runEvalRetentionCleanup(),
  },
});

export const evalRetentionScheduler = restate.object({
  name: 'EvalRetentionScheduler',
  handlers: {
    start: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.set('active', true);

      while ((await ctx.get<boolean>('active')) === true) {
        await ctx.sleep(nextNightlyDelayMs());
        if ((await ctx.get<boolean>('active')) !== true) {
          break;
        }

        const summary = await ctx.serviceClient(evalRetentionSweepService).runOnce();
        log.info('Eval retention cleanup completed', {
          tenantsScanned: summary.tenantsScanned,
          runsArchived: summary.runsArchived,
          runsDeleted: summary.runsDeleted,
          errorCount: summary.errors.length,
        });
      }
    },

    stop: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.set('active', false);
    },

    getScheduleStatus: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => ({
      active: (await ctx.get<boolean>('active')) ?? false,
    })),
  },
});

export type EvalRetentionSchedulerObject = typeof evalRetentionScheduler;
