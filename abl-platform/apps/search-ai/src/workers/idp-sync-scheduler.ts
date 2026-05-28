/**
 * IdP Sync Scheduler
 *
 * Schedules automatic daily IdP sync jobs for all configured tenants.
 * Runs delta sync by default (full sync on first run or manual trigger).
 *
 * Schedule:
 * - Default: Daily at 2:00 AM UTC
 * - Per-tenant configuration via LLMCredential metadata
 *
 * Lifecycle:
 * - Call startScheduler() on server startup
 * - Call stopScheduler() on server shutdown
 */

import { Queue } from 'bullmq';
import {
  QUEUE_AZUREAD_USER_SYNC,
  QUEUE_AZUREAD_GROUP_SYNC,
  QUEUE_OKTA_USER_SYNC,
  QUEUE_OKTA_GROUP_SYNC,
  QUEUE_GOOGLE_USER_SYNC,
  QUEUE_GOOGLE_GROUP_SYNC,
} from '@agent-platform/search-ai-sdk';
import { createQueue } from './shared.js';
import { createLogger } from '@abl/compiler/platform';
import mongoose from 'mongoose';
import type { ILLMCredential } from '@agent-platform/database/models';

const logger = createLogger('idp-sync-scheduler');

// =============================================================================
// TYPES
// =============================================================================

interface SchedulerEntry {
  provider: 'azuread' | 'okta' | 'google';
  userQueue: Queue;
  groupQueue: Queue;
}

// =============================================================================
// STATE
// =============================================================================

let schedulers: SchedulerEntry[] = [];
let isRunning = false;

// =============================================================================
// SCHEDULER SETUP
// =============================================================================

/**
 * Start scheduled IdP sync jobs for all configured tenants.
 *
 * Creates repeatable jobs that run daily at 2 AM UTC.
 * Each tenant with IdP credentials gets automatic sync jobs.
 */
