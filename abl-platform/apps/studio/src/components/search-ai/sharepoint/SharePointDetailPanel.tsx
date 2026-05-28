'use client';

/**
 * SharePointDetailPanel
 *
 * Unified panel shell for SharePoint connector setup and monitoring.
 * Manages tab routing, expand/collapse, Simplified View toggle, and More Actions menu.
 * Tab content is placeholder in Wave 1 — actual components are built in Waves 2-4.
 */

import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useShallow } from 'zustand/react/shallow';
import {
  MoreHorizontal,
  FileJson,
  FileCode,
  Trash2,
  Maximize2,
  Minimize2,
  Lock,
} from 'lucide-react';

import { SlidePanel } from '../../ui/SlidePanel';
import { Tabs } from '../../ui/Tabs';
import { toast } from 'sonner';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Toggle } from '../../ui/Toggle';
import { Tooltip } from '../../ui/Tooltip';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../../ui/DropdownMenu';
import { useConnector } from '../../../hooks/useConnector';
import { useConnectorStore, type ConnectorTab } from '../../../store/connector-store';
import { ConnectTab } from './ConnectTab';
import { startProposalGeneration, deleteConnector } from '../../../api/search-ai';
import { ScopeFiltersTab } from './ScopeFiltersTab';
import { ConfigReviewTab } from './ConfigReviewTab';
import { ProposalTab } from './ProposalTab';
import { OverviewTab } from './OverviewTab';
import { DraftBanner } from './DraftBanner';
import { SecurityTab } from './SecurityTab';
import { FieldMappingStep } from './FieldMappingStep';
import { VersionHistoryTab } from './config/VersionHistoryTab';
import { ConfigExportDialog } from './config/ConfigExportDialog';
import { ContentPurgeDialog } from './config/ContentPurgeDialog';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SharePointDetailPanelProps {
  indexId: string;
  onRefresh: () => void;
}

