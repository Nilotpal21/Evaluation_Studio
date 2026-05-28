'use client';

/**
 * State 3 — Crawl Configuration
 *
 * Crawl scope radio cards, settings groups, and Start Crawl action bar.
 */

import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Zap,
  Brain,
  Timer,
  Lock,
  Sparkles,
  Copy,
  Cookie,
  Eye,
  ArrowDownToLine,
  ShieldCheck,
  AlertTriangle,
  FileText,
  Loader2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Select } from '../../ui/Select';
import { PreviewPanel } from './PreviewPanel';
import { BatchPreviewPanel } from './BatchPreviewPanel';
import type { PreviewResponse } from '@/api/crawl';
import { analyzeRobotsTxt } from '@/api/crawl';
import type { RobotsTxtAnalysisResult } from '@/api/crawl';
import type {
  State3ConfigureProps,
  CrawlScope,
  RenderingMode,
  CleanupLevel,
  CrawlConfig,
} from './types';

/** Format number with thousands separators */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Estimate crawl time from page count */
function estimateTime(pages: number): string {
  const seconds = pages * 2;
  if (seconds < 60) return `${seconds}s`;
  return `~${Math.ceil(seconds / 60)}m`;
}

/** Max simultaneous open preview panels */
const MAX_OPEN_PREVIEWS = 3;

/** Format word count compactly: 1,247 → ~1.2K */
function formatWordCount(count: number): string {
  if (count >= 1000) return `~${(count / 1000).toFixed(1)}K`;
  return String(count);
}

