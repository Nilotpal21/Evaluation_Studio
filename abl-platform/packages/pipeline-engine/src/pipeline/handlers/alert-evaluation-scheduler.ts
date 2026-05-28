/**
 * AlertEvaluationScheduler — Restate virtual object for cron-based alert evaluation.
 *
 * Keyed by tenantId, providing single-writer guarantee per tenant.
 * Separate from PipelineScheduler (keyed by pipeline ID) — alert evaluation
 * cross-cuts all pipelines for a tenant.
 *
 * Uses Restate's durable sleep + loop pattern:
 *   1. Sleep for the configured interval (default 5 minutes)
 *   2. Load projects with enabled alert rules from MongoDB
 *   3. Fire alert evaluation per project (fire-and-forget)
 *   4. Loop back to step 1 (unless stopped)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { alertEvaluatorService } from '../services/alert-evaluator.service.js';

const log = createLogger('alert-evaluation-scheduler');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const alertEvaluationScheduler = restate.object({
  name: 'AlertEvaluationScheduler',
  handlers: {
    /**
     * Start alert evaluation for a tenant on a cron interval.
     * Keyed by tenantId — single-writer guarantee prevents duplicates.
     */
    start: async (
      ctx: restate.ObjectContext,
      input: {
        tenantId: string;
        intervalMs?: number;
      },
    ): Promise<void> => {
      // Idempotent: if already running, skip (Restate serializes calls per key)
      if ((await ctx.get<boolean>('active')) === true) {
        log.info('Alert evaluation scheduler already active, skipping start', {
          tenantId: input.tenantId,
        });
        return;
      }

      const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;

      ctx.set('active', true);
      ctx.set('tenantId', input.tenantId);
      ctx.set('intervalMs', intervalMs);

      log.info('Alert evaluation scheduler started', {
        tenantId: input.tenantId,
        intervalMs,
      });

      while ((await ctx.get<boolean>('active')) === true) {
        await ctx.sleep(intervalMs);

        // Check if still active after waking up
        if ((await ctx.get<boolean>('active')) !== true) {
          break;
        }

        // Load distinct projectIds with enabled alert rules for this tenant
        const projectIds = await ctx.run('load-projects-with-rules', async () => {
          try {
            const { AlertRuleModel } = await import('../../schemas/alert-rule.schema.js');
            const ids = await AlertRuleModel.distinct('projectId', {
              tenantId: input.tenantId,
              enabled: true,
            });
            return ids as string[];
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.warn('Failed to load projects with alert rules', {
              tenantId: input.tenantId,
              error: msg,
            });
            return [] as string[];
          }
        });

        if (projectIds.length === 0) {
          log.debug('No projects with enabled alert rules', {
            tenantId: input.tenantId,
          });
          continue;
        }

        // Fire alert evaluation per project (fire-and-forget)
        for (const projectId of projectIds) {
          ctx.serviceSendClient(alertEvaluatorService).execute({
            config: { tenantId: input.tenantId, projectId },
          });
        }

        log.info('Alert evaluation dispatched', {
          tenantId: input.tenantId,
          projectCount: projectIds.length,
        });
      }

      log.info('Alert evaluation scheduler stopped', {
        tenantId: input.tenantId,
      });
    },

    /**
     * Stop alert evaluation for this tenant.
     */
    stop: async (ctx: restate.ObjectContext): Promise<void> => {
      const tenantId = await ctx.get<string>('tenantId');
      ctx.set('active', false);
      log.info('Alert evaluation scheduler stopping', { tenantId });
    },

    /**
     * Query scheduler status (shared handler — doesn't block main handler).
     */
    getStatus: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => ({
      active: (await ctx.get<boolean>('active')) ?? false,
      tenantId: (await ctx.get<string>('tenantId')) ?? null,
      intervalMs: (await ctx.get<number>('intervalMs')) ?? DEFAULT_INTERVAL_MS,
    })),
  },
});

export type AlertEvaluationScheduler = typeof alertEvaluationScheduler;
