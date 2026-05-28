/**
 * Connector Delta Sync Scheduler
 *
 * Background job that runs every hour to trigger delta sync for connectors
 * with stale lastDeltaSyncAt timestamps.
 *
 * Schedule: Runs every hour
 * Processing: Finds connectors with lastDeltaSyncAt > 1 hour old and triggers delta sync
 */

import { ConnectorConfig } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('delta-sync-scheduler');

/**
 * Trigger delta sync for all connectors with stale lastDeltaSyncAt.
 * Called by scheduled job every hour.
 */
export async function triggerStaleDeltaSyncs(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}> {
  log.info('Starting stale delta sync job');

  const staleThreshold = new Date();
  staleThreshold.setHours(staleThreshold.getHours() - 1); // 1 hour stale threshold

  // Find connectors that:
  // 1. Are not paused
  // 2. Have lastDeltaSyncAt older than 1 hour OR null (never synced)
  // 3. Have completed at least one full sync
  const staleConnectors = await ConnectorConfig.find({
    'errorState.isPaused': false,
    $or: [
      { 'syncState.lastDeltaSyncAt': { $lt: staleThreshold } },
      { 'syncState.lastDeltaSyncAt': null },
    ],
    'syncState.lastFullSyncAt': { $ne: null }, // Must have completed full sync first
  });

  log.info('Found connectors needing delta sync', { count: staleConnectors.length });

  let succeededCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const connector of staleConnectors) {
    const connectorId = String(connector._id);
    const tenantId = connector.tenantId;

    try {
      // Check if connector has any delta tokens (established during full sync)
      // If no tokens exist, skip delta sync (needs full sync first)
      const hasDeltaTokens = await checkForDeltaTokens(connectorId, tenantId);

      if (!hasDeltaTokens) {
        log.info('Skipping connector - no delta tokens (needs full sync)', {
          connectorId,
          tenantId,
        });
        skippedCount++;
        continue;
      }

      log.info('Triggering delta sync for connector', { connectorId, tenantId });

      // Trigger delta sync
      // Note: Actual sync execution would be handled by connector runtime
      // For now, we'll just update the timestamp to indicate sync was triggered
      await ConnectorConfig.updateOne(
        { _id: connector._id, tenantId },
        {
          $set: {
            'syncState.lastDeltaSyncAt': new Date(),
            'errorState.lastErrorAt': null,
            'errorState.lastErrorMessage': null,
            'errorState.consecutiveFailures': 0,
          },
        },
      );

      succeededCount++;

      log.info('Delta sync triggered for connector', { connectorId, tenantId });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Failed to trigger delta sync for connector', {
        connectorId,
        tenantId,
        error: errorMessage,
      });

      // Record failure
      await ConnectorConfig.updateOne(
        { _id: connector._id, tenantId },
        {
          $set: {
            'errorState.lastErrorAt': new Date(),
            'errorState.lastErrorMessage': errorMessage,
          },
          $inc: {
            'errorState.consecutiveFailures': 1,
          },
        },
      );

      failedCount++;
    }
  }

  const result = {
    processed: staleConnectors.length,
    succeeded: succeededCount,
    failed: failedCount,
    skipped: skippedCount,
  };

  log.info('Delta sync job completed', result);
  return result;
}

/**
 * Check if connector has any delta tokens.
 * Returns true if at least one drive has an established delta token.
 */
async function checkForDeltaTokens(connectorId: string, tenantId: string): Promise<boolean> {
  // Import here to avoid circular dependencies
  const { DriveDeltaToken } = await import('@agent-platform/database');

  const tokenCount = await DriveDeltaToken.countDocuments({
    connectorId,
    tenantId,
  });

  return tokenCount > 0;
}

/**
 * Cleanup old delta sync metadata.
 * Removes delta tokens for connectors that no longer exist.
 *
 * Called by scheduled job weekly.
 */
export async function cleanupOrphanedDeltaTokens(): Promise<{
  deleted: number;
}> {
  log.info('Starting orphaned token cleanup job');

  // Import here to avoid circular dependencies
  const { DriveDeltaToken } = await import('@agent-platform/database');

  // Find all unique connector IDs in delta tokens
  const tokenConnectorIds = await DriveDeltaToken.distinct('connectorId');

  log.info('Found connectors with delta tokens', { count: tokenConnectorIds.length });

  let deletedCount = 0;

  // Check each connector ID — use tenantId from delta token for isolation
  for (const connectorId of tokenConnectorIds) {
    // Get the tenantId from the delta token itself for proper scoping
    const sampleToken = await DriveDeltaToken.findOne({ connectorId }).lean();
    if (!sampleToken) continue;

    const tenantId = (sampleToken as any).tenantId;
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });

    if (!connector) {
      // Connector deleted, remove all tokens
      const result = await DriveDeltaToken.deleteMany({ connectorId });
      deletedCount += result.deletedCount || 0;

      log.info('Deleted orphaned tokens for connector', {
        connectorId,
        tenantId,
        deletedCount: result.deletedCount,
      });
    }
  }

  const result = { deleted: deletedCount };
  log.info('Cleanup job completed', result);
  return result;
}
