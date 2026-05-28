/**
 * Cron Scheduler
 *
 * Manages BullMQ repeatable jobs for cron-based triggers.
 * On each fire: invokes Restate workflow with the cron expression
 * and fire timestamp as trigger payload.
 */

import crypto from 'crypto';
import type {
  TriggerRegistrationModel,
  RestateIngressClient,
  TriggerQueue,
  TriggerJobData,
} from './types.js';
import { TRIGGER_AUTO_PAUSE_THRESHOLD } from './constants.js';

/** Dependencies for the cron scheduler */
export interface CronSchedulerDeps {
  registrationModel: TriggerRegistrationModel;
  restateClient: RestateIngressClient;
  queue: TriggerQueue;
}

/**
 * Validate a cron expression (basic 5-field format).
 * Returns true if the expression has 5 or 6 space-separated fields.
 */
export function isValidCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

/**
 * Register a cron trigger as a BullMQ repeatable job.
 */
export async function registerCronTrigger(
  registration: {
    _id: string;
    tenantId: string;
    projectId: string;
    workflowId: string;
    connectorName: string;
    triggerName: string;
    connectionId: string;
    cronExpression: string;
    workflowVersionId?: string;
    environment?: string;
  },
  deps: CronSchedulerDeps,
): Promise<void> {
  if (!isValidCronExpression(registration.cronExpression)) {
    throw new Error(`Invalid cron expression: ${registration.cronExpression}`);
  }

  await deps.queue.add(
    'cron-trigger',
    {
      registrationId: registration._id,
      tenantId: registration.tenantId,
      projectId: registration.projectId,
      connectorName: registration.connectorName,
      triggerName: registration.triggerName,
      connectionId: registration.connectionId,
      ...(registration.workflowVersionId
        ? { workflowVersionId: registration.workflowVersionId }
        : {}),
      ...(registration.environment ? { environment: registration.environment } : {}),
    },
    {
      repeat: { cron: registration.cronExpression },
      jobId: `cron:${registration._id}`,
    },
  );
}

/**
 * Remove a cron trigger's repeatable job.
 */
export async function deregisterCronTrigger(
  registrationId: string,
  cronExpression: string,
  deps: Pick<CronSchedulerDeps, 'queue'>,
): Promise<void> {
  await deps.queue.removeRepeatable('cron-trigger', {
    cron: cronExpression,
    jobId: `cron:${registrationId}`,
  });
}

/**
 * Process a single cron job.
 * Called by the BullMQ worker processor.
 */
export async function processCronJob(job: TriggerJobData, deps: CronSchedulerDeps): Promise<void> {
  const registration = await deps.registrationModel.findOne({
    _id: job.registrationId,
    tenantId: job.tenantId,
    status: 'active',
  });

  if (!registration) return;

  const executionId = crypto.randomUUID();

  try {
    await deps.restateClient.startWorkflow(executionId, {
      workflowId: registration.workflowId,
      ...(registration.workflowVersionId
        ? { workflowVersionId: registration.workflowVersionId }
        : {}),
      tenantId: registration.tenantId,
      projectId: registration.projectId,
      triggerType: 'cron',
      triggerPayload: {
        firedAt: new Date().toISOString(),
        cronExpression: registration.cronExpression,
      },
      triggerMetadata: {
        connectorName: job.connectorName,
        triggerName: job.triggerName,
        registrationId: job.registrationId,
      },
    });

    // Reset error counter on success
    await deps.registrationModel.findOneAndUpdate(
      { _id: job.registrationId, tenantId: job.tenantId },
      { $set: { lastFiredAt: new Date(), consecutiveErrors: 0 } },
    );
  } catch {
    // Track consecutive errors
    const updated = await deps.registrationModel.findOneAndUpdate(
      { _id: job.registrationId, tenantId: job.tenantId },
      { $inc: { consecutiveErrors: 1 }, $set: { lastErrorAt: new Date() } },
      { new: true },
    );

    if (updated && updated.consecutiveErrors >= TRIGGER_AUTO_PAUSE_THRESHOLD) {
      await deps.registrationModel.findOneAndUpdate(
        { _id: job.registrationId, tenantId: job.tenantId },
        { $set: { status: 'error' } },
      );
    }
  }
}