export async function startScheduler(): Promise<void> {
  if (isRunning) {
    logger.warn('IdP sync scheduler is already running');
    return;
  }

  try {
    logger.info('Starting IdP sync scheduler...');

    // Create queues for each provider via cluster-aware factory
    const azureadUserQueue = createQueue(QUEUE_AZUREAD_USER_SYNC);
    const azureadGroupQueue = createQueue(QUEUE_AZUREAD_GROUP_SYNC);
    const oktaUserQueue = createQueue(QUEUE_OKTA_USER_SYNC);
    const oktaGroupQueue = createQueue(QUEUE_OKTA_GROUP_SYNC);
    const googleUserQueue = createQueue(QUEUE_GOOGLE_USER_SYNC);
    const googleGroupQueue = createQueue(QUEUE_GOOGLE_GROUP_SYNC);

    schedulers = [
      { provider: 'azuread', userQueue: azureadUserQueue, groupQueue: azureadGroupQueue },
      { provider: 'okta', userQueue: oktaUserQueue, groupQueue: oktaGroupQueue },
      { provider: 'google', userQueue: googleUserQueue, groupQueue: googleGroupQueue },
    ];

    // Schedule repeatable jobs for each provider
    // Daily at 2:00 AM UTC (cron: "0 2 * * *")
    await Promise.all(
      schedulers.map(async ({ provider, userQueue, groupQueue }) => {
        // User sync job (runs first)
        await userQueue.add(
          `${provider}-user-sync-scheduled`,
          {
            // Job data will be populated from tenant credentials when job runs
            scheduled: true,
          },
          {
            repeat: {
              pattern: '0 2 * * *', // Daily at 2 AM UTC
            },
            jobId: `${provider}-user-sync-scheduled`, // Prevent duplicates
          },
        );

        // Group sync job (runs 30 minutes after user sync)
        await groupQueue.add(
          `${provider}-group-sync-scheduled`,
          {
            scheduled: true,
          },
          {
            repeat: {
              pattern: '30 2 * * *', // Daily at 2:30 AM UTC
            },
            jobId: `${provider}-group-sync-scheduled`,
          },
        );

        logger.info(`Scheduled daily IdP sync for ${provider} (2:00 AM UTC)`);
      }),
    );

    isRunning = true;
    logger.info('IdP sync scheduler started successfully');
  } catch (error) {
    logger.error('Failed to start IdP sync scheduler', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Stop all scheduled IdP sync jobs and close queue connections.
 */
export async function stopScheduler(): Promise<void> {
  if (!isRunning) {
    return;
  }

  try {
    logger.info('Stopping IdP sync scheduler...');

    // Remove repeatable jobs and close queues
    await Promise.allSettled(
      schedulers.map(async ({ provider, userQueue, groupQueue }) => {
        try {
          // Remove repeatable jobs
          await userQueue.removeRepeatableByKey(`${provider}-user-sync-scheduled:::0 2 * * *`);
          await groupQueue.removeRepeatableByKey(`${provider}-group-sync-scheduled:::30 2 * * *`);

          // Close queue connections
          await userQueue.close();
          await groupQueue.close();

          logger.info(`Stopped ${provider} IdP sync scheduler`);
        } catch (error) {
          logger.error(`Failed to stop ${provider} scheduler`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    schedulers = [];
    isRunning = false;
    logger.info('IdP sync scheduler stopped successfully');
  } catch (error) {
    logger.error('Failed to stop IdP sync scheduler', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get scheduler status (for health checks).
 */
export function getSchedulerStatus(): {
  running: boolean;
  providers: string[];
} {
  return {
    running: isRunning,
    providers: schedulers.map((s) => s.provider),
  };
}

/**
 * Trigger immediate sync for all tenants with the given provider.
 * Used by scheduler when repeatable job fires.
 */
export async function triggerScheduledSync(provider: 'azuread' | 'okta' | 'google'): Promise<void> {
  try {
    logger.info(`Triggering scheduled sync for ${provider}`);

    // Find all active credentials for this provider
    const LLMCredential = mongoose.model<ILLMCredential>('LLMCredential');
    const credentials = await LLMCredential.find({
      isActive: true,
      // Note: We should add a provider field to LLMCredential to filter by provider
      // For now, we'll check metadata field names
    });

    // Filter credentials by provider (based on metadata field names)
    const providerCredentials = credentials.filter((cred) => {
      const metadata = (cred as any).metadata || {};
      if (provider === 'azuread') {
        return metadata.azureadUserSyncDeltaToken !== undefined || metadata.tenantId;
      } else if (provider === 'okta') {
        return metadata.oktaUserSyncLastUpdated !== undefined || metadata.oktaDomain;
      } else if (provider === 'google') {
        return metadata.googleUserSyncLastUpdated !== undefined || metadata.googleDomain;
      }
      return false;
    });

    if (providerCredentials.length === 0) {
      logger.info(`No active ${provider} credentials found, skipping scheduled sync`);
      return;
    }

    // Get queues for this provider
    const scheduler = schedulers.find((s) => s.provider === provider);
    if (!scheduler) {
      logger.warn(`No scheduler found for provider ${provider}`);
      return;
    }

    // Trigger sync for each tenant
    await Promise.allSettled(
      providerCredentials.map(async (credential) => {
        try {
          const credentialWithMetadata = credential as any;
          const metadata = credentialWithMetadata.metadata || {};

          // Extract provider-specific metadata
          let lastUpdated: string | undefined;
          let deltaToken: string | undefined;
          let domain: string | undefined;

          if (provider === 'azuread') {
            deltaToken = metadata.azureadUserSyncDeltaToken;
            // Azure AD uses deltaToken, not lastUpdated
          } else if (provider === 'okta') {
            lastUpdated = metadata.oktaUserSyncLastUpdated;
            domain = metadata.oktaDomain;
          } else if (provider === 'google') {
            lastUpdated = metadata.googleUserSyncLastUpdated;
            domain = metadata.googleDomain;
          }

          // Determine sync mode (delta if we have a delta token/lastUpdated, otherwise full)
          const syncMode = deltaToken || lastUpdated ? 'delta' : 'full';

          // Build job data based on provider
          // Include authProfileId for dual-read migration when present
          const authProfileId = (credential as any).authProfileId || undefined;
          const userJobData: any = {
            tenantId: credential.tenantId,
            credentialId: credential._id.toString(),
            syncMode,
            ...(authProfileId && { authProfileId }),
          };

          const groupJobData: any = {
            tenantId: credential.tenantId,
            credentialId: credential._id.toString(),
            syncMode,
            ...(authProfileId && { authProfileId }),
          };

          // Add provider-specific fields
          if (provider === 'azuread') {
            if (deltaToken) userJobData.deltaToken = deltaToken;
            if (deltaToken) groupJobData.deltaToken = deltaToken;
          } else if (provider === 'okta') {
            if (lastUpdated) userJobData.lastUpdated = lastUpdated;
            if (lastUpdated) groupJobData.lastUpdated = lastUpdated;
            if (domain) {
              userJobData.oktaDomain = domain;
              groupJobData.oktaDomain = domain;
            }
          } else if (provider === 'google') {
            if (lastUpdated) userJobData.lastUpdated = lastUpdated;
            if (lastUpdated) groupJobData.lastUpdated = lastUpdated;
            if (domain) {
              userJobData.googleDomain = domain;
              groupJobData.googleDomain = domain;
            }
          }

          // Enqueue user sync job
          await scheduler.userQueue.add(`${provider}-user-sync-auto`, userJobData, {
            jobId: `${provider}-user-sync:${credential.tenantId}:${Date.now()}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          });

          // Enqueue group sync job (runs after user sync)
          await scheduler.groupQueue.add(`${provider}-group-sync-auto`, groupJobData, {
            jobId: `${provider}-group-sync:${credential.tenantId}:${Date.now()}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            delay: 60000, // Wait 1 minute after user sync job is enqueued
          });

          logger.info(`Scheduled sync triggered for tenant ${credential.tenantId} (${provider})`);
        } catch (error) {
          logger.error(`Failed to trigger sync for credential ${credential._id}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    logger.info(`Scheduled sync completed for ${provider} (${providerCredentials.length} tenants)`);
  } catch (error) {
    logger.error(`Failed to trigger scheduled sync for ${provider}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
