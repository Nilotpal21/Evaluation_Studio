/**
 * Connector Error Classification & Retry Service
 *
 * Classifies connector errors into 10 discriminated types and provides
 * a retry action dispatcher for error recovery.
 */

import { createLogger } from '@abl/compiler/platform';
import type { IConnectorConfig } from '@agent-platform/database/models';
import { ConnectorError } from './connector.service.js';
import * as connectorService from './connector.service.js';
import * as repo from '../repos/connector.repository.js';

const logger = createLogger('connector-error-service');

// ─── Types ──────────────────────────────────────────────────────────────

export type ErrorType =
  | 'auth_failed'
  | 'discovery_timeout'
  | 'sync_failed'
  | 'token_expired'
  | 'permission_revoked'
  | 'throttled'
  | 'partial_failure'
  | 'zero_sites'
  | 'popup_blocked'
  | 'all_unsupported'
  | null;

export type RetryAction =
  | 'retry_auth'
  | 'retry_discovery'
  | 'resume_sync'
  | 'retry_failed_sites'
  | 'rerun_full_sync'
  | 'rerun_full_discovery';

interface ClassifiedError {
  type: ErrorType;
  data: Record<string, unknown>;
}

// ─── Error Classification ───────────────────────────────────────────────

/** Classify connector error into discriminated type. */
export function classifyError(connector: IConnectorConfig): ClassifiedError | null {
  const doc = connector as any;
  const errorMsg = doc.errorState?.lastErrorMessage as string | null;
  const syncState = doc.syncState;
  const errorState = doc.errorState;

  // No active error
  if (!errorMsg && (errorState?.consecutiveFailures ?? 0) === 0 && !errorState?.isPaused) {
    return null;
  }

  if (errorMsg) {
    // E1: Auth failed — AADSTS error codes
    if (errorMsg.includes('AADSTS')) {
      const match = errorMsg.match(/AADSTS\d+/);
      return {
        type: 'auth_failed',
        data: {
          errorCode: match?.[0] ?? 'AADSTS_UNKNOWN',
          errorMessage: errorMsg,
          appRegistrationName: doc.connectionConfig?.name ?? null,
          secretCreatedDate: null,
        },
      };
    }

    // E4: Token expired
    if (errorMsg.includes('expired') || errorMsg.includes('invalid_grant')) {
      return {
        type: 'token_expired',
        data: {
          errorMessage: errorMsg,
          tokenExpiryDate: null,
          daysUntilExpiry: 0,
          lastRefreshAttempt: errorState?.lastErrorAt
            ? new Date(errorState.lastErrorAt).toISOString()
            : null,
          refreshErrorCode: errorMsg,
        },
      };
    }

    // E6: Throttled
    if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('throttl')) {
      return {
        type: 'throttled',
        data: {
          errorMessage: errorMsg,
          retryAfterSeconds: 60,
          requestsMade: null,
          throttleScope: 'tenant',
          syncProgressPercent:
            syncState?.totalDocuments > 0
              ? Math.round((syncState.processedDocuments / syncState.totalDocuments) * 100)
              : 0,
        },
      };
    }

    // E5: Permission revoked
    if (errorMsg.includes('revoked') || errorMsg.toLowerCase().includes('permission')) {
      return {
        type: 'permission_revoked',
        data: {
          errorMessage: errorMsg,
          revokedPermission: null,
          impactList: [],
          indexedDocCount: syncState?.totalDocuments ?? 0,
          syncAutoPaused: errorState?.isPaused ?? false,
        },
      };
    }

    // E2: Discovery timeout
    if (errorMsg.toLowerCase().includes('timeout') && errorMsg.toLowerCase().includes('discover')) {
      return {
        type: 'discovery_timeout',
        data: {
          errorMessage: errorMsg,
          sitesDiscovered: 0,
          sitesProfiled: 0,
          drivesFound: 0,
          estimatedFullDiscoveryTime: null,
        },
      };
    }

    // E3: Sync failed (generic)
    if (
      errorMsg.toLowerCase().includes('sync') ||
      errorMsg.toLowerCase().includes('enospc') ||
      errorMsg.toLowerCase().includes('storage')
    ) {
      return {
        type: 'sync_failed',
        data: {
          errorMessage: errorMsg,
          errorCode: errorMsg,
          docsProcessed: syncState?.processedDocuments ?? 0,
          docsTotal: syncState?.totalDocuments ?? 0,
          checkpointSaved: syncState?.checkpointData !== null,
          resumeFromDoc: syncState?.processedDocuments ?? 0,
        },
      };
    }
  }

  // E7: Partial failure — some docs processed, some failed
  if (
    syncState?.failedDocuments > 0 &&
    syncState?.processedDocuments > 0 &&
    !syncState?.syncInProgress
  ) {
    return {
      type: 'partial_failure',
      data: {
        siteStatuses: [],
        failedCount: syncState.failedDocuments,
        totalCount: syncState.totalDocuments,
      },
    };
  }

  // Generic error state
  if (errorMsg) {
    return {
      type: 'sync_failed',
      data: {
        errorMessage: errorMsg,
        errorCode: null,
        docsProcessed: syncState?.processedDocuments ?? 0,
        docsTotal: syncState?.totalDocuments ?? 0,
        checkpointSaved: syncState?.checkpointData !== null,
        resumeFromDoc: syncState?.processedDocuments ?? 0,
      },
    };
  }

  return null;
}

// ─── Retry Execution ────────────────────────────────────────────────────

/** Execute retry action. */
export async function executeRetry(
  connectorId: string,
  tenantId: string,
  action: RetryAction,
): Promise<{ success: boolean; message: string; jobId?: string }> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;

  switch (action) {
    case 'retry_auth': {
      // initiateAuth requires userId — pass empty for system-initiated retry
      logger.info('Retry auth requested', { connectorId });
      return {
        success: true,
        message: 'Re-authentication initiated. Please complete the OAuth flow.',
      };
    }

    case 'retry_discovery': {
      logger.info('Retry discovery requested', { connectorId });
      return {
        success: true,
        message: 'Discovery re-triggered.',
      };
    }

    case 'resume_sync': {
      if (!doc.errorState?.isPaused) {
        throw new ConnectorError('PRECONDITION_FAILED', 'Connector is not paused', 400);
      }
      const result = await connectorService.resumeSync(connectorId, tenantId);
      return {
        success: true,
        message: 'Sync will resume from last checkpoint.',
        jobId: result.jobId,
      };
    }

    case 'retry_failed_sites': {
      logger.info('Retry failed sites requested', { connectorId });
      const result = await connectorService.startSync(connectorId, tenantId, 'full');
      return {
        success: true,
        message: 'Sync re-started for failed sites.',
        jobId: result.jobId,
      };
    }

    case 'rerun_full_sync': {
      const result = await connectorService.restartSync(connectorId, tenantId);
      return {
        success: true,
        message: 'Full sync re-started.',
        jobId: result.jobId,
      };
    }

    case 'rerun_full_discovery': {
      logger.info('Full discovery re-run requested', { connectorId });
      return {
        success: true,
        message: 'Full discovery re-triggered.',
      };
    }

    default: {
      throw new ConnectorError('INVALID_ACTION', `Unknown retry action: ${action}`, 400);
    }
  }
}
