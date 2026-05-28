/**
 * ConfigDriftSection Component
 *
 * Shows template drift when detected. Hidden when no drift exists.
 * Provides actions: Re-apply Template, Update Template, Ignore Drift.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { DataTable, type Column } from '../../../ui/DataTable';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { useConfigDrift } from '../../../../hooks/useConfigDrift';
import { apiFetch, handleResponse } from '../../../../lib/api-client';

interface ConfigDriftSectionProps {
  indexId: string;
  connectorId: string;
  onDriftResolved: () => void;
}

interface Deviation {
  field: string;
  templateValue: unknown;
  currentValue: unknown;
  deviatedAtVersion: string;
}

export function ConfigDriftSection({
  indexId,
  connectorId,
  onDriftResolved,
}: ConfigDriftSectionProps) {
  const t = useTranslations('search_ai.sharepoint.config.drift');
  const { drift, isLoading, mutate } = useConfigDrift(indexId, connectorId);

  const [confirmAction, setConfirmAction] = useState<'reapply' | 'update' | 'ignore' | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const handleAction = useCallback(
    async (action: 'reapply' | 'update' | 'ignore') => {
      setActionLoading(true);
      const endpoint =
        action === 'reapply'
          ? 'drift/reapply-template'
          : action === 'update'
            ? 'drift/update-template'
            : 'drift/ignore';

      try {
        const resp = await apiFetch(
          `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/config/${endpoint}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        );
        await handleResponse(resp);
        toast.success(t(`action_${action}_success`));
        setConfirmAction(null);
        mutate();
        onDriftResolved();
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('action_error')));
      } finally {
        setActionLoading(false);
      }
    },
    [indexId, connectorId, mutate, onDriftResolved, t],
  );

  // Do not render when no drift or template deleted
  if (isLoading || !drift || !drift.hasDrift) return null;

  const templateDeleted = drift.templateName === null;

  const columns: Column<Deviation>[] = [
    {
      key: 'field',
      label: t('col_field'),
      render: (row) => <span className="font-mono text-sm">{row.field}</span>,
    },
    {
      key: 'templateValue',
      label: t('col_template_value'),
      render: (row) => (
        <pre className="text-xs text-muted font-mono whitespace-pre-wrap max-w-[200px]">
          {row.templateValue === undefined ? '—' : JSON.stringify(row.templateValue, null, 2)}
        </pre>
      ),
    },
    {
      key: 'currentValue',
      label: t('col_current_value'),
      render: (row) => (
        <pre className="text-xs text-foreground font-mono whitespace-pre-wrap max-w-[200px]">
          {row.currentValue === undefined ? '—' : JSON.stringify(row.currentValue, null, 2)}
        </pre>
      ),
    },
  ];

  return (
    <div className="rounded-lg border border-warning bg-warning/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning" />
        <span className="text-sm font-semibold text-foreground">{t('title')}</span>
        {drift.templateName && <Badge variant="warning">{drift.templateName}</Badge>}
      </div>

      {templateDeleted && <p className="text-sm text-muted">{t('template_deleted')}</p>}

      {drift.deviations.length > 0 && (
        <div className="rounded-lg border border-default overflow-hidden">
          <DataTable columns={columns} data={drift.deviations} keyExtractor={(row) => row.field} />
        </div>
      )}

      <div className="flex items-center gap-2">
        {!templateDeleted && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmAction('reapply')}
              disabled={actionLoading}
            >
              {t('action_reapply')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmAction('update')}
              disabled={actionLoading}
            >
              {t('action_update')}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmAction('ignore')}
          disabled={actionLoading}
        >
          {t('action_ignore')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction && handleAction(confirmAction)}
        title={t(`confirm_${confirmAction ?? 'ignore'}_title`)}
        description={t(`confirm_${confirmAction ?? 'ignore'}_description`)}
        confirmLabel={t(`confirm_${confirmAction ?? 'ignore'}_button`)}
        variant={confirmAction === 'reapply' ? 'danger' : 'primary'}
        loading={actionLoading}
      />
    </div>
  );
}
