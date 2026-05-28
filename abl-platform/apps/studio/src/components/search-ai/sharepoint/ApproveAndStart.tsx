'use client';

/**
 * ApproveAndStart
 *
 * Final checkpoint before sync. Shows a read-only configuration summary,
 * estimated sync time, and three action buttons:
 *   - Start Sync (with confirmation dialog)
 *   - Save as Draft
 *   - Export Template (disabled until Wave 4)
 *
 * When security approval is pending, the Start Sync button text changes
 * to "Submit for Security Approval".
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { getConfigSummary, approveProposal, type ConfigSummary } from '../../../api/search-ai';

interface ApproveAndStartProps {
  indexId: string;
  connectorId: string;
  onSyncStarted: (syncJobId: string) => void;
  onSaveAsDraft: () => void;
  onExportTemplate: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function ApproveAndStart({
  indexId,
  connectorId,
  onSyncStarted,
  onSaveAsDraft,
  onExportTemplate,
}: ApproveAndStartProps) {
  const t = useTranslations('search_ai.sharepoint.approve');

  const [summary, setSummary] = useState<ConfigSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadSummary() {
      setIsLoading(true);
      setError(null);
      try {
        const data = await getConfigSummary(indexId, connectorId);
        if (!cancelled) setSummary(data);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [indexId, connectorId]);

  const handleConfirmSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      const result = await approveProposal(indexId, connectorId);
      toast.success(t('sync_started'));
      setShowConfirm(false);
      onSyncStarted(result.syncJobId);
    } catch (err: unknown) {
      toast.error(t('sync_error'));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncing(false);
    }
  }, [indexId, connectorId, onSyncStarted, t]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-sm">{t('loading')}</p>
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted">
        <AlertTriangle className="w-6 h-6 text-error" />
        <p className="text-sm">{t('error')}</p>
        <p className="text-xs">{error}</p>
      </div>
    );
  }

  if (!summary) return null;

  const securityPending = summary.security?.status === 'pending';
  const sizeStr = formatBytes(summary.estimatedSizeBytes ?? 0);

  return (
    <div className="p-6 space-y-6">
      {/* Title */}
      <div>
        <h3 className="text-base font-semibold text-foreground">{t('title')}</h3>
        <p className="text-sm text-muted mt-1">{t('description')}</p>
      </div>

      {/* Configuration Summary */}
      <div className="space-y-4">
        {/* Connection */}
        <SummarySection title={t('section_connection')}>
          <SummaryRow label={t('auth_method')} value={summary.connection?.authMethod ?? '-'} />
          <SummaryRow label={t('tenant_id')} value={summary.connection?.tenantId ?? '-'} />
          <SummaryRow label={t('client_id')} value={summary.connection?.clientId ?? '-'} />
        </SummarySection>

        {/* Scope */}
        <SummarySection title={t('section_scope')}>
          <SummaryRow label={t('scope_variant')} value={summary.scope?.variant ?? '-'} />
          <SummaryRow
            label={t('site_count', { count: summary.scope?.siteCount ?? 0 })}
            value={summary.scope?.sites?.join(', ') || t('not_available')}
          />
        </SummarySection>

        {/* Filters */}
        <SummarySection title={t('section_filters')}>
          <SummaryRow label={t('filter_template')} value={summary.filters?.template ?? '-'} />
          <SummaryRow
            label={t('file_types')}
            value={
              (summary.filters?.fileTypes?.length ?? 0) > 0
                ? summary.filters!.fileTypes.join(', ')
                : t('not_available')
            }
          />
          {summary.filters?.dateRange && (
            <SummaryRow
              label={t('date_range')}
              value={[summary.filters.dateRange.after, summary.filters.dateRange.before]
                .filter(Boolean)
                .join(' — ')}
            />
          )}
        </SummarySection>

        {/* Schedule */}
        <SummarySection title={t('section_schedule')}>
          <SummaryRow label={t('frequency')} value={summary.schedule?.frequency ?? '-'} />
          {summary.schedule?.nextRun && (
            <SummaryRow label={t('next_run')} value={summary.schedule.nextRun} />
          )}
        </SummarySection>

        {/* Permissions */}
        <SummarySection title={t('section_permissions')}>
          <SummaryRow label={t('permission_mode')} value={summary.permissions?.mode ?? '-'} />
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted">{t('permission_aware')}</span>
            <Badge variant={summary.permissions?.permissionAwareEnabled ? 'success' : 'warning'}>
              {summary.permissions?.permissionAwareEnabled
                ? t('permission_aware_enabled')
                : t('permission_aware_disabled')}
            </Badge>
          </div>
        </SummarySection>

        {/* Security */}
        <SummarySection title={t('section_security')}>
          <SummaryRow label={t('security_status')} value={summary.security?.status ?? '-'} />
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted">{t('security_approval_required')}</span>
            <Badge variant={summary.security?.approvalRequired ? 'warning' : 'default'}>
              {summary.security?.approvalRequired ? t('yes') : t('no')}
            </Badge>
          </div>
        </SummarySection>
      </div>

      {/* Estimated sync info */}
      <div className="rounded-lg border border-default bg-background-subtle p-4 text-center">
        <p className="text-sm font-medium text-foreground">
          {t('total_documents', {
            count: summary.totalDocuments,
            size: sizeStr,
          })}
        </p>
        <p className="text-xs text-muted mt-1">
          {t('estimated_sync_time', {
            minutes: summary.estimatedSyncMinutes,
          })}
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-default">
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onSaveAsDraft}>
            {t('btn_save_draft')}
          </Button>
          <Button
            variant="ghost"
            onClick={onExportTemplate}
            disabled
            title={t('export_disabled_tooltip')}
          >
            {t('btn_export_template')}
          </Button>
        </div>
        <Button onClick={() => setShowConfirm(true)} disabled={isSyncing}>
          {securityPending ? t('btn_submit_security') : t('btn_start_sync')}
        </Button>
      </div>

      {/* Confirmation Dialog */}
      <ConfirmDialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirmSync}
        title={t('confirm_title')}
        description={t('confirm_description', {
          count: summary.totalDocuments,
          size: sizeStr,
          minutes: summary.estimatedSyncMinutes,
        })}
        confirmLabel={securityPending ? t('btn_submit_security') : t('btn_start_sync')}
        variant="primary"
        loading={isSyncing}
      />
    </div>
  );
}

/** Internal helper: section wrapper */
function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-default bg-background-subtle p-4">
      <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">{title}</h4>
      <div className="divide-y divide-default">{children}</div>
    </div>
  );
}

/** Internal helper: key-value row */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}
