/**
 * EmergencyRevokeSection Component
 *
 * Danger zone with emergency revoke button, blast radius pre-check,
 * and TypeToConfirmInput confirmation.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { AlertOctagon } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../../ui/Button';
import { TypeToConfirmInput } from '../../../ui/TypeToConfirmInput';
import { apiFetch, handleResponse } from '../../../../lib/api-client';

interface EmergencyRevokeSectionProps {
  indexId: string;
  connectorId: string;
  connectorName: string;
  onRevoked: () => void;
}

interface BlastRadius {
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  permissionEntriesCount: number;
}

export function EmergencyRevokeSection({
  indexId,
  connectorId,
  connectorName,
  onRevoked,
}: EmergencyRevokeSectionProps) {
  const t = useTranslations('search_ai.sharepoint.security');

  const [showConfirm, setShowConfirm] = useState(false);
  const [blastRadius, setBlastRadius] = useState<BlastRadius | null>(null);
  const [loading, setLoading] = useState(false);

  const handleStartRevoke = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/security/blast-radius`,
      );
      const result = await handleResponse<{ data: BlastRadius }>(resp);
      setBlastRadius(result.data);
      setShowConfirm(true);
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('revoke_blast_error')));
    } finally {
      setLoading(false);
    }
  }, [indexId, connectorId, t]);

  const handleConfirmRevoke = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(
        `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/security/emergency-revoke`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmPhrase: connectorName }),
        },
      );
      await handleResponse(resp);
      toast.success(t('revoke_success'));
      setShowConfirm(false);
      onRevoked();
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('revoke_error')));
    } finally {
      setLoading(false);
    }
  }, [indexId, connectorId, connectorName, onRevoked, t]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-error flex items-center gap-2">
        <AlertOctagon className="w-4 h-4" />
        {t('revoke_title')}
      </h3>

      {!showConfirm ? (
        <div className="p-4 rounded-lg border border-error bg-error/5 space-y-3">
          <p className="text-sm text-foreground">{t('revoke_description')}</p>
          <Button
            variant="danger"
            size="sm"
            onClick={handleStartRevoke}
            loading={loading}
            disabled={loading}
          >
            {t('revoke_button')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {blastRadius && (
            <div className="p-3 rounded-lg bg-error/5 border border-error text-sm space-y-1">
              <p className="font-medium text-error">{t('revoke_blast_title')}</p>
              <p className="text-muted">
                {t('revoke_blast_docs', { count: blastRadius.documentCount })}
              </p>
              <p className="text-muted">
                {t('revoke_blast_chunks', { count: blastRadius.chunkCount })}
              </p>
            </div>
          )}
          <TypeToConfirmInput
            confirmText={connectorName}
            onConfirm={handleConfirmRevoke}
            onCancel={() => setShowConfirm(false)}
            warningMessage={t('revoke_warning')}
            consequences={[
              t('revoke_consequence_1'),
              t('revoke_consequence_2'),
              t('revoke_consequence_3'),
            ]}
            confirmLabel={t('revoke_confirm')}
            cancelLabel={t('revoke_cancel')}
            variant="danger"
            loading={loading}
          />
        </div>
      )}
    </div>
  );
}
