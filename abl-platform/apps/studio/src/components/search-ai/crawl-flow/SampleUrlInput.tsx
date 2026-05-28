'use client';

/**
 * SampleUrlInput — Discovery gap messaging + sample URL input
 *
 * Shows contextual messaging based on sitemap results (what was found,
 * what's likely missing, what the user can do about it). Connects the
 * input to the section list below and explains how the backend uses
 * the provided URLs.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X, ExternalLink, Info, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

const MAX_SAMPLES = 3;

interface SampleUrlInputProps {
  /** Current sample URLs */
  sampleUrls: string[];
  /** Called when user modifies the list */
  onChange: (urls: string[]) => void;
  /** When true, inputs become read-only chips (during discovery) */
  readOnly?: boolean;
  /** Called when user clicks "Edit" in read-only mode to pause discovery */
  onEdit?: () => void;
  /** Per-input validation errors (array of string|null or Record<index, string>) */
  inputErrors?: Record<number, string> | (string | null)[];
  /** Whether this is inside the explore panel (slightly different context copy) */
  variant?: 'analysis' | 'explore';
  /** Existing page count from sitemap (for context message) */
  sitemapPageCount?: number;
  /** Existing section count from sitemap (for context message) */
  sitemapSectionCount?: number;
  /** Domain name for dynamic placeholder (e.g. "epson.com") */
  domain?: string;
}

/** Determine gap severity from sitemap results */
function getGapLevel(
  pageCount: number | undefined,
  sectionCount: number | undefined,
): 'strong' | 'medium' | 'soft' {
  if (pageCount == null || sectionCount == null) return 'soft';
  if (pageCount < 20 && sectionCount <= 1) return 'strong';
  if (pageCount < 100 && sectionCount <= 3) return 'medium';
  return 'soft';
}

export function SampleUrlInput({
  sampleUrls,
  onChange,
  readOnly = false,
  onEdit,
  inputErrors = {},
  variant = 'analysis',
  sitemapPageCount,
  sitemapSectionCount,
  domain,
}: SampleUrlInputProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  // Normalize inputErrors to Record<number, string>
  const errors: Record<number, string> = {};
  if (inputErrors) {
    if (Array.isArray(inputErrors)) {
      inputErrors.forEach((err, idx) => {
        if (err) errors[idx] = err;
      });
    } else {
      Object.assign(errors, inputErrors);
    }
  }

  const handleAdd = () => {
    if (sampleUrls.length < MAX_SAMPLES) {
      onChange([...sampleUrls, '']);
    }
  };

  const handleRemove = (idx: number) => {
    onChange(sampleUrls.filter((_, i) => i !== idx));
  };

  const handleChange = (idx: number, value: string) => {
    onChange(sampleUrls.map((v, i) => (i === idx ? value : v)));
  };

  const gapLevel = getGapLevel(sitemapPageCount, sitemapSectionCount);
  const hasSitemapData = sitemapPageCount != null && sitemapPageCount > 0;

  // Dynamic placeholder using real domain
  const placeholder = domain
    ? t('sample_url_placeholder_domain', { domain })
    : t('sample_url_placeholder');

  // Read-only chip display during discovery
  if (readOnly) {
    const filledUrls = sampleUrls.filter((u) => u.trim());
    if (filledUrls.length === 0) return null;

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground">{t('discover_more_pages')}</h4>
          {onEdit && (
            <button
              onClick={onEdit}
              className="text-xs text-accent hover:text-accent/80 font-medium transition-default"
            >
              {t('sample_edit')}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {filledUrls.map((url, idx) => (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-background-muted px-2.5 py-1 text-xs text-foreground hover:bg-background-elevated transition-default max-w-xs truncate"
              title={url}
            >
              <span className="truncate">{url}</span>
              <ExternalLink className="w-3 h-3 flex-shrink-0 text-muted" />
            </a>
          ))}
        </div>
      </div>
    );
  }

  // Editable input display
  return (
    <div className="space-y-3">
      {/* Part 1: Heading */}
      <h4 className="text-sm font-semibold text-foreground">{t('discover_more_pages')}</h4>

      {/* Part 2: Context — what the sitemap found */}
      {hasSitemapData && (
        <p className="text-sm text-muted">
          {t('sample_context_what_found', {
            pages: sitemapPageCount.toString(),
            sections: (sitemapSectionCount ?? 0).toString(),
          })}
        </p>
      )}

      {/* Part 3: Gap signal — what's likely missing (conditional on severity) */}
      {variant === 'analysis' && (
        <p className="text-sm text-muted">
          {gapLevel === 'strong'
            ? t('sample_gap_strong')
            : gapLevel === 'medium'
              ? t('sample_gap_medium')
              : hasSitemapData
                ? t('sample_gap_soft')
                : t('sample_gap_no_sitemap')}
        </p>
      )}

      {/* Part 4: Action — what to do */}
      <p className="text-sm text-foreground">{t('sample_action_prompt')}</p>

      {/* URL inputs */}
      <div className="space-y-2">
        {sampleUrls.map((url, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <div className="flex-1">
              <input
                type="url"
                value={url}
                onChange={(e) => handleChange(idx, e.target.value)}
                placeholder={placeholder}
                className={clsx(
                  'w-full rounded-lg border bg-background text-foreground placeholder:text-subtle',
                  'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                  'text-sm py-2 px-3 font-mono',
                  errors[idx] ? 'border-error' : 'border-default',
                )}
              />
              {errors[idx] && <p className="text-xs text-error mt-0.5">{errors[idx]}</p>}
            </div>
            {url.trim() && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 text-muted hover:text-accent rounded transition-default mt-0.5"
                title={t('sample_open_tab')}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {sampleUrls.length > 1 && (
              <button
                onClick={() => handleRemove(idx)}
                className="p-2 text-muted hover:text-foreground rounded transition-default mt-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}

        {sampleUrls.length < MAX_SAMPLES && (
          <button
            onClick={handleAdd}
            className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-default"
          >
            <Plus className="w-3 h-3" />
            {t('sample_url_add')}
          </button>
        )}
      </div>

      {/* How it works — collapsible for power users */}
      <button
        onClick={() => setHowItWorksOpen(!howItWorksOpen)}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground transition-default"
      >
        <Info className="w-3 h-3" />
        {t('sample_how_it_works_toggle')}
        <ChevronDown
          className={clsx('w-3 h-3 transition-transform', howItWorksOpen && 'rotate-180')}
        />
      </button>
      {howItWorksOpen && (
        <p className="text-xs text-muted pl-4.5 border-l-2 border-default">
          {t('sample_how_it_works_detail')}
        </p>
      )}
    </div>
  );
}
