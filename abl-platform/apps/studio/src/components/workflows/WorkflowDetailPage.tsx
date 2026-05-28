'use client';

/**
 * WorkflowDetailPage Component
 *
 * Detail view for a single workflow with 6 tabs:
 * Overview, Steps, Triggers, Monitor, Errors, Notifications.
 *
 * Data flow:
 * - useWorkflowDetail() fetches the workflow by project + workflow ID
 * - useNavigationStore provides subPage (workflowId) and tab selection
 * - useWorkflowStore tracks the current workflow ID
 * - Tab switching via setTab() from navigation store
 */

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Play,
  Square,
  Loader2,
  Check,
  LayoutDashboard,
  Workflow,
  Zap,
  Activity,
  AlertTriangle,
  GitBranch,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useWorkflowStore } from '../../store/workflow-store';
import { useWorkflowCanvasStore } from '../../store/workflow-canvas-store';
import { useWorkflowDetail, denormalizeStep } from '../../hooks/useWorkflowDetail';
import {
  updateWorkflow,
  type WorkflowDetail,
  type WorkflowVersionSummary,
} from '../../api/workflows';
import { ACTIVE_EXEC_STATUSES } from './canvas/constants/workflow';
import { useWorkflowCancelExecution } from './canvas/hooks/useWorkflowCancelExecution';
import { sanitizeError } from '../../lib/sanitize-error';
import { compareSemverDescLocal } from '../../lib/semver-compare';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';
import { Skeleton, SkeletonText } from '../ui/Skeleton';
import { WorkflowOverviewTab } from './tabs/WorkflowOverviewTab';
import { WorkflowStepsTab } from './tabs/WorkflowStepsTab';
import { WorkflowTriggersTab } from './tabs/WorkflowTriggersTab';
import { WorkflowMonitorTab } from './tabs/WorkflowMonitorTab';
import { WorkflowErrorTab } from './tabs/WorkflowErrorTab';
import { WorkflowNotificationsTab } from './tabs/WorkflowNotificationsTab';
import { WorkflowVersionsTab } from './tabs/WorkflowVersionsTab';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_TAB = 'overview';

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowDetailPage() {
  const t = useTranslations('workflows.versions');
  const tDetail = useTranslations('workflows.detail');
  const tWorkflows = useTranslations('workflows');

  const workflowTabs = useMemo(
    () => [
      {
        id: 'overview',
        label: tDetail('tabs.overview'),
        icon: <LayoutDashboard className="w-4 h-4" />,
      },
      { id: 'flow', label: tDetail('tabs.flow'), icon: <Workflow className="w-4 h-4" /> },
      { id: 'triggers', label: tDetail('tabs.triggers'), icon: <Zap className="w-4 h-4" /> },
      { id: 'monitor', label: tDetail('tabs.monitor'), icon: <Activity className="w-4 h-4" /> },
      { id: 'versions', label: tDetail('tabs.versions'), icon: <GitBranch className="w-4 h-4" /> },
    ],
    [tDetail],
  );
  const { projectId, subPage: workflowId, tab, navigate, setTab } = useNavigationStore();
  const setSubPageLabel = useNavigationStore((s) => s.setSubPageLabel);
  const setCurrentWorkflow = useWorkflowStore((s) => s.setCurrentWorkflow);

  const { workflow, isLoading, error, refresh, mutate } = useWorkflowDetail(projectId, workflowId);

  // Fetch versions so we can display the active version as a tag beside the
  // workflow name. The versions endpoint response is shaped { success, versions }
  // (see WorkflowVersionsTab).
  const versionsKey =
    projectId && workflowId
      ? `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/versions`
      : null;
  const { data: versionsData } = useSWR(versionsKey);

  /**
   * Viewed version info to render beside the workflow name as a two-badge pair.
   *
   * Precedence:
   * 1. A published version with state === 'active' (skip 'draft').
   * 2. The 'draft' row if it is the only thing present (fresh workflow).
   *    Drafts are always treated as active (they are the editable working copy).
   * 3. null — hide the badges entirely.
   *
   * When viewing an inactive version, `activeSemverForInactive` is computed
   * as the highest-semver active published version for the "served via" caption.
   */
  const viewedVersionInfo = useMemo<{
    version: string;
    state: 'active' | 'inactive' | 'draft';
    activeSemverForInactive?: string;
  } | null>(() => {
    const raw = (versionsData as Record<string, unknown> | undefined)?.versions as
      | WorkflowVersionSummary[]
      | undefined;
    if (!raw || raw.length === 0) return null;

    // Sort active published versions by semver-desc so "latest active" matches
    // what the runtime + engine resolve to via compareSemverDesc().
    const activePublishedSorted = raw
      .filter((v) => v.state === 'active' && v.version !== 'draft')
      .slice()
      .sort((a, b) => compareSemverDescLocal(a.version, b.version));

    // Prefer highest-semver active published version
    if (activePublishedSorted[0]) {
      return { version: activePublishedSorted[0].version, state: 'active' };
    }

    // Fallback: draft is always conceptually active
    const draft = raw.find((v) => v.version === 'draft');
    if (draft) {
      return { version: 'draft', state: 'draft' };
    }

    // If only inactive versions exist, show the first one with "served via" caption.
    // Control flow: we only reach here when `activePublishedSorted` was empty
    // (truthy branch above returned), so no active-semver caption is possible.
    const firstInactive = raw.find((v) => v.state === 'inactive' && v.version !== 'draft');
    if (firstInactive) {
      return {
        version: firstInactive.version,
        state: 'inactive',
      };
    }

    return null;
  }, [versionsData]);

  const setRunDialogOpen = useWorkflowCanvasStore((s) => s.setRunDialogOpen);
  const setCanvasWorkflowId = useWorkflowCanvasStore((s) => s.setWorkflowId);
  const isDirty = useWorkflowCanvasStore((s) => s.isDirty);
  const isSaving = useWorkflowCanvasStore((s) => s.isSaving);

  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync workflow ID to both stores. setCanvasWorkflowId also resets stale
  // execution state so the Run/Stop button is correct on all tabs, not just
  // after the Flow tab has been visited.
  useEffect(() => {
    if (workflowId) {
      setCurrentWorkflow(workflowId);
      setCanvasWorkflowId(workflowId);
    }
    return () => {
      setCurrentWorkflow(null);
      setCanvasWorkflowId(null);
    };
  }, [workflowId, setCurrentWorkflow, setCanvasWorkflowId]);

  // Set breadcrumb label to workflow name instead of raw ID
  useEffect(() => {
    if (workflow?.name) {
      setSubPageLabel(workflow.name);
    }
    return () => setSubPageLabel(null);
  }, [workflow?.name, setSubPageLabel]);

  // Redirect old 'steps' tab to 'flow' for bookmarked URLs
  useEffect(() => {
    if (tab === 'steps') {
      setTab('flow');
    }
  }, [tab, setTab]);

  const activeTab = tab || DEFAULT_TAB;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/workflows`);
  }, [navigate, projectId]);

  const handleTabChange = useCallback(
    (tabId: string) => {
      setTab(tabId === DEFAULT_TAB ? null : tabId);
    },
    [setTab],
  );

  // Debounced save for step edits — saves 500ms after the last change
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleStepsChange = useCallback(
    (updated: WorkflowDetail) => {
      if (!projectId || !workflowId) return;

      // Clear any pending save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

      saveTimerRef.current = setTimeout(async () => {
        try {
          setSaveError(null);
          await updateWorkflow(projectId, workflowId, {
            steps: updated.steps.map(denormalizeStep) as any,
          });
          // Optimistic update: set SWR cache locally instead of refetching
          mutate(
            (current) =>
              current ? { ...current, data: { ...current.data, steps: updated.steps } } : current,
            { revalidate: false },
          );
        } catch (err) {
          setSaveError(sanitizeError(err, 'Failed to save workflow steps'));
          refresh();
        }
      }, 500);
    },
    [projectId, workflowId, refresh, mutate],
  );

  // Clean up pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Shared Run/Stop state — reads the canvas store so the header button
  // stays in sync with the toolbar button when an execution is in flight
  // from any entry point (header Run, toolbar Run, or Fire Now).
  const pageWorkflowId = useWorkflowCanvasStore((s) => s.pageWorkflowId);
  const currentExecutionId = useWorkflowCanvasStore((s) => s.currentExecutionId);
  const executionStatus = useWorkflowCanvasStore((s) => s.executionStatus);
  const isCancelling = useWorkflowCanvasStore((s) => s.isCancelling);
  const debugPanelOpen = useWorkflowCanvasStore((s) => s.debugPanelOpen);
  // Only trust canvas execution state when the store is pinned to this workflow.
  // pageWorkflowId is set eagerly on page mount (before the Flow tab is visited).
  const canvasMatchesPage = pageWorkflowId === workflowId;

  const handleExecute = useCallback(() => {
    setTab('flow');
    // Small delay so the canvas mounts before we open the dialog
    setTimeout(() => setRunDialogOpen(true), 100);
  }, [setTab, setRunDialogOpen]);
  const isExecuting =
    canvasMatchesPage &&
    debugPanelOpen &&
    currentExecutionId !== null &&
    (executionStatus === null || ACTIVE_EXEC_STATUSES.has(executionStatus));

  const { handleStop } = useWorkflowCancelExecution(
    canvasMatchesPage ? (projectId ?? undefined) : undefined,
    canvasMatchesPage ? (workflowId ?? undefined) : undefined,
  );

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-6 pt-6 pb-4 shrink-0 border-b border-default">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Skeleton className="h-4 w-16" />
              <span className="text-border-default">/</span>
              <Skeleton className="h-7 w-48" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-9 w-20 rounded-lg" />
          </div>
          <div className="mt-3">
            <SkeletonText className="w-64" />
          </div>
        </div>
        <div className="px-6 border-b border-default">
          <div className="flex gap-4 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-24 rounded-md" />
            ))}
          </div>
        </div>
        <div className="flex-1 min-h-0 p-6">
          <div className="max-w-4xl mx-auto space-y-4">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------

  if (error && !workflow) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={<AlertTriangle className="w-6 h-6" />}
          title={tDetail('not_found')}
          description={error}
          action={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleBack}>
                {tDetail('back')}
              </Button>
              <Button variant="secondary" onClick={() => refresh()}>
                {tWorkflows('retry')}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // No workflow loaded
  // ---------------------------------------------------------------------------

  if (!workflow) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={<AlertTriangle className="w-6 h-6" />}
          title={tDetail('not_found')}
          description={tDetail('not_found_description')}
          action={
            <Button variant="secondary" onClick={handleBack}>
              {tDetail('back')}
            </Button>
          }
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Tab content
  // ---------------------------------------------------------------------------

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <WorkflowOverviewTab workflow={workflow} projectId={projectId!} onSaved={refresh} />;
      case 'flow':
        return <WorkflowStepsTab workflow={workflow} />;
      case 'versions':
        return <WorkflowVersionsTab workflow={workflow} />;
      case 'triggers':
        return (
          <WorkflowTriggersTab
            workflow={workflow}
            onRefresh={refresh}
            viewedVersion={viewedVersionInfo?.version}
            viewedState={viewedVersionInfo?.state}
          />
        );
      case 'monitor':
        return <WorkflowMonitorTab projectId={projectId!} workflowId={workflow.id} />;
      case 'errors':
        return <WorkflowErrorTab workflow={workflow} projectId={projectId!} onSaved={refresh} />;
      case 'notifications':
        return <WorkflowNotificationsTab workflow={workflow} onRefresh={refresh} />;
      default:
        return <WorkflowOverviewTab workflow={workflow} projectId={projectId!} onSaved={refresh} />;
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-3 pb-2 shrink-0 border-b border-default">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-default shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{tDetail('breadcrumb_workflows')}</span>
            </button>
            <span className="text-border-default">/</span>
            <h1 className="text-base font-semibold text-foreground truncate">{workflow.name}</h1>
            {viewedVersionInfo && (
              <>
                <button
                  onClick={() => setTab('versions')}
                  className="shrink-0"
                  aria-label={t('versionBadgeLabel', { version: viewedVersionInfo.version })}
                >
                  <Badge variant="default" testid="workflow-version-badge">
                    {viewedVersionInfo.version}
                  </Badge>
                </button>
                {/* State pill only makes sense for published versions.
                    The draft is an editable working copy, not a lifecycle
                    state (active/inactive apply to published versions); so
                    we suppress the pill when viewing draft to avoid the
                    `[draft] [draft]` duplication. Downstream consumers
                    still receive `state === 'draft'` via props so the
                    Triggers tab and WebhookQuickStart can branch on it. */}
                {viewedVersionInfo.state !== 'draft' && (
                  <span
                    title={
                      viewedVersionInfo.state === 'inactive'
                        ? t('tooltip_inactive')
                        : t('tooltip_active')
                    }
                  >
                    <Badge
                      variant={viewedVersionInfo.state === 'active' ? 'success' : 'default'}
                      testid="workflow-state-badge"
                    >
                      {t(`state_${viewedVersionInfo.state}`)}
                    </Badge>
                  </span>
                )}
                {viewedVersionInfo.state === 'inactive' &&
                  viewedVersionInfo.activeSemverForInactive && (
                    <span className="text-xs text-muted ml-2" data-testid="served-via-caption">
                      {t('servedVia', {
                        version: viewedVersionInfo.activeSemverForInactive,
                      })}
                    </span>
                  )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSaving ? (
              <span className="text-xs text-muted animate-pulse">Saving...</span>
            ) : (
              !isDirty && (
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Check className="w-3 h-3 text-success" />
                  Saved
                </span>
              )
            )}
            {isExecuting ? (
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleStop()}
                disabled={isCancelling}
                icon={
                  isCancelling ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )
                }
                data-testid="detail-stop-btn"
              >
                {isCancelling ? 'Stopping…' : 'Stop'}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleExecute}
                icon={<Play className="w-4 h-4" />}
                data-testid="detail-run-btn"
              >
                Run
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Error banners */}
      {saveError && (
        <div className="px-6 py-2 bg-error-subtle border-b border-error/20 flex items-center justify-between gap-2 shrink-0">
          <p className="text-sm text-error">{saveError}</p>
          <button
            onClick={() => setSaveError(null)}
            className="text-xs text-error hover:underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="px-6">
        <Tabs
          tabs={workflowTabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          layoutId="workflow-tab-indicator"
        />
      </div>

      {/* Tab content */}
      {activeTab === 'flow' ? (
        <div className="flex-1 min-h-0 overflow-hidden">{renderTabContent()}</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-6">
          <div className="max-w-4xl mx-auto">{renderTabContent()}</div>
        </div>
      )}
    </div>
  );
}
