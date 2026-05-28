'use client';

/**
 * WorkflowVersionsTab Component
 *
 * Displays a list of workflow versions with state badges, environment,
 * published date/user, and activate/deactivate toggles.
 * Uses SWR for data fetching with cache invalidation on mutations.
 */

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import {
  ToggleLeft,
  ToggleRight,
  Loader2,
  GitBranch,
  Filter,
  GitCompare,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';
import type { WorkflowDetail } from '../../../api/workflows';
import {
  activateVersion,
  deactivateVersion,
  deleteVersion,
  diffVersions,
} from '../../../api/workflows';
import type { WorkflowVersionSummary } from '../../../api/workflows';
import { sanitizeError } from '../../../lib/sanitize-error';
import { useNavigationStore } from '../../../store/navigation-store';
import { Badge } from '../../ui/Badge';
import { Dialog } from '../../ui/Dialog';
import { DiffViewer } from '../../ui/DiffViewer';
import { EmptyState } from '../../ui/EmptyState';
import { Select } from '../../ui/Select';

// =============================================================================
// CONSTANTS
// =============================================================================

type StateFilter = 'all' | 'active' | 'inactive';

// Built lazily inside component using t() — see stateFilterOptions() below

// =============================================================================
// HELPERS
// =============================================================================

function formatDate(iso: string | undefined): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowVersionsTabProps {
  workflow: WorkflowDetail;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowVersionsTab({ workflow }: WorkflowVersionsTabProps) {
  const t = useTranslations('workflows.versions');
  const projectId = useNavigationStore((s) => s.projectId);

  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [mutatingVersion, setMutatingVersion] = useState<string | null>(null);

  // Diff state
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffBase, setDiffBase] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<{
    version1: string;
    version2: string;
    left: string;
    right: string;
  } | null>(null);

  // Delete state
  const [deletingVersion, setDeletingVersion] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowVersionSummary | null>(null);

  // Fetch versions via SWR
  const swrKey =
    projectId && workflow.id
      ? `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflow.id)}/versions`
      : null;

  const {
    data: versionsData,
    error: swrError,
    isLoading,
    mutate: refreshVersions,
  } = useSWR(swrKey);

  const versions: WorkflowVersionSummary[] = (
    ((versionsData as Record<string, unknown> | undefined)?.versions as
      | WorkflowVersionSummary[]
      | undefined) ?? []
  ).map((v) => ({
    ...v,
    id: v.id || (v as unknown as { _id?: string })._id || '',
  }));

  // Filter by state. Drafts have no persisted state but are conceptually
  // always active (they're the editable working copy), so include them when
  // filtering for 'active'.
  const filtered =
    stateFilter === 'all'
      ? versions
      : versions.filter((v) => {
          if (v.version === 'draft') return stateFilter === 'active';
          return v.state === stateFilter;
        });

  // Mutation handler
  const handleToggle = useCallback(
    async (version: WorkflowVersionSummary) => {
      if (!projectId || mutatingVersion) return;

      const isDraft = version.version === 'draft';
      if (isDraft) return;

      setMutatingVersion(version.version);
      try {
        if (version.state === 'active') {
          await deactivateVersion(projectId, workflow.id, version.version);
          toast.success(t('toast_deactivated', { version: version.version }));
        } else {
          await activateVersion(projectId, workflow.id, version.version);
          toast.success(t('toast_activated', { version: version.version }));
        }
        await refreshVersions();
      } catch (err) {
        const errorKey =
          version.state === 'active' ? 'error_deactivate_failed' : 'error_activate_failed';
        toast.error(sanitizeError(err, t(errorKey)));
      } finally {
        setMutatingVersion(null);
      }
    },
    [projectId, workflow.id, mutatingVersion, refreshVersions, t],
  );

  // Diff handler — two-click flow: first click sets base, second triggers comparison
  const handleDiffClick = useCallback(
    async (version: string) => {
      if (!projectId) return;

      if (!diffBase) {
        // First click — set as base version
        setDiffBase(version);
        return;
      }

      if (diffBase === version) {
        // Same version clicked — cancel selection
        setDiffBase(null);
        return;
      }

      // Second click — fetch diff between the two versions
      setDiffLoading(true);
      try {
        const result = await diffVersions(projectId, workflow.id, diffBase, version);
        const diff = result.diff as {
          version1: string;
          version2: string;
          definition1: Record<string, unknown>;
          definition2: Record<string, unknown>;
        };
        setDiffData({
          version1: diff.version1,
          version2: diff.version2,
          left: JSON.stringify(diff.definition1, null, 2),
          right: JSON.stringify(diff.definition2, null, 2),
        });
        setDiffOpen(true);
      } catch (err) {
        toast.error(sanitizeError(err, t('error_diff_failed')));
      } finally {
        setDiffLoading(false);
        setDiffBase(null);
      }
    },
    [projectId, workflow.id, diffBase, t],
  );

  // Delete handler
  const handleDelete = useCallback(
    async (version: WorkflowVersionSummary) => {
      if (!projectId || deletingVersion) return;

      setDeletingVersion(version.version);
      setConfirmDelete(null);
      try {
        await deleteVersion(projectId, workflow.id, version.version);
        toast.success(t('toast_deleted', { version: version.version }));
        await refreshVersions();
      } catch (err) {
        toast.error(sanitizeError(err, t('error_delete_failed', { version: version.version })));
      } finally {
        setDeletingVersion(null);
      }
    },
    [projectId, workflow.id, deletingVersion, refreshVersions, t],
  );

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        {t('loading')}
      </div>
    );
  }

  // Error state
  if (swrError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-destructive text-sm">
        {t('error_load_failed')}
      </div>
    );
  }

  // Empty state
  if (versions.length === 0) {
    return (
      <EmptyState
        icon={<GitBranch className="w-6 h-6" />}
        title={t('empty_no_versions')}
        description={t('empty_description')}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          {t('header', { count: versions.length })}
        </h2>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted" />
          <div className="w-32">
            <Select
              options={[
                { value: 'all', label: t('filter_all') },
                { value: 'active', label: t('filter_active') },
                { value: 'inactive', label: t('filter_inactive') },
              ]}
              value={stateFilter}
              onChange={(v) => setStateFilter(v as StateFilter)}
            />
          </div>
        </div>
      </div>

      {/* Diff selection hint */}
      {diffBase && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm text-primary">
          <GitCompare className="w-4 h-4" />
          <span>{t('diff_hint', { base: diffBase })}</span>
        </div>
      )}

      {/* Version table */}
      <div className="overflow-hidden rounded-xl border border-default">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-background-muted border-b border-default">
              <th className="text-left px-4 py-3 font-medium text-muted">{t('column_version')}</th>
              <th className="text-left px-4 py-3 font-medium text-muted">{t('column_state')}</th>
              <th className="text-left px-4 py-3 font-medium text-muted">
                {t('column_environment')}
              </th>
              <th className="text-left px-4 py-3 font-medium text-muted">
                {t('column_published_at')}
              </th>
              <th className="text-left px-4 py-3 font-medium text-muted">
                {t('column_published_by')}
              </th>
              <th className="text-right px-4 py-3 font-medium text-muted">{t('column_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((version) => {
              const isDraft = version.version === 'draft';
              const isActive = version.state === 'active';
              const isMutating = mutatingVersion === version.version;
              const isDeployed =
                version.deploymentId !== null && version.deploymentId !== undefined;
              const isDeleteDisabled = isDraft || isDeployed || deletingVersion !== null;
              const isToggleDisabled = isDraft || isDeployed || mutatingVersion !== null;
              const deleteTooltip = isDraft
                ? 'Cannot delete draft'
                : isDeployed
                  ? 'Deployed — cannot delete'
                  : 'Delete version';
              const toggleTooltip = isDraft
                ? t('toggle_draft_tooltip')
                : isDeployed
                  ? t('toggle_deployed_tooltip')
                  : isActive
                    ? t('action_deactivate')
                    : t('action_activate');

              return (
                <tr
                  key={version.id || version.version}
                  className="border-b border-default last:border-b-0 hover:bg-background-muted/50 transition-default"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-foreground">{version.version}</span>
                      {isDraft && <Badge variant="default">{t('draft_indicator')}</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={isDraft || isActive ? 'success' : 'default'}
                      dot={isDraft || isActive}
                    >
                      {isDraft || isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {isDraft ? '\u2014' : version.environment || '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {isDraft ? '\u2014' : formatDate(version.publishedAt)}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {isDraft ? '\u2014' : version.publishedBy || '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        className={clsx(
                          'p-1 transition-fast inline-flex items-center rounded hover:bg-background-muted',
                          diffBase === version.version && 'ring-2 ring-primary',
                          diffLoading && 'opacity-50 pointer-events-none',
                        )}
                        aria-label={
                          diffBase
                            ? diffBase === version.version
                              ? 'Cancel diff selection'
                              : `Compare with ${diffBase}`
                            : `Select ${version.version} for comparison`
                        }
                        title={
                          diffBase
                            ? diffBase === version.version
                              ? 'Cancel selection'
                              : `Compare with ${diffBase}`
                            : 'Compare versions'
                        }
                        onClick={() => handleDiffClick(version.version)}
                        disabled={diffLoading}
                      >
                        {diffLoading && diffBase === null ? (
                          <Loader2 className="w-5 h-5 text-muted animate-spin" />
                        ) : (
                          <GitCompare
                            className={clsx(
                              'w-5 h-5',
                              diffBase && diffBase !== version.version
                                ? 'text-primary'
                                : 'text-muted',
                            )}
                          />
                        )}
                      </button>
                      <button
                        className={clsx(
                          'p-1 transition-fast inline-flex items-center',
                          isToggleDisabled && 'opacity-50 pointer-events-none',
                        )}
                        aria-label={toggleTooltip}
                        title={toggleTooltip}
                        onClick={() => handleToggle(version)}
                        disabled={isToggleDisabled}
                      >
                        {isMutating ? (
                          <Loader2 className="w-7 h-7 text-muted animate-spin" />
                        ) : isActive ? (
                          <ToggleRight className="w-7 h-7 text-success" />
                        ) : (
                          <ToggleLeft className="w-7 h-7 text-muted" />
                        )}
                      </button>
                      <button
                        className={clsx(
                          'p-1 transition-fast inline-flex items-center rounded hover:bg-background-muted',
                          isDeleteDisabled && 'opacity-50 pointer-events-none',
                        )}
                        aria-label={deleteTooltip}
                        title={deleteTooltip}
                        onClick={() => setConfirmDelete(version)}
                        disabled={isDeleteDisabled}
                      >
                        {deletingVersion === version.version ? (
                          <Loader2 className="w-5 h-5 text-muted animate-spin" />
                        ) : (
                          <Trash2 className="w-5 h-5 text-destructive" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-muted">{t('filter_empty')}</div>
        )}
      </div>

      {/* Diff dialog */}
      <Dialog
        open={diffOpen}
        onClose={() => {
          setDiffOpen(false);
          setDiffData(null);
        }}
        title={
          diffData
            ? `${t('diff_title')}: ${diffData.version1} ↔ ${diffData.version2}`
            : t('diff_default_title')
        }
        maxWidth="5xl"
      >
        {diffData && (
          <DiffViewer
            left={diffData.left}
            right={diffData.right}
            leftLabel={diffData.version1}
            rightLabel={diffData.version2}
          />
        )}
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t('delete_confirm_title', { version: confirmDelete?.version ?? '' })}
        maxWidth="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('delete_confirm_description')}</p>
          {confirmDelete?.state === 'active' && (
            <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-warning">
              {t('delete_confirm_active_warning')}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              className="px-4 py-2 text-sm rounded-md border border-default hover:bg-background-muted transition-fast"
              onClick={() => setConfirmDelete(null)}
            >
              {t('delete_cancel')}
            </button>
            <button
              className="px-4 py-2 text-sm rounded-md bg-destructive text-white hover:bg-destructive/90 transition-fast"
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
              disabled={deletingVersion !== null}
            >
              {deletingVersion ? t('delete_confirm_btn_loading') : t('delete_confirm_btn')}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
