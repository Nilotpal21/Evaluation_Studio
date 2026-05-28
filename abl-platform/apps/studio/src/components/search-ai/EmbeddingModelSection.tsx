/**
 * EmbeddingModelSection
 *
 * Displays the current embedding model configuration for a knowledge base.
 * Allows changing the model via ChangeEmbeddingDialog with full re-indexing support.
 * Shows model info: provider, model ID, dimensions, and active status.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Box, AlertTriangle, ChevronDown } from 'lucide-react';
import { sanitizeError } from '@/lib/sanitize-error';
import { apiFetch } from '@/lib/api-client';
import { fetchEmbeddingProviders } from '@/api/pipelines';
import type { EmbeddingProviderInfo } from '@/api/pipelines';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { EmbeddingModelDialog } from './EmbeddingModelDialog';

// ─── Types ────────────────────────────────────────────────────────────────

interface EmbeddingModelStatus {
  provider: string;
  model: string;
  dimensions: number;
  type: 'self-hosted' | 'cloud';
  isActive: boolean;
  migrationStatus?: {
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    progress?: number;
    error?: string;
  };
}

interface EmbeddingModelSectionProps {
  indexId: string;
  projectId: string;
}

// ─── Component ────────────────────────────────────────────────────────────

export function EmbeddingModelSection({ indexId, projectId }: EmbeddingModelSectionProps) {
  const t = useTranslations('search_ai.embedding_model');
  const [status, setStatus] = useState<EmbeddingModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [embeddingProviders, setEmbeddingProviders] = useState<EmbeddingProviderInfo[] | null>(
    null,
  );
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [documentCount, setDocumentCount] = useState(0);

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiFetch(`/api/search-ai/indexes/${indexId}/embedding-model-status`);
      if (!res.ok) throw new Error(t('error_load'));
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(sanitizeError(err, t('error_load_config')));
    } finally {
      setLoading(false);
    }
  }, [indexId, t]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Load index details to get document count
  useEffect(() => {
    async function loadIndexDetails() {
      try {
        const res = await apiFetch(`/api/search-ai/indexes/${indexId}`);
        if (res.ok) {
          const data = await res.json();
          setDocumentCount(data.index?.documentCount ?? 0);
        }
      } catch {
        // Non-critical
      }
    }
    loadIndexDetails();
  }, [indexId]);

  // Load embedding providers when dialog opens
  async function handleOpenDialog() {
    setDialogOpen(true);
    if (!embeddingProviders) {
      setProvidersLoading(true);
      setProvidersError(null);
      try {
        const providers = await fetchEmbeddingProviders(projectId);
        setEmbeddingProviders(providers);
      } catch (err) {
        setProvidersError(sanitizeError(err, t('error_load_config')));
      } finally {
        setProvidersLoading(false);
      }
    }
  }

  async function handleConfirmChange(config: {
    provider: string;
    model: string;
    dimensions: number;
    providerConfig?: Record<string, unknown>;
  }) {
    try {
      setError(null);
      const res = await apiFetch(`/api/search-ai/indexes/${indexId}/embedding-model-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message ?? t('error_update'));
      }

      // Reload status to show migration in progress
      await loadStatus();
      setDialogOpen(false);
    } catch (err) {
      setError(sanitizeError(err, t('error_update')));
      throw err; // Re-throw so dialog knows it failed
    }
  }

  // ─── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Box className="w-4 h-4" />
          {t('loading')}
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="error">
        <AlertTriangle className="w-4 h-4" />
        <div>
          <div className="font-medium">{t('section_title')}</div>
          <div className="text-sm mt-1">{error}</div>
          <Button size="sm" variant="secondary" onClick={loadStatus} className="mt-2">
            {t('retry')}
          </Button>
        </div>
      </Alert>
    );
  }

  if (!status) return null;

  // ─── Migration Warning ──────────────────────────────────────────────────

  if (status.migrationStatus && status.migrationStatus.status !== 'completed') {
    const { status: migStatus, progress, error: migError } = status.migrationStatus;

    return (
      <div className="space-y-3">
        <SectionHeader />
        <Alert variant={migStatus === 'failed' ? 'error' : 'warning'}>
          <AlertTriangle className="w-4 h-4" />
          <div className="flex-1">
            <div className="font-medium">
              {migStatus === 'in_progress' && t('migration_in_progress_title')}
              {migStatus === 'pending' && t('migration_pending_title')}
              {migStatus === 'failed' && t('migration_failed_title')}
            </div>
            {progress !== undefined && (
              <div className="text-sm mt-1">
                {t('migration_progress', { progress: Math.round(progress * 100) })}
              </div>
            )}
            {migError && (
              <div className="text-sm mt-1 text-error">
                {t('migration_error', { error: migError })}
              </div>
            )}
          </div>
        </Alert>
      </div>
    );
  }

  // ─── Normal State: Model Configured ─────────────────────────────────────

  const providerLabel = getProviderLabel(status.provider);
  const typeLabel = status.type === 'self-hosted' ? t('type_self_hosted') : t('type_cloud');

  return (
    <div className="space-y-3">
      <SectionHeader />
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Box className="w-5 h-5 text-accent mt-0.5 shrink-0" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{providerLabel}</span>
                <Badge variant="default">{status.model}</Badge>
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted">
                <span>
                  {t('label_type')}: {typeLabel}
                </span>
                <span>&middot;</span>
                <span>
                  {t('label_dimensions')}: {status.dimensions}
                </span>
                <span>&middot;</span>
                <Badge variant="success" dot>
                  {t('badge_active')}
                </Badge>
              </div>
              <div className="mt-2 text-xs text-muted">{t('used_for')}</div>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={handleOpenDialog}>
            {t('change')}
            <ChevronDown className="w-3 h-3 ml-1" />
          </Button>
        </div>

        {/* Warning about re-ingestion */}
        <div className="mt-4 pt-3 border-t border-border">
          <div className="flex items-start gap-2 p-3 text-sm text-warning bg-warning-subtle rounded-md">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{t('reindex_warning_title')}</p>
              <p className="mt-1 text-xs">{t('reindex_warning_description')}</p>
            </div>
          </div>
        </div>
      </Card>

      {/* Embedding Model Dialog */}
      {status && (
        <EmbeddingModelDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onConfirm={handleConfirmChange}
          currentConfig={{
            provider: status.provider,
            model: status.model,
            dimensions: status.dimensions,
          }}
          embeddingProviders={embeddingProviders}
          loading={providersLoading}
          error={providersError || error}
          documentCount={documentCount}
          projectId={projectId}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function SectionHeader() {
  const t = useTranslations('search_ai.embedding_model');
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{t('section_title')}</h3>
      <p className="text-xs text-muted mt-0.5">{t('section_description')}</p>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    'bge-m3': 'BGE-M3',
    openai: 'OpenAI',
    cohere: 'Cohere',
    custom: 'Custom',
  };
  return labels[provider] ?? provider;
}
