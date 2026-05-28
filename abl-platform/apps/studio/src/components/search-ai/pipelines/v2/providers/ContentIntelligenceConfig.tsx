/**
 * Content Intelligence Stage Config — controls summarization + question synthesis.
 *
 * Bundles 4 LLM enrichment capabilities:
 *   1. Progressive summarization (per-chunk summaries)
 *   2. Per-chunk question synthesis (HyDE-style questions)
 *   3. Document-level summary (whole-doc summary)
 *   4. Document-level question synthesis
 *
 * i18n keys used:
 * v2_ci_*, v2_stage_content_intelligence
 */

'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Toggle } from '../../../../ui/Toggle';
import { Select } from '../../../../ui/Select';

interface ContentIntelligenceConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

const MODEL_TIER_OPTIONS = [
  { value: 'fast', label: 'Fast (low cost)' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'powerful', label: 'Powerful (high accuracy)' },
];

export function ContentIntelligenceConfig({ config, onChange }: ContentIntelligenceConfigProps) {
  const t = useTranslations('search_ai.pipeline');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  // Defaults match USE_CASE_DEFAULTS from search-ai
  const generateSummary = config.generateSummary !== false;
  const generateQuestions = config.generateQuestions !== false;
  const documentSummary = config.documentSummary !== false;
  const documentQuestions = config.documentQuestions !== false;
  const questionsPerChunk =
    typeof config.questionsPerChunk === 'number' ? config.questionsPerChunk : 3;
  const summaryMaxTokens =
    typeof config.summaryMaxTokens === 'number' ? config.summaryMaxTokens : 300;
  const documentSummaryMaxTokens =
    typeof config.documentSummaryMaxTokens === 'number' ? config.documentSummaryMaxTokens : 500;
  const documentQuestionsCount =
    typeof config.documentQuestionsCount === 'number' ? config.documentQuestionsCount : 5;
  const modelTier = (config.modelTier as string) ?? 'fast';

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-xs text-foreground-muted">{t('v2_ci_description')}</p>

      {/* ── Summarization Section ──────────────────────────────────── */}
      <div className="rounded-lg border border-default bg-background p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-foreground">{t('v2_ci_summarization')}</h4>
            <p className="text-xs text-foreground-muted">{t('v2_ci_summarization_desc')}</p>
          </div>
          <Toggle checked={generateSummary} onChange={(v) => update('generateSummary', v)} />
        </div>

        {generateSummary && (
          <div className="space-y-3 border-t border-default pt-3">
            {/* Summary Max Tokens */}
            <div className="space-y-1.5">
              <label className="flex items-center justify-between text-xs font-medium text-foreground">
                <span>{t('v2_ci_summary_max_tokens')}</span>
                <span className="tabular-nums text-foreground-muted">{summaryMaxTokens}</span>
              </label>
              <input
                type="range"
                min={100}
                max={1000}
                step={50}
                value={summaryMaxTokens}
                onChange={(e) => update('summaryMaxTokens', parseInt(e.target.value, 10))}
                className="w-full accent-accent"
              />
            </div>

            {/* Document-level summary */}
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-foreground">
                  {t('v2_ci_doc_summary')}
                </span>
                <p className="text-[10px] text-foreground-muted">{t('v2_ci_doc_summary_desc')}</p>
              </div>
              <Toggle checked={documentSummary} onChange={(v) => update('documentSummary', v)} />
            </div>

            {documentSummary && (
              <div className="space-y-1.5 pl-4">
                <label className="flex items-center justify-between text-xs font-medium text-foreground">
                  <span>{t('v2_ci_doc_summary_tokens')}</span>
                  <span className="tabular-nums text-foreground-muted">
                    {documentSummaryMaxTokens}
                  </span>
                </label>
                <input
                  type="range"
                  min={200}
                  max={2000}
                  step={100}
                  value={documentSummaryMaxTokens}
                  onChange={(e) => update('documentSummaryMaxTokens', parseInt(e.target.value, 10))}
                  className="w-full accent-accent"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Question Synthesis Section ─────────────────────────────── */}
      <div className="rounded-lg border border-default bg-background p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-foreground">{t('v2_ci_questions')}</h4>
            <p className="text-xs text-foreground-muted">{t('v2_ci_questions_desc')}</p>
          </div>
          <Toggle checked={generateQuestions} onChange={(v) => update('generateQuestions', v)} />
        </div>

        {generateQuestions && (
          <div className="space-y-3 border-t border-default pt-3">
            {/* Questions per chunk */}
            <div className="space-y-1.5">
              <label className="flex items-center justify-between text-xs font-medium text-foreground">
                <span>{t('v2_ci_questions_per_chunk')}</span>
                <span className="tabular-nums text-foreground-muted">{questionsPerChunk}</span>
              </label>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={questionsPerChunk}
                onChange={(e) => update('questionsPerChunk', parseInt(e.target.value, 10))}
                className="w-full accent-accent"
              />
            </div>

            {/* Document-level questions */}
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-foreground">
                  {t('v2_ci_doc_questions')}
                </span>
                <p className="text-[10px] text-foreground-muted">{t('v2_ci_doc_questions_desc')}</p>
              </div>
              <Toggle
                checked={documentQuestions}
                onChange={(v) => update('documentQuestions', v)}
              />
            </div>

            {documentQuestions && (
              <div className="space-y-1.5 pl-4">
                <label className="flex items-center justify-between text-xs font-medium text-foreground">
                  <span>{t('v2_ci_doc_questions_count')}</span>
                  <span className="tabular-nums text-foreground-muted">
                    {documentQuestionsCount}
                  </span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={documentQuestionsCount}
                  onChange={(e) => update('documentQuestionsCount', parseInt(e.target.value, 10))}
                  className="w-full accent-accent"
                />
              </div>
            )}
          </div>
        )}
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
          {t('v2_ci_advanced')}
        </button>
        {advancedOpen && (
          <div className="space-y-3 px-3 pb-3">
            {/* Model Tier */}
            <Select
              label={t('v2_ci_model_tier')}
              options={MODEL_TIER_OPTIONS}
              value={modelTier}
              onChange={(v) => update('modelTier', v)}
            />

            {/* Cost info */}
            <div className="rounded-lg border border-default bg-background-muted p-2.5">
              <p className="text-[10px] text-foreground-muted">{t('v2_ci_cost_note')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
