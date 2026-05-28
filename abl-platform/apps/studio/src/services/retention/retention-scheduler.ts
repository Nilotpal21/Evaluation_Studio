/**
 * Retention Scheduler
 *
 * Orchestrates scheduled retention enforcement:
 * - Daily sweep at 02:00 UTC: archive + delete expired data per tenant
 * - GDPR SLA check every 6 hours: escalate overdue deletion requests
 *
 * Uses BullMQ when Redis is available, falls back to setInterval.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { SchedulerStrategy } from '../scheduler/scheduler-types';
import { BullMQScheduler } from '../scheduler/bullmq-scheduler';
import { IntervalScheduler } from '../scheduler/interval-scheduler';
import { MongoRetentionStore } from './mongo-retention-store';
import { MongoGDPRStore } from './mongo-gdpr-store';
import { RetentionService, GDPRDeletionService, type RetentionPolicy } from './retention-service';
import { getTenantConfigService } from '../tenant-config';
import { findOrganizations } from '@/repos/org-repo';
import {
  findSubscription,
  findDeletionRequests,
  updateDeletionRequest,
} from '@/repos/compliance-repo';
// Redis is optional in studio — retention uses interval fallback
function isRedisAvailable(): boolean {
  return false;
}
function getRedisClient(): any {
  return null;
}
function getConfig(): any {
  return {
    retention: { enabled: process.env.RETENTION_ENABLED === 'true' },
    scheduler: { enabled: process.env.RETENTION_ENABLED === 'true' },
  };
}
import { logAuditEvent, AuditActions } from '../audit-service';
// Tenant context stub for Next.js (retention runs as a background task)
function runWithTenantContext(ctx: any, fn: () => Promise<any>): Promise<any> {
  return fn();
}

const log = createLogger('retention-scheduler');

let scheduler: SchedulerStrategy | null = null;

/**
 * Optional event retention handler.
 * When registered, the daily sweep invokes it per tenant to purge/scrub
 * events in the eventstore (ClickHouse / memory) alongside session + message retention.
 */
export type EventRetentionHandler = (
  tenantId: string,
  policy: Pick<RetentionPolicy, 'events'>,
) => Promise<{ deleted: number; scrubbed: number }>;

let eventRetentionHandler: EventRetentionHandler | null = null;

/**
 * Register an event retention handler to be called during the daily sweep.
 * Typically wired at startup by the host app that owns the eventstore.
 */
export function registerEventRetentionHandler(handler: EventRetentionHandler): void {
  eventRetentionHandler = handler;
}

/**
 * Initialize and start the retention scheduler.
 */
export async function startRetentionScheduler(): Promise<void> {
  const config = getConfig();

  if (!config.scheduler?.enabled) {
    log.info('Scheduler disabled by config');
    return;
  }

  // Choose scheduler strategy
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const redisUrl = config.redis?.url || 'redis://localhost:6379';
    scheduler = new BullMQScheduler(redisUrl);
    log.info('Using BullMQ scheduler (Redis available)');
  } else {
    scheduler = new IntervalScheduler();
    log.info('Using interval scheduler (Redis unavailable)');
  }

  const retentionCron = config.scheduler?.retentionCron || '0 2 * * *';
  const gdprCheckCron = config.scheduler?.gdprCheckCron || '0 */6 * * *';

  // Register daily retention sweep
  await scheduler.register({
    name: 'retention:daily-sweep',
    cron: retentionCron,
    handler: executeDailySweep,
    retries: 3,
    backoff: 10_000,
    timeout: 600_000, // 10 minutes
  });

  // Register GDPR SLA check
  await scheduler.register({
    name: 'retention:gdpr-sla-check',
    cron: gdprCheckCron,
    handler: executeGDPRSLACheck,
    retries: 2,
    backoff: 5_000,
    timeout: 120_000, // 2 minutes
  });

  await scheduler.start();
}

/**
 * Stop the scheduler gracefully.
 */
export async function stopRetentionScheduler(): Promise<void> {
  if (scheduler) {
    await scheduler.stop();
    scheduler = null;
  }
}

/**
 * Daily retention sweep: iterate orgs -> load plan + compliance -> resolve -> archive -> delete.
 */
