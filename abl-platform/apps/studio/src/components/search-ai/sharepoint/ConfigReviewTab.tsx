'use client';

/**
 * ConfigReviewTab
 *
 * Read-only configuration review before starting sync.
 * Replaces the old PreviewTab that tried to show fake sample documents.
 * Shows: sites, file types, limits, schedule, rules, permissions — all
 * from the connector config already in memory (zero additional API calls).
 */

import { useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useConnector } from '../../../hooks/useConnector';
import { useConnectorDiscovery } from '../../../hooks/useConnectorDiscovery';
import { useConnectorProposal } from '../../../hooks/useConnectorProposal';
import { approveProposal, startConnectorSync } from '../../../api/search-ai';

interface ConfigReviewTabProps {
  indexId: string;
  connectorId: string;
  onNavigateToFilters: () => void;
  onSyncStarted: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function ReviewCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-default bg-background-subtle p-3">
      <h4 className="text-[10px] font-semibold text-muted uppercase tracking-wider mb-2">
        {title}
      </h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-muted">{label}</span>
      <span className="text-foreground text-right max-w-[60%]">{value}</span>
    </div>
  );
}

export function ConfigReviewTab({
  indexId,
  connectorId,
  onNavigateToFilters,
  onSyncStarted,
}: ConfigReviewTabProps) {
  const t = useTranslations('search_ai.sharepoint.config_review');
  const { connector } = useConnector(indexId, connectorId);
  const { discovery } = useConnectorDiscovery(connectorId);
  const { proposal } = useConnectorProposal(indexId, connectorId);

  const [showConfirm, setShowConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const hasCompletedFirstSync = !!connector?.syncState?.lastFullSyncAt;

  const handleApproveAndSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      if (hasCompletedFirstSync) {
        // Re-sync: just start sync directly, don't go through proposal approval
        await startConnectorSync(connectorId);
      } else {
        // First sync: go through proposal approval flow
        await approveProposal(indexId, connectorId);
      }
      toast.success(t('sync_started'));
      setShowConfirm(false);
      onSyncStarted();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncing(false);
    }
  }, [indexId, connectorId, onSyncStarted, t, hasCompletedFirstSync]);

  const filterConfig = (connector?.filterConfig ?? {}) as Record<string, unknown>;
  const standardConfig = (filterConfig.standard ?? {}) as Record<string, unknown>;
  const scopeConfig = (filterConfig.scope ?? {}) as Record<string, unknown>;
  const connectionConfig = (connector?.connectionConfig ?? {}) as Record<string, unknown>;

  // Sites: prefer discovery, fallback to proposal
  const proposalScopeData = (proposal?.sections?.scope?.data ?? {}) as Record<string, unknown>;
  const proposalSites = Array.isArray(proposalScopeData.sites)
    ? (proposalScopeData.sites as Array<Record<string, unknown>>)
    : [];

  const totalSiteCount = (proposalScopeData.siteCount as number) ?? discovery?.sites?.length ?? 0;

  const selectedSiteIds = useMemo(() => {
    const ids = (scopeConfig.selectedSiteIds ?? scopeConfig.siteIds) as string[] | undefined;
    if (ids && ids.length > 0) return ids;
    if (discovery?.sites) return discovery.sites.map((s) => s.siteId);
    return proposalSites.map((s) => String(s.siteId ?? s.url ?? ''));
  }, [scopeConfig, discovery, proposalSites]);
  const selectedSiteCount = selectedSiteIds.length || totalSiteCount;

  const estimatedDocs = useMemo(() => {
    if (discovery?.sites) return discovery.sites.reduce((sum, s) => sum + (s.fileCount ?? 0), 0);
    return connector?.syncState?.totalDocuments ?? 0;
  }, [discovery, connector]);
  const estimatedSize = useMemo(() => {
    if (discovery?.sites) return discovery.sites.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0);
    return 0;
  }, [discovery]);

  // File extensions
  const fileExtConfig = standardConfig.fileExtensions as Record<string, unknown> | null;
  const fileExtensions = Array.isArray(fileExtConfig?.extensions)
    ? (fileExtConfig!.extensions as string[])
    : [];

  // Schedule
  const schedule = String(connectionConfig.syncSchedule ?? 'daily');
  const scheduleTime = String(connectionConfig.syncScheduleTime ?? '');
  const scheduleDayOfWeek = String(connectionConfig.syncScheduleDayOfWeek ?? '');

  // Permissions
  const permMode = connector?.permissionConfig?.mode ?? 'disabled';

  // Field mapping (from pre-sync fieldConfig)
  const fieldConfig = (connector as any)?.fieldConfig as {
    fields?: Array<{
      sourcePath: string;
      displayName: string;
      fieldType: string;
      selected: boolean;
      includeInEmbedding: boolean;
      canonicalMapping: string | null;
    }>;
  } | null;
  const selectedFields = useMemo(
    () => fieldConfig?.fields?.filter((f) => f.selected) ?? [],
    [fieldConfig],
  );
  const embeddingFields = useMemo(
    () => selectedFields.filter((f) => f.includeInEmbedding),
    [selectedFields],
  );
  const mappedFields = useMemo(
    () => selectedFields.filter((f) => f.canonicalMapping),
    [selectedFields],
  );

  // Site names: prefer discovery, fallback to proposal, last resort extract from ID
  const siteNames = useMemo(() => {
    // Build a name map from discovery or proposal
    const siteMap = new Map<string, string>();
    if (discovery?.sites) {
      discovery.sites.forEach((s) => siteMap.set(s.siteId, s.name));
    }
    proposalSites.forEach((s) => {
      const id = String(s.siteId ?? s.url ?? '');
      const name = String(s.name ?? '');
      if (id && name) siteMap.set(id, name);
    });
    return selectedSiteIds.map((id) => {
      if (siteMap.has(id)) return siteMap.get(id)!;
      // Extract readable name from composite Graph ID
      const parts = id.split(',');
      return parts[0].includes('.') ? parts[0].replace('.sharepoint.com', '') : id;
    });
  }, [selectedSiteIds, discovery, proposalSites]);
  const displaySiteNames =
    siteNames.length <= 5
      ? siteNames.join(', ')
      : `${siteNames.slice(0, 4).join(', ')}, +${siteNames.length - 4} more`;

  return (
    <div className="p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted mt-0.5">{t('subtitle')}</p>
      </div>

      {/* Estimates */}
      <div className="rounded-xl border border-success/20 bg-success/5 p-4">
        <p className="text-xs font-semibold text-success mb-2">📊 {t('estimate_title')}</p>
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center p-2 rounded-lg bg-background-muted/50">
            <p className="text-lg font-bold text-foreground">{selectedSiteCount}</p>
            <p className="text-[10px] text-muted">{t('estimate_sites')}</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-background-muted/50">
            <p className="text-lg font-bold text-foreground">
              {estimatedDocs > 0 ? `~${estimatedDocs.toLocaleString()}` : '—'}
            </p>
            <p className="text-[10px] text-muted">{t('estimate_docs')}</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-background-muted/50">
            <p className="text-lg font-bold text-foreground">
              {estimatedSize > 0 ? `~${formatBytes(estimatedSize)}` : '—'}
            </p>
            <p className="text-[10px] text-muted">{t('estimate_size')}</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-background-muted/50">
            <p className="text-lg font-bold text-foreground capitalize">{schedule}</p>
            <p className="text-[10px] text-muted">{t('estimate_frequency')}</p>
          </div>
        </div>
      </div>

      {/* Sites */}
      <ReviewCard title={t('card_sites')}>
        <ReviewRow
          label={t('sites_selected')}
          value={`${selectedSiteCount} of ${totalSiteCount} sites`}
        />
        <ReviewRow label={t('sites_list')} value={displaySiteNames} />
      </ReviewCard>

      {/* Permissions */}
      <ReviewCard title={t('card_permissions')}>
        <ReviewRow
          label={t('permission_aware')}
          value={
            <Badge variant={permMode === 'enabled' ? 'success' : 'warning'}>
              {permMode === 'enabled' ? 'Enabled' : 'Disabled'}
            </Badge>
          }
        />
      </ReviewCard>

      {/* File Types (Filters) */}
      <ReviewCard title={t('card_file_types')}>
        <ReviewRow
          label={t('file_types_mode')}
          value={fileExtConfig?.mode === 'denylist' ? 'Denylist' : 'Allowlist'}
        />
        <ReviewRow
          label={t('file_types_list')}
          value={
            fileExtensions.length > 0 ? (
              <span className="flex flex-wrap gap-1 justify-end">
                {fileExtensions.slice(0, 6).map((ext) => (
                  <Badge key={ext} variant="info">
                    {ext}
                  </Badge>
                ))}
                {fileExtensions.length > 6 && (
                  <Badge variant="default">+{fileExtensions.length - 6}</Badge>
                )}
              </span>
            ) : (
              'All file types'
            )
          }
        />
      </ReviewCard>

      {/* Field Mapping */}
      {selectedFields.length > 0 && (
        <ReviewCard title="Field Mapping">
          <ReviewRow
            label="Selected fields"
            value={`${selectedFields.length} of ${fieldConfig?.fields?.length ?? 0}`}
          />
          <ReviewRow label="Mapped to schema" value={`${mappedFields.length} fields`} />
          <ReviewRow
            label="For embedding"
            value={
              <span className="flex flex-wrap gap-1 justify-end">
                {embeddingFields.slice(0, 5).map((f) => (
                  <Badge key={f.sourcePath} variant="info">
                    {f.displayName}
                  </Badge>
                ))}
                {embeddingFields.length > 5 && (
                  <Badge variant="default">+{embeddingFields.length - 5}</Badge>
                )}
                {embeddingFields.length === 0 && <span className="text-muted">None selected</span>}
              </span>
            }
          />
          {embeddingFields.length > 0 && (
            <div className="mt-2 pt-2 border-t border-default">
              <p className="text-[10px] font-semibold text-muted uppercase tracking-wider mb-1.5">
                Embedding fields
              </p>
              <div className="flex flex-wrap gap-1">
                {embeddingFields.map((f) => (
                  <span
                    key={f.sourcePath}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-info/10 border border-info/20 text-[11px] text-info"
                  >
                    {f.displayName}
                    {f.canonicalMapping && (
                      <span className="text-muted">→ {f.canonicalMapping}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
        </ReviewCard>
      )}

      {/* Schedule */}
      <ReviewCard title={t('card_schedule')}>
        <ReviewRow label={t('frequency')} value={<span className="capitalize">{schedule}</span>} />
        {schedule !== 'disabled' && scheduleTime && (
          <ReviewRow
            label="Time"
            value={
              <span>
                {scheduleTime} UTC
                {schedule === 'weekly' && scheduleDayOfWeek && (
                  <span className="capitalize"> ({scheduleDayOfWeek})</span>
                )}
              </span>
            }
          />
        )}
      </ReviewCard>

      {/* Limits */}
      <ReviewCard title={t('card_limits')}>
        <ReviewRow
          label={t('max_file_size')}
          value={
            standardConfig.maxFileSizeBytes
              ? formatBytes(standardConfig.maxFileSizeBytes as number)
              : 'No limit'
          }
        />
        <ReviewRow
          label={t('date_range')}
          value={
            standardConfig.modifiedAfter || standardConfig.modifiedBefore
              ? `${String(standardConfig.modifiedAfter ?? 'Any')} — ${String(standardConfig.modifiedBefore ?? 'Any')}`
              : 'All dates'
          }
        />
      </ReviewCard>

      {/* Info note */}
      <div className="flex gap-2 p-3 rounded-lg border border-info/20 bg-info/5">
        <Info className="w-4 h-4 text-info shrink-0 mt-0.5" />
        <p className="text-xs text-muted">{t('info_note')}</p>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-3 border-t border-default">
        <Button variant="secondary" onClick={onNavigateToFilters}>
          ← {t('btn_edit_config')}
        </Button>
        <Button onClick={() => setShowConfirm(true)} disabled={isSyncing} loading={isSyncing}>
          {t('btn_approve_sync')} →
        </Button>
      </div>

      {/* Confirmation Dialog */}
      <ConfirmDialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleApproveAndSync}
        title={t('confirm_title')}
        description={t('confirm_description')}
        confirmLabel={t('btn_approve_sync')}
        variant="primary"
        loading={isSyncing}
      />
    </div>
  );
}
