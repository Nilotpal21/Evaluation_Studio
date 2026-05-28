'use client';

/**
 * StrategySelector — After profiling, user chooses between Sitemap and Guided Discovery.
 *
 * Three cards:
 *   - Crawl Full Sitemap: three-state card
 *       • enabled:    hasSitemap — normal clickable card
 *       • needs-help: !hasSitemap — shows input for custom sitemap URL
 *       • validating: user submitted a URL, waiting for validation
 *   - Guided Discovery: always available
 *   - Direct URLs: always available, never auto-recommended
 *
 * A recommendation badge highlights the contextually better choice.
 * When selectedStrategy is set, the selected card is highlighted and the other dimmed.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Newspaper, Compass, Check, Loader2, ListChecks, Link2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { springs } from '@/lib/animation';
import { validateSitemap } from '@/api/crawl';
import type { DiscoveryStrategy } from './types';

// ─── Recommendation Logic ────────────────────────────────────────────

/**
 * Recommend sitemap or guided discovery based purely on sitemap quality.
 * Backend signal (bulk=sitemap, browser=guided) takes precedence when available.
 * Fallback uses page count + section count from clustering.
 */
function deriveRecommendation(
  backendRecommendation: 'browser' | 'bulk' | 'hybrid' | undefined,
  sitemapEnabled: boolean,
  sitemapPageCount: number,
  sitemapSectionCount: number,
): boolean {
  // Backend: bulk → sitemap, browser → guided, hybrid → check locally
  if (backendRecommendation === 'bulk') return true;
  if (backendRecommendation === 'browser') return false;

  // Local: purely sitemap quality signals
  if (!sitemapEnabled) return false;
  if (sitemapPageCount > 50 && sitemapSectionCount >= 3) return true;
  if (sitemapPageCount > 20 && sitemapSectionCount >= 2) return true;
  return false;
}

/**
 * Derive per-card reasoning. Each card explains what the system detected
 * and why this option exists — part of a continuous narrative the user reads top-to-bottom.
 *
 * Card desc already shows page count, so reasoning should NOT repeat it.
 * Instead it explains: why recommended / why not / what was detected.
 */
function deriveSitemapReasoning(
  t: ReturnType<typeof useTranslations>,
  sitemapEnabled: boolean,
  sitemapSectionCount: number,
  recommendSitemap: boolean,
): string {
  if (!sitemapEnabled) return t('strategy_reason_no_sitemap');
  if (recommendSitemap) {
    return t('strategy_reason_sitemap_recommended', { sections: sitemapSectionCount.toString() });
  }
  return t('strategy_reason_sitemap_not_recommended');
}

function deriveGuidedReasoning(
  t: ReturnType<typeof useTranslations>,
  sitemapEnabled: boolean,
  recommendSitemap: boolean,
): string {
  if (!sitemapEnabled) return t('strategy_reason_guided_no_sitemap');
  if (!recommendSitemap) return t('strategy_reason_guided_recommended');
  return t('strategy_reason_guided_not_recommended');
}

// ─── Types ───────────────────────────────────────────────────────────

/** Internal state for the custom sitemap input */
type CustomSitemapState =
  | { phase: 'idle' }
  | { phase: 'input' }
  | { phase: 'validating'; url: string }
  | { phase: 'valid'; url: string; urlCount: number }
  | { phase: 'error'; url: string; errorType: string; message: string };

interface StrategySelectorProps {
  hasSitemap: boolean;
  sitemapPageCount: number;
  sitemapSectionCount: number;
  onStrategySelected: (strategy: DiscoveryStrategy | null) => void;
  /** When set, show the selected card highlighted and others dimmed */
  selectedStrategy?: DiscoveryStrategy | null;
  /** Backend-computed recommendation from decisionEngine — preferred signal */
  backendRecommendation?: 'browser' | 'bulk' | 'hybrid';
  /** Human-readable reason why this strategy was recommended */
  recommendationReasoning?: string;
  /** Whether background clustering is still running (show "Analyzing sitemap..." on card) */
  clusteringInProgress?: boolean;
  /** Called when user validates a custom sitemap URL — parent should re-cluster */
  onCustomSitemapValidated?: (sitemapUrl: string, urlCount: number) => void;
}

// ─── Component ───────────────────────────────────────────────────────