async function executeDailySweep(): Promise<void> {
  log.info('Starting daily sweep...');

  const retentionStore = new MongoRetentionStore();
  const retentionService = new RetentionService(retentionStore);
  const tenantConfigService = getTenantConfigService();

  // Get all organizations
  const orgs = await findOrganizations({});

  let totalArchived = 0;
  let totalDeleted = 0;
  let totalScrubbed = 0;
  let totalEventsDeleted = 0;
  let totalEventsScrubbed = 0;
  let totalErrors = 0;

  for (const org of orgs) {
    try {
      // Run each org's retention within its tenant context
      // so RLS and audit events are properly scoped
      await runWithTenantContext(
        { tenantId: org.id, userId: 'system:retention-scheduler', isSuperAdmin: false },
        async () => {
          const sub = await findSubscription({ organizationId: org.id });
          const plan = (sub?.planTier || 'FREE') as any;
          const policy = retentionService.getPolicy(org.id, plan);
          const retentionPlan = await retentionService.planRetention(org.id, policy);

          if (
            retentionPlan.sessionsToArchive.length === 0 &&
            retentionPlan.sessionsToDelete.length === 0 &&
            retentionPlan.tracesToPurge.length === 0 &&
            retentionPlan.piiFieldsToScrub.length === 0
          ) {
            // Still run event retention even if no session/message work
          } else {
            const report = await retentionService.executeRetention(retentionPlan);

            totalArchived += report.archived;
            totalDeleted += report.deleted;
            totalScrubbed += report.scrubbed;
            totalErrors += report.errors.length;

            if (report.errors.length > 0) {
              log.warn('Retention errors for org', {
                orgId: org.id,
                errorCount: report.errors.length,
                errors: report.errors,
              });
            }
          }

          // Run event retention (eventstore: ClickHouse / memory) if handler registered
          if (eventRetentionHandler && policy.events) {
            try {
              const eventResult = await eventRetentionHandler(org.id, {
                events: policy.events,
              });
              totalEventsDeleted += eventResult.deleted;
              totalEventsScrubbed += eventResult.scrubbed;
            } catch (eventErr: unknown) {
              totalErrors++;
              log.warn('Event retention failed for org', {
                orgId: org.id,
                error: eventErr instanceof Error ? eventErr.message : String(eventErr),
              });
            }
          }
        },
      );
    } catch (err: unknown) {
      totalErrors++;
      log.error('Retention failed for org', {
        orgId: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Daily sweep complete', {
    totalArchived,
    totalDeleted,
    totalScrubbed,
    totalEventsDeleted,
    totalEventsScrubbed,
    totalErrors,
  });

  await logAuditEvent({
    action:
      totalErrors > 0
        ? AuditActions.RETENTION_SWEEP_FAILED
        : AuditActions.RETENTION_SWEEP_COMPLETED,
    metadata: {
      totalArchived,
      totalDeleted,
      totalScrubbed,
      totalEventsDeleted,
      totalEventsScrubbed,
      totalErrors,
      orgCount: orgs.length,
    },
  });
}

/**
 * GDPR SLA check: find pending deletion requests approaching 30-day deadline.
 */
async function executeGDPRSLACheck(): Promise<void> {
  log.info('Starting GDPR SLA check...');

  const gdprStore = new MongoGDPRStore();
  const gdprService = new GDPRDeletionService(gdprStore);

  // Find pending deletion requests
  const pendingRequests = await findDeletionRequests({
    status: { in: ['pending', 'in_progress'] },
  });

  const now = new Date();
  let processed = 0;
  let escalated = 0;

  for (const request of pendingRequests) {
    const daysUntilDeadline =
      (request.slaDeadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    // Auto-process requests that are pending and approaching deadline
    if (request.status === 'pending' && daysUntilDeadline < 7) {
      try {
        const result = await gdprService.processDeletionRequest({
          id: request.id,
          tenantId: request.tenantId,
          requestedBy: request.requestedBy,
          subjectId: request.subjectId,
          scope: request.scope as any,
          status: request.status as any,
          createdAt: request.createdAt,
          slaDeadline: request.slaDeadline,
        });
        processed++;

        await logAuditEvent({
          tenantId: request.tenantId,
          action:
            result.status === 'completed'
              ? AuditActions.GDPR_DELETION_COMPLETED
              : AuditActions.GDPR_DELETION_FAILED,
          metadata: { requestId: request.id, subjectId: request.subjectId, scope: request.scope },
        });
      } catch (err: unknown) {
        log.error('GDPR deletion failed', {
          requestId: request.id,
          error: err instanceof Error ? err.message : String(err),
        });

        await logAuditEvent({
          tenantId: request.tenantId,
          action: AuditActions.GDPR_DELETION_FAILED,
          metadata: { requestId: request.id, error: String(err) },
        });
      }
    }

    // Escalate overdue requests
    if (daysUntilDeadline < 0 && request.status !== 'completed') {
      await updateDeletionRequest(request.id, request.tenantId, {
        escalatedAt: now,
        retryCount: { increment: 1 },
      });
      escalated++;
      log.warn('GDPR SLA BREACH: Request overdue', {
        requestId: request.id,
        daysOverdue: Math.abs(Math.floor(daysUntilDeadline)),
      });

      await logAuditEvent({
        tenantId: request.tenantId,
        action: AuditActions.GDPR_SLA_ESCALATED,
        metadata: { requestId: request.id, daysOverdue: Math.abs(Math.floor(daysUntilDeadline)) },
      });
    }
  }

  log.info('GDPR SLA check complete', { processed, escalated });
}

export function getScheduler(): SchedulerStrategy | null {
  return scheduler;
}