interface TabDef {
  id: ConnectorTab;
  labelKey: string;
  wave: string;
  simplifiedHidden?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Tab definitions                                                    */
/* ------------------------------------------------------------------ */

const SETUP_TAB_DEFS: TabDef[] = [
  { id: 'connect', labelKey: 'tabs.connect', wave: 'Wave 2' },
  { id: 'proposal', labelKey: 'tabs.proposal', wave: 'Wave 2' },
  {
    id: 'scope-filters',
    labelKey: 'tabs.scopeFilters',
    wave: 'Wave 3',
    simplifiedHidden: true,
  },
  { id: 'field-mapping', labelKey: 'tabs.fieldMapping', wave: 'Wave 5' },
  { id: 'preview', labelKey: 'tabs.preview', wave: 'Wave 3' },
  { id: 'security', labelKey: 'tabs.security', wave: 'Wave 4' },
  {
    id: 'history',
    labelKey: 'tabs.history',
    wave: 'Wave 4',
    simplifiedHidden: true,
  },
];

const MONITORING_TAB_DEFS: TabDef[] = [
  { id: 'overview', labelKey: 'tabs.overview', wave: 'Wave 2' },
  { id: 'connect', labelKey: 'tabs.connect', wave: 'Wave 2' },
  {
    id: 'scope-filters',
    labelKey: 'tabs.scopeFilters',
    wave: 'Wave 3',
  },
  { id: 'preview', labelKey: 'tabs.preview', wave: 'Wave 3' },
  {
    id: 'history',
    labelKey: 'tabs.history',
    wave: 'Wave 4',
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isDraftStatus(
  connector: {
    syncState: { lastFullSyncAt: string | null; syncInProgress?: boolean };
    oauthTokenId?: string | null;
    errorState?: { consecutiveFailures?: number };
  } | null,
): boolean {
  if (!connector) return true;
  // Connector is draft if: no full sync has ever completed AND no sync is currently in progress
  // A connector that previously attempted sync (has failures) is not a draft — it's in error state
  if (connector.errorState?.consecutiveFailures && connector.errorState.consecutiveFailures > 0) {
    return false;
  }
  if (connector.syncState.syncInProgress) return false;
  return connector.syncState.lastFullSyncAt === null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SharePointDetailPanel({ indexId, onRefresh }: SharePointDetailPanelProps) {
  const t = useTranslations('search_ai.sharepoint');

  // Store state — use useShallow for the multi-field selector
  const { panelOpen, activeConnectorId, activeTab, simplifiedView, expandedPanel } =
    useConnectorStore(
      useShallow((s) => ({
        panelOpen: s.panelOpen,
        activeConnectorId: s.activeConnectorId,
        activeTab: s.activeTab,
        simplifiedView: s.simplifiedView,
        expandedPanel: s.expandedPanel,
      })),
    );

  // Store actions — stable references, no useShallow needed
  const closePanel = useConnectorStore((s) => s.closePanel);
  const setActiveTab = useConnectorStore((s) => s.setActiveTab);
  const setSimplifiedView = useConnectorStore((s) => s.setSimplifiedView);
  const setExpandedPanel = useConnectorStore((s) => s.setExpandedPanel);

  // Connector data — close panel if connector no longer exists (e.g. after deletion)
  const { connector, isLoading: connectorLoading } = useConnector(indexId, activeConnectorId);

  useEffect(() => {
    // Close panel if connector was deleted — but not if it's a new connector being created
    if (
      panelOpen &&
      activeConnectorId &&
      activeConnectorId !== 'new' &&
      !connectorLoading &&
      !connector
    ) {
      closePanel();
    }
  }, [panelOpen, activeConnectorId, connector, connectorLoading, closePanel]);

  const isDraft = isDraftStatus(connector);

  // Auto-correct tab only on initial panel open for NEW connectors:
  // if authenticated and panel just opened with default 'connect' tab, advance to 'proposal'.
  // Do NOT redirect if user explicitly clicks Connect tab (they may want to review settings).
  const hasAutoAdvancedRef = useRef(false);
  useEffect(() => {
    if (!connector || !panelOpen) {
      hasAutoAdvancedRef.current = false;
      return;
    }
    const authenticated = !!(connector as any).oauthTokenId;
    if (authenticated && activeTab === 'connect' && !hasAutoAdvancedRef.current) {
      hasAutoAdvancedRef.current = true;
      setActiveTab('proposal');
    }
  }, [connector, panelOpen, activeTab, setActiveTab]);

  // Dialog state for config export, content purge, and delete
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Auth state — used for tab locking and auto-navigation
  const isAuthenticated = !!(connector as any)?.oauthTokenId;

  // Determine which tab set to show
  const tabDefs = isDraft ? SETUP_TAB_DEFS : MONITORING_TAB_DEFS;

  // Filter tabs based on simplified view
  const visibleTabs = useMemo(
    () =>
      tabDefs
        .filter((td) => !simplifiedView || !td.simplifiedHidden)
        .map((td) => ({
          id: td.id,
          label: t(td.labelKey),
          icon:
            isDraft && !isAuthenticated && td.id !== 'connect' ? (
              <Lock className="w-3 h-3" />
            ) : undefined,
        })),
    [tabDefs, simplifiedView, t, isDraft, isAuthenticated],
  );

  // Find the wave for the active tab (for placeholder content)
  const activeWave = useMemo(() => {
    const def = tabDefs.find((td) => td.id === activeTab);
    return def?.wave ?? 'Wave 2';
  }, [tabDefs, activeTab]);
  const handleTabChange = useCallback(
    (tabId: string) => {
      // Connect tab is always accessible (users may want to review/change settings)
      if (tabId === 'connect') {
        setActiveTab(tabId as ConnectorTab);
        return;
      }
      // Proposal tab is accessible once authenticated
      if (tabId === 'proposal' && isAuthenticated) {
        setActiveTab(tabId as ConnectorTab);
        return;
      }
      // Other tabs: block only if draft AND not authenticated
      if (isDraft && !isAuthenticated) return;
      setActiveTab(tabId as ConnectorTab);
    },
    [isDraft, isAuthenticated, setActiveTab],
  );

  // Expand/collapse — auto-expand for scope-filters
  const handleExpandToggle = useCallback(() => {
    setExpandedPanel(!expandedPanel);
  }, [expandedPanel, setExpandedPanel]);

  // Tab change — no auto-expand, single column layout works at normal width
  const handleTabChangeWithAutoExpand = useCallback(
    (tabId: string) => {
      handleTabChange(tabId);
    },
    [handleTabChange],
  );

  // Panel close handler
  const handleClose = useCallback(() => {
    closePanel();
    onRefresh();
  }, [closePanel, onRefresh]);

  // Delete handler deferred — will use TypeToConfirmInput in Wave 2
  // Disabled alongside other deferred actions for production readiness

  // Panel title
  const panelTitle = useMemo(() => {
    const name =
      connector?.connectionConfig?.displayName ??
      connector?.connectionConfig?.siteName ??
      connector?.connectorType ??
      'SharePoint';
    const suffix = isDraft ? ` ${t('panel.draft')}` : '';
    return `${String(name)}${suffix}`;
  }, [connector, isDraft, t]);

  // Panel positioning: inline style ensures overrides always apply
  // (Tailwind JIT can't generate !top-[9.5rem] from dynamic strings).
  const panelStyle: React.CSSProperties = {
    top: '9.5rem',
    height: 'calc(100vh - 9.5rem)',
    maxWidth: expandedPanel ? 'calc(100vw - 16rem)' : '640px',
    borderTopLeftRadius: '0.75rem',
    transition: 'max-width 300ms ease-out',
  };

  return (
    <SlidePanel
      open={panelOpen}
      onClose={handleClose}
      className="shadow-2xl"
      style={panelStyle}
      nonBlocking
    >
      {/* Custom header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-default shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-lg font-semibold text-foreground truncate">{panelTitle}</h2>
          {isDraft && (
            <Badge variant="warning" dot>
              {t('panel.draft')}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Simplified View toggle */}
          <Toggle
            checked={simplifiedView}
            onChange={setSimplifiedView}
            label={t('panel.simplifiedView')}
          />

          {/* Expand/collapse */}
          <Tooltip content={expandedPanel ? t('panel.collapse') : t('panel.expand')}>
            <Button
              variant="ghost"
              size="sm"
              icon={
                expandedPanel ? (
                  <Minimize2 className="w-4 h-4" />
                ) : (
                  <Maximize2 className="w-4 h-4" />
                )
              }
              onClick={handleExpandToggle}
              aria-label={expandedPanel ? t('panel.collapse') : t('panel.expand')}
            />
          </Tooltip>

          {/* More Actions */}
          <DropdownMenu
            trigger={
              <Button
                variant="ghost"
                size="sm"
                icon={<MoreHorizontal className="w-4 h-4" />}
                aria-label={t('actions.moreActions')}
              />
            }
          >
            <DropdownMenuItem
              onSelect={() => setExportDialogOpen(true)}
              icon={<FileJson className="w-4 h-4" />}
            >
              {t('actions.exportJson')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setExportDialogOpen(true)}
              icon={<FileCode className="w-4 h-4" />}
            >
              {t('actions.exportYaml')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDeleteDialogOpen(true)}
              variant="danger"
              icon={<Trash2 className="w-4 h-4" />}
            >
              {t('actions.delete')}
            </DropdownMenuItem>
          </DropdownMenu>

          {/* Close */}
          <Button variant="ghost" size="sm" onClick={handleClose} aria-label={t('panel.close')}>
            &times;
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="px-6">
        <Tabs
          tabs={visibleTabs}
          activeTab={activeTab}
          onTabChange={handleTabChangeWithAutoExpand}
          layoutId="sp-detail-tab-indicator"
        />
      </div>

      {/* Draft banner */}
      {isDraft && activeConnectorId && (
        <DraftBanner
          connectorId={activeConnectorId}
          currentStep={
            !(connector as unknown as Record<string, unknown>)?.oauthTokenId
              ? 'auth'
              : !(connector?.connectionConfig as Record<string, unknown>)?.siteUrl
                ? 'scope'
                : 'preview'
          }
          onNavigateToStep={(step) => setActiveTab(step as ConnectorTab)}
        />
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'connect' && (
          <ConnectTab
            indexId={indexId}
            connectorId={activeConnectorId}
            onAuthComplete={async () => {
              // Trigger proposal generation before switching to proposal tab
              if (activeConnectorId && indexId) {
                try {
                  await startProposalGeneration(indexId, activeConnectorId);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (!msg.includes('already exists') && !msg.includes('ALREADY_EXISTS')) {
                    toast.error(
                      'Failed to generate proposal. Please try again from the Proposal tab.',
                    );
                  }
                }
              }
              setActiveTab('proposal');
            }}
            onConnectorCreated={(newId) => {
              // Update the store with the real connector ID
              useConnectorStore.getState().openPanel(newId, { isNew: false, tab: 'connect' });
            }}
          />
        )}
        {activeTab === 'scope-filters' && activeConnectorId && (
          <ScopeFiltersTab
            indexId={indexId}
            connectorId={activeConnectorId}
            onNavigateToPreview={() => setActiveTab('field-mapping')}
          />
        )}
        {activeTab === 'field-mapping' && activeConnectorId && (
          <FieldMappingStep
            indexId={indexId}
            connectorId={activeConnectorId}
            onSaved={() => setActiveTab('preview')}
            onBack={() => setActiveTab('scope-filters')}
          />
        )}
        {activeTab === 'proposal' && activeConnectorId && (
          <ProposalTab
            indexId={indexId}
            connectorId={activeConnectorId}
            simplifiedView={simplifiedView}
            onNavigateToTab={(tab) => setActiveTab(tab as ConnectorTab)}
          />
        )}
        {activeTab === 'preview' && activeConnectorId && (
          <ConfigReviewTab
            indexId={indexId}
            connectorId={activeConnectorId}
            onNavigateToFilters={() => setActiveTab('scope-filters')}
            onSyncStarted={() => {
              closePanel();
              onRefresh();
            }}
          />
        )}
        {activeTab === 'overview' && activeConnectorId && (
          <OverviewTab
            indexId={indexId}
            connectorId={activeConnectorId}
            onNavigateToTab={(tab) => setActiveTab(tab)}
            onRefresh={onRefresh}
          />
        )}
        {activeTab === 'security' && activeConnectorId && (
          <SecurityTab indexId={indexId} connectorId={activeConnectorId} />
        )}
        {activeTab === 'history' && activeConnectorId && (
          <VersionHistoryTab indexId={indexId} connectorId={activeConnectorId} />
        )}
      </div>

      {/* Persistent Save as Draft footer for draft connectors (except on the overview/approve tab which has its own) */}
      {isDraft && activeConnectorId && activeTab !== 'overview' && (
        <div className="shrink-0 border-t border-default px-6 py-3 flex items-center justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              closePanel();
              onRefresh();
            }}
          >
            {t('panel.saveDraft')}
          </Button>
        </div>
      )}

      {/* Config Export Dialog */}
      {activeConnectorId && (
        <ConfigExportDialog
          open={exportDialogOpen}
          onClose={() => setExportDialogOpen(false)}
          indexId={indexId}
          connectorId={activeConnectorId}
          connectorName={String(
            connector?.connectionConfig?.displayName ??
              connector?.connectionConfig?.siteName ??
              connector?.connectorType ??
              'SharePoint',
          )}
        />
      )}

      {/* Content Purge Dialog */}
      {activeConnectorId && (
        <ContentPurgeDialog
          open={purgeDialogOpen}
          onClose={() => setPurgeDialogOpen(false)}
          indexId={indexId}
          connectorId={activeConnectorId}
          connectorName={String(
            connector?.connectionConfig?.displayName ??
              connector?.connectionConfig?.siteName ??
              connector?.connectorType ??
              'SharePoint',
          )}
          documentCount={connector?.syncState?.totalDocuments ?? 0}
          onPurgeComplete={() => {
            closePanel();
            onRefresh();
          }}
        />
      )}

      {/* Delete Connector Confirmation */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={async () => {
          if (!activeConnectorId) return;
          setDeleting(true);
          try {
            await deleteConnector(indexId, activeConnectorId);
            toast.success('Connector deleted');
            setDeleteDialogOpen(false);
            closePanel();
            onRefresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete connector');
          } finally {
            setDeleting(false);
          }
        }}
        title="Delete Connector"
        description="This will permanently delete this connector, its source, and revoke OAuth tokens. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </SlidePanel>
  );
}
