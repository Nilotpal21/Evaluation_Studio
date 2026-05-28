'use client';

/**
 * PreviewPanel — Inline extraction preview for a single URL.
 *
 * Shows title, excerpt, word/image counts, noise reduction stats,
 * and a JS rendering advisory when applicable.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { X, AlertTriangle, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '../../ui/Button';
import { previewExtraction } from '@/api/crawl';
import type { PreviewResponse } from '@/api/crawl';

interface PreviewPanelProps {
  url: string;
  baseUrl: string;
  onClose: () => void;
  /** Called when preview loads successfully — parent caches full response data */
  onLoaded?: (data: PreviewResponse['data']) => void;
  /** If cached data exists, skip the fetch and render directly */
  cached?: PreviewResponse['data'] | null;
}

/** Skeleton shimmer block */
function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx('animate-pulse rounded bg-background-muted', className)}
      aria-hidden="true"
    />
  );
}

export function PreviewPanel({ url, baseUrl, onClose, onLoaded, cached }: PreviewPanelProps) {
  const t = useTranslations('search_ai.crawl_flow');

  const [data, setData] = useState<PreviewResponse['data'] | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await previewExtraction(url, baseUrl);
      setData(result);
      onLoaded?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [url, baseUrl, onLoaded]);

  useEffect(() => {
    if (!cached) {
      void fetchPreview();
    }
    // Only fetch on mount (or when url/baseUrl change)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, baseUrl]);

  // ─── Loading state ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-background-subtle border border-default rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{t('preview_loading')}</span>
          <button
            onClick={onClose}
            className="p-1 text-muted hover:text-foreground transition-default rounded"
            aria-label={t('cancel')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  }

  // ─── Error state ────────────────────────────────────────────────
  if (error) {
    return (
      <div className="bg-background-subtle border border-default rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-error font-medium">{t('preview_error')}</span>
          <button
            onClick={onClose}
            className="p-1 text-muted hover:text-foreground transition-default rounded"
            aria-label={t('cancel')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-xs text-muted mb-3">{t('preview_fetch_failed')}</p>
        <Button variant="secondary" size="xs" onClick={() => void fetchPreview()}>
          <RefreshCw className="w-3 h-3" />
          {t('preview_retry')}
        </Button>
      </div>
    );
  }

  // ─── Success state ──────────────────────────────────────────────
  if (!data) return null;

  const excerpt = data.excerpt.length > 500 ? data.excerpt.slice(0, 500) + '…' : data.excerpt;

  return (
    <div className="bg-background-subtle border border-default rounded-lg p-4 space-y-3">
      {/* Header with close button */}
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-foreground font-medium text-sm leading-snug">{data.title}</h4>
        <button
          onClick={onClose}
          className="p-1 text-muted hover:text-foreground transition-default rounded shrink-0"
          aria-label={t('cancel')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Excerpt */}
      <p className="text-muted text-sm leading-relaxed">{excerpt}</p>

      {/* Stats bar */}
      <div className="text-muted text-xs flex items-center gap-1.5">
        <span>{t('preview_stats_words', { count: data.wordCount.toLocaleString() })}</span>
        <span aria-hidden="true">·</span>
        <span>{t('preview_stats_images', { count: data.imageCount })}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t('preview_stats_noise', { percent: Math.round(data.metadata.sizeReduction) })}
        </span>
      </div>

      {/* JS rendering advisory */}
      {data.jsRenderingAdvised && (
        <div className="flex items-center gap-1.5 text-warning bg-warning/10 rounded px-2 py-1 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t('preview_js_advisory')}</span>
        </div>
      )}

      {/* Indexed label */}
      <p className="text-muted text-xs">{t('preview_indexed_label')}</p>
    </div>
  );
}
