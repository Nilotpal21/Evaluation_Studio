'use client';

/**
 * ConnectorErrorState (Dispatcher)
 *
 * Inspects the error type discriminator and renders the appropriate error template.
 * Supports 10 error types (E1-E10).
 */

import type { ConnectorTab } from '../../../../store/connector-store';
import { AuthFailedError } from './AuthFailedError';
import { DiscoveryTimeoutError } from './DiscoveryTimeoutError';
import { SyncFailureError } from './SyncFailureError';
import { TokenExpiredError } from './TokenExpiredError';
import { PermissionRevokedError } from './PermissionRevokedError';
import { ThrottledError } from './ThrottledError';
import { PartialSiteFailureError } from './PartialSiteFailureError';
import { ZeroSitesError } from './ZeroSitesError';
import { PopupBlockedError } from './PopupBlockedError';
import { AllUnsupportedError } from './AllUnsupportedError';

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
  | 'all_unsupported';

export interface ConnectorErrorData {
  type: ErrorType;
  errorCode?: string;
  errorMessage?: string;
  // E1-specific
  appRegistrationName?: string;
  secretCreatedDate?: string;
  // E2-specific
  sitesDiscovered?: number;
  sitesProfiled?: number;
  drivesFound?: number;
  estimatedFullDiscoveryTime?: string;
  // E3-specific
  docsProcessed?: number;
  docsTotal?: number;
  checkpointSaved?: boolean;
  resumeFromDoc?: number;
  // E4-specific
  tokenExpiryDate?: string;
  daysUntilExpiry?: number;
  lastRefreshAttempt?: string;
  refreshErrorCode?: string;
  // E5-specific
  revokedPermission?: string;
  impactList?: string[];
  indexedDocCount?: number;
  syncAutoPaused?: boolean;
  // E6-specific
  retryAfterSeconds?: number;
  requestsMade?: number;
  throttleScope?: string;
  syncProgressPercent?: number;
  // E7-specific
  siteStatuses?: Array<{
    siteName: string;
    status: 'ok' | 'failed';
    docsSynced: number;
    docsTotal: number;
    errorReason: string | null;
  }>;
  // E8-specific
  currentPermissionScope?: string;
  possibleReasons?: Array<{ reason: string; fix: string }>;
  // E9-specific
  popupBlockReason?: string;
  // E10-specific
  totalDiscoveredFiles?: number;
  discoveredFileTypes?: string[];
  supportedFileTypes?: string[];
}

interface ConnectorErrorStateProps {
  error: ConnectorErrorData;
  connectorId: string;
  indexId: string;
  onRetry: (action: string) => void;
  onNavigateToTab: (tab: ConnectorTab) => void;
  onReAuth: () => void;
}

export function ConnectorErrorState({
  error,
  connectorId,
  indexId,
  onRetry,
  onNavigateToTab,
  onReAuth,
}: ConnectorErrorStateProps) {
  const commonProps = { error, connectorId, indexId, onRetry, onNavigateToTab, onReAuth };

  switch (error.type) {
    case 'auth_failed':
      return <AuthFailedError {...commonProps} />;
    case 'discovery_timeout':
      return <DiscoveryTimeoutError {...commonProps} />;
    case 'sync_failed':
      return <SyncFailureError {...commonProps} />;
    case 'token_expired':
      return <TokenExpiredError {...commonProps} />;
    case 'permission_revoked':
      return <PermissionRevokedError {...commonProps} />;
    case 'throttled':
      return <ThrottledError {...commonProps} />;
    case 'partial_failure':
      return <PartialSiteFailureError {...commonProps} />;
    case 'zero_sites':
      return <ZeroSitesError {...commonProps} />;
    case 'popup_blocked':
      return <PopupBlockedError {...commonProps} />;
    case 'all_unsupported':
      return <AllUnsupportedError {...commonProps} />;
    default:
      return null;
  }
}