export function State3Configure({
  sections,
  totalPages,
  config,
  onConfigChange,
  onStartCrawl,
  onBack,
  isStarting,
  baseUrl,
  discoveryRunning,
  discoveryStats,
}: State3ConfigureProps) {
  const t = useTranslations('search_ai.crawl_config');
  const tFlow = useTranslations('search_ai.crawl_flow');

  // ─── Robots.txt analysis state ──────────────────────────────────
  const [robotsAnalysis, setRobotsAnalysis] = useState<RobotsTxtAnalysisResult | null>(null);
  const [robotsLoading, setRobotsLoading] = useState(false);
  const [robotsError, setRobotsError] = useState(false);

  // Fetch robots.txt when Step 3 mounts
  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    setRobotsLoading(true);
    setRobotsError(false);
    analyzeRobotsTxt(baseUrl)
      .then((result) => {
        if (!cancelled) {
          setRobotsAnalysis(result);
          setRobotsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRobotsError(true);
          setRobotsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  // ─── Batch preview collapse state ──────────────────────────────
  const [batchPreviewOpen, setBatchPreviewOpen] = useState(true);

  // ─── Preview state ──────────────────────────────────────────────
  const [openPreviews, setOpenPreviews] = useState<Set<string>>(new Set());
  /** Bounded by section count (typically < 20). Cap at 50 for safety. */
  const previewCacheRef = useRef<Map<string, PreviewResponse['data']>>(new Map());

  const togglePreview = useCallback((sectionPattern: string) => {
    setOpenPreviews((prev) => {
      const next = new Set(prev);
      if (next.has(sectionPattern)) {
        next.delete(sectionPattern);
      } else {
        // Enforce max open previews — close the oldest (first in Set iteration order)
        if (next.size >= MAX_OPEN_PREVIEWS) {
          const oldest = next.values().next().value;
          if (oldest !== undefined) {
            next.delete(oldest);
          }
        }
        next.add(sectionPattern);
      }
      return next;
    });
  }, []);

  // ─── Config updater ───────────────────────────────────────────────
  const updateConfig = useCallback(
    <K extends keyof CrawlConfig>(key: K, value: CrawlConfig[K]) => {
      onConfigChange({ ...config, [key]: value });
    },
    [config, onConfigChange],
  );

  // ─── Derived values ───────────────────────────────────────────────
  const includedSections = useMemo(() => sections.filter((s) => s.included), [sections]);
  const includedPages = useMemo(
    () => includedSections.reduce((sum, s) => sum + s.pageCount, 0),
    [includedSections],
  );

  const effectivePages = useMemo(() => {
    if (config.scope === 'limited') return Math.min(1000, includedPages);
    if (config.scope === 'custom') return Math.min(config.customPageLimit ?? 1000, includedPages);
    return includedPages;
  }, [config.scope, config.customPageLimit, includedPages]);

  const interactiveSectionCount = useMemo(
    () => includedSections.filter((s) => s.warnings.length > 0).length,
    [includedSections],
  );

  // ─── Scope options ────────────────────────────────────────────────
  const scopeOptions: { value: CrawlScope; recommended?: boolean }[] = useMemo(
    () => [{ value: 'limited', recommended: true }, { value: 'full' }, { value: 'custom' }],
    [],
  );

  // ─── Select options ───────────────────────────────────────────────
  const renderingOptions = useMemo(
    () => [
      { value: 'hybrid', label: t('rendering_hybrid') },
      { value: 'http', label: t('rendering_http') },
      { value: 'browser', label: t('rendering_browser') },
    ],
    [t],
  );

  const cleanupOptions = useMemo(
    () => [
      { value: 'standard', label: t('cleanup_standard') },
      { value: 'aggressive', label: t('cleanup_aggressive') },
      { value: 'none', label: t('cleanup_none') },
    ],
    [t],
  );

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Discovery still running mini-bar */}
      {discoveryRunning && discoveryStats && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-foreground font-medium">{t('discovery_still_running')}</span>
            <span className="text-muted">
              {discoveryStats.urlCount} {tFlow('activity_urls')} · {discoveryStats.sectionCount}{' '}
              {tFlow('activity_sections')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="text-xs text-accent hover:text-accent/80 font-medium transition-default"
            >
              {t('back_to_review')}
            </button>
          </div>
        </div>
      )}

      {/* Scope radio cards */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('scope_heading')}</h3>
        <div className="grid grid-cols-3 gap-3">
          {scopeOptions.map(({ value, recommended }) => {
            const isSelected = config.scope === value;
            const pageCount =
              value === 'limited'
                ? Math.min(1000, includedPages)
                : value === 'full'
                  ? includedPages
                  : (config.customPageLimit ?? 1000);
            return (
              <button
                key={value}
                onClick={() => updateConfig('scope', value)}
                className={clsx(
                  'relative flex flex-col items-start gap-1 p-4 rounded-xl border text-left transition-default',
                  isSelected
                    ? 'border-accent bg-accent/5 ring-1 ring-accent'
                    : 'border-default bg-background-subtle hover:bg-background-elevated',
                )}
              >
                {recommended && (
                  <span className="absolute top-2 right-2 text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                    {t('recommended')}
                  </span>
                )}
                <span className="text-sm font-medium text-foreground">{t(`scope_${value}`)}</span>
                <span className="text-xs text-muted">
                  {formatNumber(pageCount)} {t('pages_label')} ({estimateTime(pageCount)})
                </span>
                {value === 'limited' && (
                  <span className="text-[10px] text-muted">{t('scope_limited_hint')}</span>
                )}
                {value === 'custom' && isSelected && (
                  <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="number"
                      min={1}
                      max={50000}
                      step={100}
                      value={config.customPageLimit ?? 1000}
                      onChange={(e) => {
                        const val = Math.max(1, Math.min(50000, Number(e.target.value) || 1));
                        updateConfig('customPageLimit', val);
                      }}
                      className="w-full rounded-md border border-default bg-background-subtle text-foreground text-xs py-1 px-2 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                      aria-label={t('scope_custom_input_label')}
                    />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Settings + sidebar layout */}
      <div className="flex gap-6">
        {/* Settings groups */}
        <div className="flex-1 space-y-5 min-w-0">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{t('settings_heading')}</h3>
            <p className="text-xs text-muted">{t('settings_subheading')}</p>
          </div>

          {/* Crawl Strategy */}
          <SettingsGroup label={t('group_strategy')}>
            <SettingRow
              icon={<Zap className="w-4 h-4" />}
              label={t('rendering')}
              hint={t('rendering_hint')}
            >
              <Select
                options={renderingOptions}
                value={config.rendering}
                onChange={(v) => updateConfig('rendering', v as RenderingMode)}
              />
            </SettingRow>
            <SettingRow
              icon={<Brain className="w-4 h-4" />}
              label={t('learned_patterns')}
              hint={t('learned_patterns_hint')}
            >
              <PillToggle
                options={[
                  { value: 'keep', label: t('keep') },
                  { value: 'reset', label: t('reset') },
                ]}
                value={config.learnedPatterns}
                onChange={(v) => updateConfig('learnedPatterns', v as 'keep' | 'reset')}
              />
            </SettingRow>
            <SettingRow
              icon={<Timer className="w-4 h-4" />}
              label={tFlow('crawl_speed_title')}
              hint={t('request_speed_hint')}
            >
              <div className="w-48">
                <CrawlSpeedSlider
                  value={config.requestDelay}
                  onChange={(ms) => updateConfig('requestDelay', ms)}
                  crawlDelay={robotsAnalysis?.crawlDelay ?? null}
                  tFlow={tFlow}
                />
              </div>
            </SettingRow>
          </SettingsGroup>

          {/* Limits */}
          <SettingsGroup label={t('group_limits')}>
            <SettingRow
              icon={<Lock className="w-4 h-4" />}
              label={t('max_pages')}
              hint={t('max_pages_hint')}
              locked
            >
              <span className="text-sm font-medium text-muted">
                {formatNumber(config.maxPages)} {t('per_batch')}
              </span>
            </SettingRow>
            <SettingRow
              icon={<ArrowDownToLine className="w-4 h-4" />}
              label={t('max_depth')}
              hint={t('max_depth_hint')}
            >
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={config.maxDepth}
                  onChange={(e) => {
                    const val = Math.max(1, Math.min(20, Number(e.target.value) || 1));
                    updateConfig('maxDepth', val);
                  }}
                  className="w-16 rounded-md border border-default bg-background-subtle text-foreground text-sm py-1 px-2 text-center focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  aria-label={t('max_depth')}
                />
                <span className="text-xs text-muted">{t('max_depth_unit')}</span>
              </div>
            </SettingRow>
            <SettingRow
              icon={<ShieldCheck className="w-4 h-4" />}
              label={t('robots_txt')}
              hint={t('robots_txt_hint')}
            >
              <PillToggle
                options={[
                  { value: 'true', label: t('robots_respect') },
                  { value: 'false', label: t('robots_ignore') },
                ]}
                value={String(config.respectRobotsTxt)}
                onChange={(v) => updateConfig('respectRobotsTxt', v === 'true')}
              />
            </SettingRow>
          </SettingsGroup>

          {/* Content Processing */}
          <SettingsGroup label={t('group_content')}>
            <SettingRow
              icon={<Sparkles className="w-4 h-4" />}
              label={t('cleanup')}
              hint={t('cleanup_hint')}
            >
              <Select
                options={cleanupOptions}
                value={config.cleanup}
                onChange={(v) => updateConfig('cleanup', v as CleanupLevel)}
              />
            </SettingRow>
            <SettingRow
              icon={<Copy className="w-4 h-4" />}
              label={t('deduplicate')}
              hint={t('deduplicate_hint')}
            >
              <PillToggle
                options={[
                  { value: 'true', label: t('deduplicate_on') },
                  { value: 'false', label: t('keep_all') },
                ]}
                value={String(config.deduplicate)}
                onChange={(v) => updateConfig('deduplicate', v === 'true')}
              />
            </SettingRow>
            <SettingRow
              icon={<Cookie className="w-4 h-4" />}
              label={t('cookie_consent')}
              hint={t('cookie_consent_hint')}
            >
              <PillToggle
                options={[
                  { value: 'true', label: t('auto_dismiss') },
                  { value: 'false', label: t('ignore') },
                ]}
                value={String(config.cookieConsent)}
                onChange={(v) => updateConfig('cookieConsent', v === 'true')}
              />
            </SettingRow>
          </SettingsGroup>
        </div>

        {/* Sidebar summary */}
        <div className="w-56 shrink-0 space-y-4">
          <Card hoverable={false} padding="md">
            <h3 className="text-sm font-semibold text-foreground mb-3">{t('summary')}</h3>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted">{t('summary_pages')}</dt>
                <dd className="text-foreground font-semibold">{formatNumber(effectivePages)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">{t('summary_sections')}</dt>
                <dd className="text-foreground font-semibold">{includedSections.length}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">{t('summary_time')}</dt>
                <dd className="text-foreground font-semibold">{estimateTime(effectivePages)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">{t('summary_rendering')}</dt>
                <dd className="text-foreground font-semibold">
                  {t(`rendering_${config.rendering}`)}
                </dd>
              </div>
              {interactiveSectionCount > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted">{t('summary_interactive')}</dt>
                  <dd className="text-foreground font-semibold">{interactiveSectionCount}</dd>
                </div>
              )}
            </dl>
          </Card>

          {/* Robots.txt analysis card */}
          <RobotsTxtCard
            analysis={robotsAnalysis}
            isLoading={robotsLoading}
            error={robotsError}
            sections={sections}
            tFlow={tFlow}
          />

          <Card hoverable={false} padding="md">
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-muted shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-foreground">{t('robots_summary_label')}</p>
                <p className="text-[10px] text-muted mt-0.5">
                  {config.respectRobotsTxt ? t('robots_summary_on') : t('robots_summary_off')}
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Section list with extraction preview */}
      {baseUrl && includedSections.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{tFlow('preview_title')}</h3>
          <div className="space-y-1.5">
            {includedSections.map((section) => {
              const sampleUrl = section.pages?.[0]?.url ?? section.examples?.[0] ?? null;
              const isOpen = openPreviews.has(section.pattern);
              const cached = previewCacheRef.current.get(section.pattern);
              return (
                <div key={section.pattern}>
                  {/* Section row */}
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background-subtle">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate block">
                        {section.name}
                      </span>
                      <span className="text-xs text-muted">
                        {formatNumber(section.pageCount)} {t('pages_label')}
                      </span>
                    </div>
                    {/* Cached stats badge */}
                    {cached && !isOpen && (
                      <span className="text-xs text-muted">
                        {tFlow('preview_cached_words', {
                          count: formatWordCount(cached.wordCount),
                        })}
                      </span>
                    )}

                    {/* Preview button */}
                    {sampleUrl && (
                      <button
                        onClick={() => togglePreview(section.pattern)}
                        className={clsx(
                          'p-1.5 rounded transition-default',
                          isOpen
                            ? 'text-accent bg-accent/10'
                            : 'text-muted hover:text-foreground hover:bg-background-muted',
                        )}
                        aria-label={tFlow('preview_button_label')}
                        title={tFlow('preview_button_label')}
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {/* Inline preview panel */}
                  {isOpen && sampleUrl && (
                    <div className="mt-1 ml-3">
                      <PreviewPanel
                        url={sampleUrl}
                        baseUrl={baseUrl}
                        onClose={() => togglePreview(section.pattern)}
                        cached={cached ?? null}
                        onLoaded={(result) => {
                          previewCacheRef.current.set(section.pattern, result);
                          // Force re-render so cached badges update
                          setOpenPreviews((prev) => new Set(prev));
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Batch extraction preview */}
      {baseUrl && includedSections.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setBatchPreviewOpen(!batchPreviewOpen)}
            className="flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-accent transition-default"
          >
            {batchPreviewOpen ? (
              <ArrowDownToLine className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
            {tFlow('batch_preview_heading')}
          </button>
          {batchPreviewOpen && (
            <BatchPreviewPanel
              sections={sections}
              baseUrl={baseUrl}
              renderingMode={config.rendering}
            />
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between pt-4 border-t border-default">
        <Button variant="secondary" size="sm" onClick={onBack}>
          {t('back')}
        </Button>
        <Button onClick={onStartCrawl} loading={isStarting} disabled={isStarting}>
          {t('start_crawl')}
        </Button>
      </div>
    </div>
  );
}

// ─── RobotsTxtCard (inline, O7) ─────────────────────────────────────

function RobotsTxtCard({
  analysis,
  isLoading,
  error,
  sections,
  tFlow,
}: {
  analysis: RobotsTxtAnalysisResult | null;
  isLoading: boolean;
  error: boolean;
  sections: { pattern: string }[];
  tFlow: ReturnType<typeof useTranslations>;
}) {
  if (isLoading) {
    return (
      <Card hoverable={false} padding="md">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-muted animate-spin" />
          <span className="text-xs text-muted">{tFlow('robots_card_loading')}</span>
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card hoverable={false} padding="md">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-warning" />
          <span className="text-xs text-muted">{tFlow('robots_card_error')}</span>
        </div>
      </Card>
    );
  }
  if (!analysis) return null;

  // Count affected sections
  const affectedCount = analysis.found
    ? sections.filter((s) => analysis.disallowedPaths.some((dp) => s.pattern.startsWith(dp))).length
    : 0;

  return (
    <Card hoverable={false} padding="md">
      <div className="flex items-center gap-2 mb-2">
        <FileText className="w-4 h-4 text-muted" />
        <h4 className="text-sm font-semibold text-foreground">{tFlow('robots_card_title')}</h4>
        <span
          className={clsx(
            'text-[10px] font-medium px-1.5 py-0.5 rounded',
            analysis.found ? 'text-success bg-success/10' : 'text-muted bg-background-muted',
          )}
        >
          {analysis.found ? tFlow('robots_card_found') : tFlow('robots_card_not_found')}
        </span>
      </div>
      {analysis.found && (
        <dl className="space-y-1.5 text-xs">
          {analysis.crawlDelay !== null && (
            <div className="flex items-center justify-between">
              <dt className="text-muted">{tFlow('robots_card_crawl_delay')}</dt>
              <dd className="text-foreground font-medium">{analysis.crawlDelay}s</dd>
            </div>
          )}
          {analysis.disallowedPaths.length > 0 && (
            <div>
              <dt className="text-muted mb-1">{tFlow('robots_card_disallowed_paths')}</dt>
              <dd className="space-y-0.5">
                {analysis.disallowedPaths.slice(0, 5).map((path) => (
                  <span
                    key={path}
                    className="block text-[10px] text-foreground font-mono bg-background-muted rounded px-1.5 py-0.5"
                  >
                    {path}
                  </span>
                ))}
                {analysis.disallowedPaths.length > 5 && (
                  <span className="text-[10px] text-muted">
                    {tFlow('robots_card_more_paths', {
                      count: analysis.disallowedPaths.length - 5,
                    })}
                  </span>
                )}
              </dd>
            </div>
          )}
          {affectedCount > 0 && (
            <div className="pt-1">
              <span className="text-[10px] text-warning">
                {tFlow('robots_card_affected_sections', { count: affectedCount })}
              </span>
            </div>
          )}
        </dl>
      )}
    </Card>
  );
}

// ─── CrawlSpeedSlider (inline, O7) ──────────────────────────────────

function CrawlSpeedSlider({
  value,
  onChange,
  crawlDelay,
  tFlow,
}: {
  value: number;
  onChange: (ms: number) => void;
  crawlDelay: number | null;
  tFlow: ReturnType<typeof useTranslations>;
}) {
  const crawlDelayMs = crawlDelay !== null ? crawlDelay * 1000 : 0;
  const minMs = Math.max(200, crawlDelayMs);
  const sliderMax = Math.max(5000, crawlDelayMs);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{tFlow('crawl_speed_fast')}</span>
        <span className="text-xs text-foreground font-mono">{value}ms</span>
        <span className="text-xs text-muted">{tFlow('crawl_speed_polite')}</span>
      </div>
      <input
        type="range"
        min={minMs}
        max={sliderMax}
        step={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-muted/20 accent-accent"
        aria-label={tFlow('crawl_speed_title')}
      />
      {/* Warnings */}
      {value < 500 && (
        <p className="text-[10px] text-warning flex items-center gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {tFlow('crawl_speed_warning_fast')}
        </p>
      )}
      {crawlDelayMs > 0 && value < crawlDelayMs && (
        <p className="text-[10px] text-warning flex items-center gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {tFlow('crawl_speed_warning_crawl_delay', { delay: String(crawlDelay) })}
        </p>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function SettingsGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">{label}</h4>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SettingRow({
  icon,
  label,
  hint,
  locked,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg',
        locked ? 'bg-background-muted opacity-75' : 'bg-background-subtle',
      )}
    >
      <span className="text-muted shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {locked && <Lock className="w-3 h-3 text-muted" />}
        </div>
        <p className="text-[10px] text-muted mt-0.5 leading-tight">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function PillToggle({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-default bg-background-muted p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={clsx(
            'px-3 py-1 text-xs font-medium rounded-md transition-default',
            value === opt.value
              ? 'bg-background-elevated text-foreground shadow-sm'
              : 'text-muted hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
