/**
 * BulkImportForm Component
 *
 * Form for starting a bulk HTTP import (Flow 2c).
 * Flow: Paste URLs -> pick strategy -> set max pages -> start import.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Zap } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { addSource, deleteSource } from '../../api/search-ai';
import { submitBatchCrawl } from '../../api/crawl';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BulkImportFormProps {
  indexId: string;
  onJobStarted: (jobId: string, sourceId: string, name: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BulkImportForm({ indexId, onJobStarted }: BulkImportFormProps) {
  const t = useTranslations('search_ai.crawl_site');

  // Form state
  const [rawUrls, setRawUrls] = useState('');
  const [strategy, setStrategy] = useState('smart');
  const [maxPages, setMaxPages] = useState(500);

  // Submission
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Strategy options (requires t() so built inside component)
  // ---------------------------------------------------------------------------

  const strategyOptions = useMemo(
    () => [
      { value: 'smart', label: t('strategy_smart') },
      { value: 'sitemap', label: t('strategy_sitemap') },
      { value: 'limited', label: t('strategy_limited') },
      { value: 'full', label: t('strategy_full') },
    ],
    [t],
  );

  const reportCleanupFailure = useCallback(
    (cleanupErr: unknown) => {
      console.error('[BulkImportForm] Failed to delete orphaned source:', cleanupErr);
      toast.error(sanitizeError(cleanupErr, t('bulk_import_failed')));
    },
    [t],
  );

  // ---------------------------------------------------------------------------
  // Parse URLs from textarea
  // ---------------------------------------------------------------------------

  const parseUrls = useCallback((raw: string): string[] => {
    return raw
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => {
        try {
          const parsed = new URL(u);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      // 1. Parse URLs
      const urls = parseUrls(rawUrls);
      if (urls.length === 0) {
        setError(t('bulk_no_valid_urls'));
        return;
      }

      // 2. Create SearchSource (same pattern as CrawlerTab)
      let domain: string;
      try {
        domain = new URL(urls[0]).hostname;
      } catch {
        domain = 'bulk-import';
      }

      const { source } = await addSource(indexId, {
        name: domain,
        sourceType: 'web',
      });

      const sourceId = source?._id;
      if (!sourceId) {
        setError(t('bulk_source_failed'));
        return;
      }

      // 3. Submit batch crawl
      let response;
      try {
        response = await submitBatchCrawl({
          urls,
          indexId,
          sourceId,
          strategy,
          limits: { maxPages },
        });
      } catch (batchErr) {
        // Batch failed — cleanup orphaned source
        await deleteSource(indexId, sourceId).catch(reportCleanupFailure);
        throw batchErr;
      }

      if (response.needsUserInput && response.questions) {
        // Bulk import is for fast HTTP — if site needs complex config,
        // cleanup source and suggest Crawl Website mode.
        toast.warning(t('bulk_hint'));
        await deleteSource(indexId, sourceId).catch(reportCleanupFailure);
        return;
      }

      if (response.jobId) {
        onJobStarted(response.jobId, sourceId, domain);
      }
    } catch (err: unknown) {
      const message = sanitizeError(err, t('bulk_import_failed'));
      setError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [rawUrls, strategy, maxPages, indexId, onJobStarted, parseUrls, reportCleanupFailure, t]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const hasUrls = parseUrls(rawUrls).length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* URL Textarea */}
      <div className="space-y-1.5">
        <label htmlFor="bulk-urls-input" className="block text-sm font-medium text-foreground">
          {t('urls_label')}
        </label>
        <textarea
          id="bulk-urls-input"
          value={rawUrls}
          onChange={(e) => {
            setRawUrls(e.target.value);
            setError(null);
          }}
          placeholder={t('urls_placeholder')}
          rows={6}
          className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3"
          data-testid="bulk-urls-textarea"
        />
      </div>

      {/* Strategy + Max Pages */}
      <div className="grid grid-cols-2 gap-3">
        <Select
          label={t('strategy_label')}
          options={strategyOptions}
          value={strategy}
          onChange={(v) => setStrategy(v)}
        />
        <Input
          label={t('max_pages_bulk')}
          type="number"
          value={String(maxPages)}
          onChange={(e) => setMaxPages(Number(e.target.value))}
          min={1}
          max={50000}
        />
      </div>

      {/* Info text */}
      <div className="flex items-start gap-2 text-xs text-muted">
        <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <div>
          <p>{t('bulk_info')}</p>
          <p className="text-subtle">{t('bulk_hint')}</p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-error" data-testid="bulk-import-error">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!hasUrls || isSubmitting}
          loading={isSubmitting}
        >
          {t('start_import')}
        </Button>
      </div>
    </div>
  );
}
