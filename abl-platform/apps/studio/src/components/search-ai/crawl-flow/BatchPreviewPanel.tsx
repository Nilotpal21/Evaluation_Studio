'use client';

/**
 * BatchPreviewPanel — Multi-page extraction preview for Step 3 (Configure).
 *
 * Auto-selects 2-3 representative URLs from included sections via `pickPreviewUrls`,
 * calls `previewExtraction` for each, and renders results sequentially as they arrive.
 * Users can swap the auto-selected URL for any page in that section via a dropdown.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { clsx } from 'clsx';
import { previewExtraction } from '@/api/crawl';
import type { PreviewResponse } from '@/api/crawl';
import type { CrawlSection, RenderingMode } from './types';
import { pickPreviewUrls } from './discovery';

/** Number of quality segments in the quality bar */
const QUALITY_SEGMENTS = 5;

interface BatchPreviewPanelProps {
  sections: CrawlSection[];
  baseUrl: string;
  renderingMode: RenderingMode;
}

interface PreviewEntry {
  sectionId: string;
  sectionName: string;
  url: string;
  data: PreviewResponse['data'] | null;
  loading: boolean;
  error: string | null;
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

/** Quality bar — 5 segments, filled based on word count thresholds */
function QualityBar({ wordCount }: { wordCount: number }) {
  // Map word count to a 0-5 score
  // 0-50 words = 1, 50-200 = 2, 200-500 = 3, 500-1000 = 4, 1000+ = 5
  const thresholds = [50, 200, 500, 1000];
  let filled = 1;
  for (const threshold of thresholds) {
    if (wordCount >= threshold) filled++;
  }

  return (
    <div
      className="flex items-center gap-0.5"
      aria-label={`Quality: ${filled} of ${QUALITY_SEGMENTS}`}
    >
      {Array.from({ length: QUALITY_SEGMENTS }, (_, i) => (
        <div
          key={i}
          className={clsx('h-2 w-4 rounded-sm', i < filled ? 'bg-success' : 'bg-background-muted')}
        />
      ))}
    </div>
  );
}

export function BatchPreviewPanel({ sections, baseUrl, renderingMode }: BatchPreviewPanelProps) {
  const t = useTranslations('search_ai.crawl_flow');

  // Build section lookup for dropdown candidates
  const sectionMap = useMemo(() => {
    const map = new Map<string, CrawlSection>();
    for (const s of sections) {
      map.set(s.sectionId ?? s.pattern, s);
    }
    return map;
  }, [sections]);

  // Initial sample URLs
  const initialSamples = useMemo(() => pickPreviewUrls(sections), [sections]);

  // Preview entries state
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const fetchedRef = useRef<Set<string>>(new Set());

  // Initialize entries from picked URLs
  useEffect(() => {
    const initial: PreviewEntry[] = initialSamples.map((sample) => {
      const section = sectionMap.get(sample.sectionId);
      return {
        sectionId: sample.sectionId,
        sectionName: section?.name ?? sample.sectionId,
        url: sample.url,
        data: null,
        loading: true,
        error: null,
      };
    });
    setEntries(initial);
    fetchedRef.current = new Set();
  }, [initialSamples, sectionMap]);

  // Fetch previews sequentially with retry on rate-limit (429)
  const fetchPreview = useCallback(
    async (url: string, sectionId: string) => {
      const key = `${sectionId}:${url}`;
      if (fetchedRef.current.has(key)) return;
      fetchedRef.current.add(key);

      const MAX_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await previewExtraction(url, baseUrl);
          setEntries((prev) =>
            prev.map((e) =>
              e.sectionId === sectionId && e.url === url
                ? { ...e, data: result, loading: false, error: null }
                : e,
            ),
          );
          return; // success — exit retry loop
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const isRateLimit = msg.includes('Rate limit') || msg.includes('429');

          // Retry on rate-limit with exponential backoff
          if (isRateLimit && attempt < MAX_RETRIES) {
            const backoffMs = (attempt + 1) * 5_000; // 5s, 10s
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          setEntries((prev) =>
            prev.map((e) =>
              e.sectionId === sectionId && e.url === url ? { ...e, loading: false, error: msg } : e,
            ),
          );
        }
      }
    },
    [baseUrl],
  );

  // Trigger sequential fetches
  useEffect(() => {
    let cancelled = false;
    async function runSequential() {
      for (const entry of entries) {
        if (cancelled) break;
        if (entry.loading && !entry.data && !entry.error) {
          await fetchPreview(entry.url, entry.sectionId);
        }
      }
    }
    void runSequential();
    return () => {
      cancelled = true;
    };
  }, [entries, fetchPreview]);

