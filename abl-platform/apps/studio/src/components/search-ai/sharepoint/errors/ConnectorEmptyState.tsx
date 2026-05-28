'use client';

/**
 * ConnectorEmptyState (Dispatcher)
 *
 * Renders empty state components: EM2 (no documents), EM3 (no sites accessible).
 * EM1 (no connectors) is handled by the Connect tab.
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { ConnectorTab } from '../../../../store/connector-store';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { NoDocumentsEmpty } from './NoDocumentsEmpty';
import { NoSitesAccessibleEmpty } from './NoSitesAccessibleEmpty';

export type EmptyStateType = 'no_connectors' | 'no_documents' | 'no_sites_accessible';

interface ConnectorEmptyStateProps {
  type: EmptyStateType;
  connectorId: string;
  indexId: string;
  onNavigateToTab: (tab: ConnectorTab) => void;
  // EM2-specific
  filterExclusions?: Array<{
    filterType: string;
    excludedCount: number;
    detail: string;
  }>;
  // EM3-specific
  currentPermissionScope?: string;
  approvedSiteCount?: number;
}

export function ConnectorEmptyState({
  type,
  connectorId,
  indexId,
  onNavigateToTab,
  filterExclusions,
  currentPermissionScope,
}: ConnectorEmptyStateProps) {
  const t = useTranslations('search_ai.sharepoint.empty');

  const handleCheckAccess = useCallback(
    async (siteUrl: string) => {
      try {
        const response = await apiFetch(
          `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/check-site-access`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteUrl }),
          },
        );
        const result = await handleResponse<{
          success: boolean;
          data: { accessible: boolean; siteName?: string };
        }>(response);
        if (result.data.accessible) {
          toast.success(t('site_accessible', { site: result.data.siteName ?? siteUrl }));
        } else {
          toast.error(t('site_not_accessible'));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [connectorId, indexId, t],
  );

  const handleSendRequestToAdmin = useCallback(() => {
    const subject = encodeURIComponent(t('admin_request_subject'));
    const body = encodeURIComponent(t('admin_request_body'));
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  }, [t]);

  const handleUpgradeScope = useCallback(() => {
    // Navigate to the connect tab to re-authenticate with broader scope
    onNavigateToTab('connect');
  }, [onNavigateToTab]);

  switch (type) {
    case 'no_connectors':
      // Handled by Connect tab
      return null;

    case 'no_documents':
      return (
        <NoDocumentsEmpty
          filterExclusions={filterExclusions ?? []}
          onAdjustFilters={() => onNavigateToTab('scope-filters')}
          onSelectDifferentSites={() => onNavigateToTab('scope-filters')}
          onViewAllDiscovered={() => onNavigateToTab('preview')}
        />
      );

    case 'no_sites_accessible':
      return (
        <NoSitesAccessibleEmpty
          currentPermissionScope={currentPermissionScope ?? 'Sites.Selected'}
          onCheckAccess={handleCheckAccess}
          onSendRequestToAdmin={handleSendRequestToAdmin}
          onUpgradeScope={handleUpgradeScope}
        />
      );

    default:
      return null;
  }
}
