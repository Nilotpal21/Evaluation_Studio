/**
 * ContentPurgeDialog Component
 *
 * Multi-step dialog for content purge: confirm → progress → complete/failed.
 * Polls backend for progress updates.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { TypeToConfirmInput } from '../../../ui/TypeToConfirmInput';
import { apiFetch, handleResponse } from '../../../../lib/api-client';

interface ContentPurgeDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  connectorId: string;
  connectorName: string;
  documentCount: number;
  onPurgeComplete: () => void;
}

type PurgeStep = 'confirm' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

interface CleanupStatus {
  cleanupId: string;
  status: PurgeStep;
  documents: { total: number; removed: number };
  chunks: { total: number; removed: number };
  vectorEmbeddings: { total: number; removed: number };
  estimatedTimeRemaining: number | null;
  error: string | null;
}

function ProgressBar({ label, removed, total }: { label: string; removed: number; total: number }) {
  const pct = total > 0 ? Math.round((removed / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <span>
          {removed.toLocaleString()} / {total.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="h-2 bg-background-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-300 rounded-full"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ContentPurgeDialog({
  open,
  onClose,
  indexId,
  connectorId,
  connectorName,
  documentCount,
  onPurgeComplete,
}: ContentPurgeDialogProps) {
  const t = useTranslations('search_ai.sharepoint.config.purge');

  const [step, setStep] = useState<PurgeStep>('confirm');
  const [cleanupId, setCleanupId] = useState<string | null>(null);
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear poll on close or terminal state
  useEffect(() => {
    if (!open) {
      if (pollRef.current) clearInterval(pollRef.current);
      setStep('confirm');
      setCleanupId(null);
      setStatus(null);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open]);

  const startPoll = useCallback(
    (cId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const resp = await apiFetch(
            `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/content/purge/${cId}`,
          );
          const result = await handleResponse<{ data: CleanupStatus }>(resp);
          setStatus(result.data);
          if (['completed', 'failed', 'cancelled'].includes(result.data.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            setStep(result.data.status as PurgeStep);
            if (result.data.status === 'completed') {
              onPurgeComplete();
            }
          }
        } catch {
          // Poll failure — will retry on next interval
        }
      }, 2000);
    },
    [indexId, connectorId, onPurgeComplete],
  );

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/content/purge`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const result = await handleResponse<{ data: { cleanupId: string } }>(resp);
      setCleanupId(result.data.cleanupId);
      setStep('in_progress');
      startPoll(result.data.cleanupId);
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('start_error')));
    } finally {
      setLoading(false);
    }
  }, [indexId, connectorId, startPoll, t]);

  const handleCancel = useCallback(async () => {
    if (!cleanupId) return;
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/content/purge/${cleanupId}/cancel`,
        { method: 'POST' },
      );
      await handleResponse(resp);
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('cancel_error')));
    }
  }, [indexId, connectorId, cleanupId, t]);

  const handleRetry = useCallback(async () => {
    if (!cleanupId) return;
    setLoading(true);
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/content/purge/${cleanupId}/retry`,
        { method: 'POST' },
      );
      await handleResponse(resp);
      setStep('in_progress');
      startPoll(cleanupId);
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('retry_error')));
    } finally {
      setLoading(false);
    }
  }, [indexId, connectorId, cleanupId, startPoll, t]);

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="md">
      <div className="space-y-4">
        {step === 'confirm' && (
          <>
            <p className="text-sm text-foreground">{t('confirm_message')}</p>
            <p className="text-sm text-muted">{t('confirm_doc_count', { count: documentCount })}</p>
            <TypeToConfirmInput
              confirmText={connectorName}
              onConfirm={handleConfirm}
              onCancel={onClose}
              warningMessage={t('confirm_warning')}
              consequences={[t('confirm_consequence_1'), t('confirm_consequence_2')]}
              confirmLabel={t('confirm_button')}
              cancelLabel={t('cancel_button')}
              variant="danger"
              loading={loading}
            />
          </>
        )}

        {step === 'in_progress' && status && (
          <div className="space-y-4">
            <ProgressBar
              label={t('progress_docs')}
              removed={status.documents.removed}
              total={status.documents.total}
            />
            <ProgressBar
              label={t('progress_chunks')}
              removed={status.chunks.removed}
              total={status.chunks.total}
            />
            <ProgressBar
              label={t('progress_embeddings')}
              removed={status.vectorEmbeddings.removed}
              total={status.vectorEmbeddings.total}
            />
            {status.estimatedTimeRemaining !== null && (
              <p className="text-xs text-muted">
                {t('progress_eta', { seconds: status.estimatedTimeRemaining })}
              </p>
            )}
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              {t('cancel_cleanup')}
            </Button>
          </div>
        )}

        {step === 'in_progress' && !status && (
          <p className="text-sm text-muted">{t('progress_starting')}</p>
        )}

        {step === 'completed' && (
          <div className="space-y-3">
            <p className="text-sm text-success font-medium">{t('completed_message')}</p>
            {status && (
              <p className="text-xs text-muted">
                {t('completed_stats', {
                  docs: status.documents.removed,
                  chunks: status.chunks.removed,
                })}
              </p>
            )}
            <Button variant="primary" size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          </div>
        )}

        {step === 'failed' && (
          <div className="space-y-3">
            <p className="text-sm text-error font-medium">{t('failed_message')}</p>
            {status?.error && <p className="text-xs text-muted">{status.error}</p>}
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleRetry}
                loading={loading}
                disabled={loading}
              >
                {t('retry')}
              </Button>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t('close')}
              </Button>
            </div>
          </div>
        )}

        {step === 'cancelled' && (
          <div className="space-y-3">
            <p className="text-sm text-warning font-medium">{t('cancelled_message')}</p>
            {status && (
              <p className="text-xs text-muted">
                {t('cancelled_stats', {
                  docs: status.documents.removed,
                  chunks: status.chunks.removed,
                })}
              </p>
            )}
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