export function StrategySelector({
  hasSitemap,
  sitemapPageCount,
  sitemapSectionCount,
  onStrategySelected,
  selectedStrategy,
  backendRecommendation,
  clusteringInProgress,
  onCustomSitemapValidated,
}: StrategySelectorProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [customSitemap, setCustomSitemap] = useState<CustomSitemapState>({ phase: 'idle' });
  const [inputValue, setInputValue] = useState('');

  // Sitemap is effectively available if profiler found it, clustering discovered pages,
  // OR user validated a custom sitemap
  const customValidated = customSitemap.phase === 'valid';
  const sitemapEnabled =
    customValidated ||
    (clusteringInProgress && hasSitemap) ||
    ((hasSitemap || sitemapPageCount > 0) && sitemapPageCount > 0);

  // Dynamic recommendation: use backend signal first, fall back to multi-signal heuristic
  // Defer recommendation until clustering completes — we don't have quality signals yet
  const recommendSitemap = clusteringInProgress
    ? false
    : deriveRecommendation(
        backendRecommendation,
        sitemapEnabled,
        sitemapPageCount,
        sitemapSectionCount,
      );
  const hasSelection = selectedStrategy != null;

  // Per-card reasoning
  const sitemapReasoning = deriveSitemapReasoning(
    t,
    sitemapEnabled,
    sitemapSectionCount,
    recommendSitemap,
  );
  const guidedReasoning = deriveGuidedReasoning(t, sitemapEnabled, recommendSitemap);

  // ─── Custom sitemap validation ───────────────────────────────────

  const handleValidateCustomSitemap = useCallback(async () => {
    const url = inputValue.trim();
    if (!url) return;

    setCustomSitemap({ phase: 'validating', url });

    try {
      const result = await validateSitemap(url);

      if (result.valid) {
        setCustomSitemap({ phase: 'valid', url, urlCount: result.urlCount });
        onCustomSitemapValidated?.(url, result.urlCount);
      } else {
        setCustomSitemap({
          phase: 'error',
          url,
          errorType: result.error ?? 'invalid',
          message: result.message ?? t('strategy_custom_sitemap_generic_error'),
        });
      }
    } catch {
      setCustomSitemap({
        phase: 'error',
        url,
        errorType: 'network',
        message: t('strategy_custom_sitemap_network_error'),
      });
    }
  }, [inputValue, onCustomSitemapValidated, t]);

  // ─── Card definitions ────────────────────────────────────────────

  // When custom sitemap is active, show the URL count from validation
  const effectivePageCount = customValidated ? customSitemap.urlCount : sitemapPageCount;

  const guidedCard = {
    key: 'guided-discovery' as DiscoveryStrategy,
    icon: Compass,
    titleKey: 'strategy_guided_title',
    descKey: 'strategy_guided_desc',
    enabled: true,
    recommended: clusteringInProgress ? false : !recommendSitemap,
    reasoning: clusteringInProgress ? '' : guidedReasoning,
  };

  const directCard = {
    key: 'direct-urls' as DiscoveryStrategy,
    icon: ListChecks,
    titleKey: 'strategy_direct_title',
    descKey: 'strategy_direct_desc',
    enabled: true,
    recommended: false,
    reasoning: t('strategy_direct_reasoning'),
  };

  // ─── Render helpers ──────────────────────────────────────────────

  /** Standard card (guided discovery, direct URLs) */
  function renderStandardCard(
    card: {
      key: DiscoveryStrategy;
      icon: typeof Compass;
      titleKey: string;
      descKey: string;
      descParams?: Record<string, string>;
      enabled: boolean;
      recommended: boolean;
      reasoning: string;
    },
    index: number,
  ) {
    const Icon = card.icon;
    const isSelected = selectedStrategy === card.key;
    const isDimmed = hasSelection && !isSelected;

    return (
      <motion.button
        key={card.key}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: isDimmed ? 0.5 : 1, y: 0 }}
        transition={{ ...springs.default, delay: index * 0.1 }}
        disabled={!card.enabled}
        onClick={() => onStrategySelected(card.key)}
        className={`relative rounded-lg border p-4 text-left transition-default ${
          isSelected
            ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
            : isDimmed
              ? 'border-default bg-background-subtle hover:border-border-focus hover:opacity-80 cursor-pointer'
              : 'border-default bg-background-subtle hover:border-border-focus'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {isSelected && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-accent/10 text-accent px-2 py-0.5 text-[10px] font-medium">
            <Check className="w-3 h-3" />
            {t('strategy_selected')}
          </span>
        )}
        {!isSelected && card.recommended && !hasSelection && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-accent/10 text-accent px-2 py-0.5 text-[10px] font-medium">
            <Check className="w-3 h-3" />
            {t('strategy_recommended')}
          </span>
        )}

        <Icon className="w-5 h-5 text-muted mb-2" />
        <p className="text-sm font-medium text-foreground">{t(card.titleKey)}</p>
        <p className="text-xs text-muted mt-1">
          {card.descParams ? t(card.descKey, card.descParams) : t(card.descKey)}
        </p>

        {card.enabled && !hasSelection && card.reasoning && (
          <p className="text-[10px] text-muted mt-2 italic">{card.reasoning}</p>
        )}
      </motion.button>
    );
  }

  /** Sitemap card — three states: enabled (normal), needs-help (input), validating */
  function renderSitemapCard() {
    const isSelected = selectedStrategy === 'crawl-sitemap';
    const isDimmed = hasSelection && !isSelected;
    const showInput = !sitemapEnabled && !clusteringInProgress;

    return (
      <motion.div
        key="crawl-sitemap"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: isDimmed ? 0.5 : 1, y: 0 }}
        transition={{ ...springs.default, delay: 0 }}
        className={`relative rounded-lg border p-4 text-left transition-default ${
          isSelected
            ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
            : isDimmed
              ? 'border-default bg-background-subtle hover:border-border-focus hover:opacity-80'
              : 'border-default bg-background-subtle hover:border-border-focus'
        }`}
      >
        {isSelected && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-accent/10 text-accent px-2 py-0.5 text-[10px] font-medium">
            <Check className="w-3 h-3" />
            {t('strategy_selected')}
          </span>
        )}
        {!isSelected && recommendSitemap && !hasSelection && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-accent/10 text-accent px-2 py-0.5 text-[10px] font-medium">
            <Check className="w-3 h-3" />
            {t('strategy_recommended')}
          </span>
        )}

        <Newspaper className="w-5 h-5 text-muted mb-2" />
        <p className="text-sm font-medium text-foreground">{t('strategy_sitemap_title')}</p>

        {/* State: enabled — normal card behavior */}
        {sitemapEnabled && !showInput && (
          <>
            <p className="text-xs text-muted mt-1 flex items-center gap-1">
              {clusteringInProgress && <Loader2 className="w-3 h-3 animate-spin" />}
              {clusteringInProgress
                ? t('strategy_sitemap_analyzing')
                : t('strategy_sitemap_desc', { count: effectivePageCount.toLocaleString() })}
            </p>
            {!clusteringInProgress && !hasSelection && sitemapReasoning && (
              <p className="text-[10px] text-muted mt-2 italic">{sitemapReasoning}</p>
            )}
            {/* Clickable overlay when enabled and not selected */}
            {!isSelected && sitemapEnabled && (
              <button
                type="button"
                onClick={() => onStrategySelected('crawl-sitemap')}
                className="absolute inset-0 rounded-lg cursor-pointer"
                aria-label={t('strategy_sitemap_title')}
              />
            )}
          </>
        )}

        {/* State: needs-help — no sitemap found, show input */}
        {showInput && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted">{t('strategy_custom_sitemap_prompt')}</p>

            <AnimatePresence mode="wait">
              {(customSitemap.phase === 'idle' || customSitemap.phase === 'input') && (
                <motion.div
                  key="input"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex gap-1.5"
                >
                  <div className="relative flex-1">
                    <Link2 className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                    <input
                      type="url"
                      value={inputValue}
                      onChange={(e) => {
                        setInputValue(e.target.value);
                        if (customSitemap.phase === 'idle') {
                          setCustomSitemap({ phase: 'input' });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && inputValue.trim()) {
                          handleValidateCustomSitemap();
                        }
                      }}
                      placeholder={t('strategy_custom_sitemap_placeholder')}
                      className="w-full rounded-md border border-default bg-background pl-7 pr-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 outline-none transition-default"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleValidateCustomSitemap}
                    disabled={!inputValue.trim()}
                    className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-default"
                  >
                    {t('strategy_custom_sitemap_validate')}
                  </button>
                </motion.div>
              )}

              {customSitemap.phase === 'validating' && (
                <motion.div
                  key="validating"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 py-1"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                  <span className="text-xs text-muted">
                    {t('strategy_custom_sitemap_validating')}
                  </span>
                </motion.div>
              )}

              {customSitemap.phase === 'error' && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="space-y-1.5"
                >
                  <p className="text-xs text-error">{customSitemap.message}</p>
                  <button
                    type="button"
                    onClick={() => setCustomSitemap({ phase: 'input' })}
                    className="text-xs text-accent hover:text-accent/80 font-medium transition-default"
                  >
                    {t('strategy_custom_sitemap_retry')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Custom sitemap validated — enable selection */}
        {customValidated && !hasSelection && (
          <button
            type="button"
            onClick={() => onStrategySelected('crawl-sitemap')}
            className="absolute inset-0 rounded-lg cursor-pointer"
            aria-label={t('strategy_sitemap_title')}
          />
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.default}
      className="space-y-3"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">{t('strategy_title')}</p>
          <p className="text-xs text-muted">{t('strategy_subtitle')}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {renderSitemapCard()}
        {renderStandardCard(guidedCard, 1)}
        {renderStandardCard(directCard, 2)}
      </div>
    </motion.div>
  );
}