  // Handle URL swap for a section
  const handleUrlSwap = useCallback((sectionId: string, newUrl: string) => {
    fetchedRef.current.delete(`${sectionId}:${newUrl}`);
    setEntries((prev) =>
      prev.map((e) =>
        e.sectionId === sectionId
          ? { ...e, url: newUrl, data: null, loading: true, error: null }
          : e,
      ),
    );
  }, []);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-foreground">{t('batch_preview_title')}</h4>
        <span className="text-xs text-muted">
          {t('batch_preview_rendering', { mode: renderingMode })}
        </span>
      </div>

      <div className="space-y-2">
        {entries.map((entry) => (
          <PreviewCard
            key={entry.sectionId}
            entry={entry}
            section={sectionMap.get(entry.sectionId) ?? null}
            onUrlSwap={(url) => handleUrlSwap(entry.sectionId, url)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Preview Card Sub-component ─────────────────────────────────────────

function PreviewCard({
  entry,
  section,
  onUrlSwap,
  t,
}: {
  entry: PreviewEntry;
  section: CrawlSection | null;
  onUrlSwap: (url: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Candidate URLs for this section
  const candidates = useMemo(() => {
    if (!section) return [];
    const urls: string[] = [];
    if (section.pages && section.pages.length > 0) {
      urls.push(...section.pages.map((p) => p.url));
    } else if (section.examples && section.examples.length > 0) {
      urls.push(...section.examples);
    }
    return urls;
  }, [section]);

  // Loading skeleton
  if (entry.loading) {
    return (
      <div className="rounded-lg border border-default bg-background-subtle p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">{entry.sectionName}</span>
          <span className="text-xs text-muted">{t('preview_loading')}</span>
        </div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    );
  }

  // Error state
  if (entry.error) {
    return (
      <div className="rounded-lg border border-default bg-background-subtle p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">{entry.sectionName}</span>
          <span className="text-xs text-error">{t('preview_error')}</span>
        </div>
        <p className="text-xs text-muted mt-1">{t('preview_fetch_failed')}</p>
      </div>
    );
  }

  // Success state
  if (!entry.data) return null;

  const excerpt =
    entry.data.excerpt.length > 300 ? entry.data.excerpt.slice(0, 300) + '…' : entry.data.excerpt;

  return (
    <div className="rounded-lg border border-default bg-background-subtle p-4 space-y-2">
      {/* Section header + URL dropdown */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{entry.sectionName}</span>
        <div className="flex items-center gap-2">
          <QualityBar wordCount={entry.data.wordCount} />
          {candidates.length > 1 && (
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="text-xs text-accent hover:text-accent/80 flex items-center gap-0.5 transition-default"
              aria-label={t('batch_preview_swap')}
            >
              {dropdownOpen ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* URL dropdown */}
      {dropdownOpen && candidates.length > 1 && (
        <div className="max-h-32 overflow-y-auto rounded border border-default bg-background-elevated p-1 space-y-0.5">
          {candidates.map((url) => (
            <button
              key={url}
              onClick={() => {
                onUrlSwap(url);
                setDropdownOpen(false);
              }}
              className={clsx(
                'w-full text-left text-xs px-2 py-1 rounded truncate transition-default',
                url === entry.url
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-muted hover:bg-background-muted hover:text-foreground',
              )}
              title={url}
            >
              {url}
            </button>
          ))}
        </div>
      )}

      {/* Title + excerpt */}
      <h5 className="text-sm font-medium text-foreground leading-snug">{entry.data.title}</h5>
      <p className="text-xs text-muted leading-relaxed">{excerpt}</p>

      {/* Stats */}
      <div className="text-xs text-muted flex items-center gap-1.5">
        <span>{t('preview_stats_words', { count: entry.data.wordCount.toLocaleString() })}</span>
        <span aria-hidden="true">&middot;</span>
        <span>{t('preview_stats_images', { count: entry.data.imageCount })}</span>
        <span aria-hidden="true">&middot;</span>
        <span>
          {t('preview_stats_noise', { percent: Math.round(entry.data.metadata.sizeReduction) })}
        </span>
      </div>

      {/* JS rendering advisory */}
      {entry.data.jsRenderingAdvised && (
        <div className="flex items-center gap-1.5 text-warning bg-warning/10 rounded px-2 py-1 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t('preview_js_advisory')}</span>
        </div>
      )}
    </div>
  );
}
