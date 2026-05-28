/**
 * Visual Analysis Stage Config — controls image/table/chart analysis.
 *
 * Bundles 2 enrichment capabilities:
 *   1. Visual enrichment (image and table detection + analysis)
 *   2. Multimodal processing (LLM-powered image descriptions, table summaries, chart analysis)
 *
 * i18n keys used:
 * v2_va_*, v2_stage_visual_analysis
 */

'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Toggle } from '../../../../ui/Toggle';
import { Select } from '../../../../ui/Select';

interface VisualAnalysisConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

const MODEL_TIER_OPTIONS = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'powerful', label: 'Powerful (high accuracy)' },
];

export function VisualAnalysisConfig({ config, onChange }: VisualAnalysisConfigProps) {
  const t = useTranslations('search_ai.pipeline');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  // Defaults match USE_CASE_DEFAULTS for vision + multimodal
  const analyzeImages = config.analyzeImages !== false;
  const analyzeScreenshots = config.analyzeScreenshots !== false;
  const summarizeTables = config.summarizeTables !== false;
  const analyzeCharts = config.analyzeCharts !== false;
  const enhanceTableContinuations = config.enhanceTableContinuations !== false;
  const modelTier = (config.modelTier as string) ?? 'balanced';
  const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : 500;

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-xs text-foreground-muted">{t('v2_va_description')}</p>

      {/* ── Image Analysis Section ─────────────────────────────────── */}
      <div className="rounded-lg border border-default bg-background p-3 space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
          {t('v2_va_images_section')}
        </h4>

        <div className="space-y-2.5">
          {/* Analyze images */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-medium text-foreground">{t('v2_va_images')}</span>
              <p className="text-[10px] text-foreground-muted">{t('v2_va_images_desc')}</p>
            </div>
            <Toggle checked={analyzeImages} onChange={(v) => update('analyzeImages', v)} />
          </div>

          {/* Analyze screenshots */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-medium text-foreground">{t('v2_va_screenshots')}</span>
              <p className="text-[10px] text-foreground-muted">{t('v2_va_screenshots_desc')}</p>
            </div>
            <Toggle
              checked={analyzeScreenshots}
              onChange={(v) => update('analyzeScreenshots', v)}
            />
          </div>

          {/* Analyze charts */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-medium text-foreground">{t('v2_va_charts')}</span>
              <p className="text-[10px] text-foreground-muted">{t('v2_va_charts_desc')}</p>
            </div>
            <Toggle checked={analyzeCharts} onChange={(v) => update('analyzeCharts', v)} />
          </div>
        </div>
      </div>

      {/* ── Table Analysis Section ─────────────────────────────────── */}
      <div className="rounded-lg border border-default bg-background p-3 space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
          {t('v2_va_tables_section')}
        </h4>

        <div className="space-y-2.5">
          {/* Summarize tables */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-medium text-foreground">{t('v2_va_tables')}</span>
              <p className="text-[10px] text-foreground-muted">{t('v2_va_tables_desc')}</p>
            </div>
            <Toggle checked={summarizeTables} onChange={(v) => update('summarizeTables', v)} />
          </div>

          {/* Table continuations */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs font-medium text-foreground">
                {t('v2_va_continuations')}
              </span>
              <p className="text-[10px] text-foreground-muted">{t('v2_va_continuations_desc')}</p>
            </div>
            <Toggle
              checked={enhanceTableContinuations}
              onChange={(v) => update('enhanceTableContinuations', v)}
            />
          </div>
        </div>
      </div>

      {/* ── Advanced Section ───────────────────────────────────────── */}
      <div className="rounded-lg border border-default">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-muted"
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4 text-foreground-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-foreground-muted" />
          )}
          {t('v2_va_advanced')}
        </button>
        {advancedOpen && (
          <div className="space-y-3 px-3 pb-3">
            {/* Model Tier */}
            <Select
              label={t('v2_va_model_tier')}
              options={MODEL_TIER_OPTIONS}
              value={modelTier}
              onChange={(v) => update('modelTier', v)}
            />

            {/* Max Tokens */}
            <div className="space-y-1.5">
              <label className="flex items-center justify-between text-xs font-medium text-foreground">
                <span>{t('v2_va_max_tokens')}</span>
                <span className="tabular-nums text-foreground-muted">{maxTokens}</span>
              </label>
              <input
                type="range"
                min={200}
                max={2000}
                step={100}
                value={maxTokens}
                onChange={(e) => update('maxTokens', parseInt(e.target.value, 10))}
                className="w-full accent-accent"
              />
            </div>

            {/* Cost info */}
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5">
              <p className="text-[10px] text-foreground-muted">{t('v2_va_cost_note')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
