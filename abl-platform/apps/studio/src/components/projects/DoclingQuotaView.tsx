/**
 * Docling rate-limit view rendered inside ConnectionExpandPanel.
 *
 * Read-only summary of the per-tenant Docling rate limit. The connection
 * itself is the enable/disable binding — when the connection exists Docling
 * is enabled; deleting the connection disables it. There is no separate
 * toggle to keep in sync, so this view only surfaces operational info.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiFetch } from '../../lib/api-client';

interface DoclingQuotaSnapshot {
  limitPerMinute: number;
  burst: number;
  scope: string;
  enabled: boolean;
  binding: boolean;
}

interface QuotaResponse {
  success: boolean;
  data?: DoclingQuotaSnapshot;
  error?: { code?: string; message: string };
}

interface DoclingQuotaViewProps {
  projectId: string;
}

export function DoclingQuotaView({ projectId }: DoclingQuotaViewProps) {
  const t = useTranslations('integrations.docling');
  const [snapshot, setSnapshot] = useState<DoclingQuotaSnapshot | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/integrations/docling/quota`);
      const parsed = (await res.json()) as QuotaResponse;
      if (res.status === 404 && parsed.error?.code === 'FEATURE_DISABLED') {
        setHidden(true);
        return;
      }
      if (parsed.success && parsed.data) {
        setSnapshot(parsed.data);
      } else {
        setError(t('loadFailure'));
      }
    } catch {
      setError(t('loadFailure'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;
  if (loading) {
    return <p className="text-xs text-muted">{t('loading')}</p>;
  }
  if (!snapshot) {
    return error ? (
      <p role="alert" className="text-xs text-error">
        {error}
      </p>
    ) : null;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">
        {t('rateLimitInfo', { limitPerMinute: snapshot.limitPerMinute })}
      </p>
      {!snapshot.enabled && <p className="text-xs text-muted">{t('flagOffHint')}</p>}
    </div>
  );
}
