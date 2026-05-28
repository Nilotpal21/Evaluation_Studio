/**
 * QueryPipelineLLMSection
 *
 * Redesigned Query Intelligence card matching the wireframe at
 * docs/wireframes/llm-models-redesign-v2.html.
 *
 * Layout: Section title "Query Pipeline LLM" → Card "Query Intelligence"
 *   Card contains: icon + name row with toggle + badge, model info line,
 *   description, info note ("not used via Agent & Tools"), disabled warning,
 *   Change button (top-right) with tooltip when disabled.
 *
 * States:
 * - Enabled + model resolved: Shows model info, Active badge, Change button
 * - Enabled + no models: Warning card to add models
 * - Disabled: Toggle off, Disabled badge, suggestion text replaces model info,
 *   Change button shows tooltip on hover, warning about vector/hybrid only
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, AlertTriangle, ChevronDown, Info, Radio } from 'lucide-react';
import { sanitizeError } from '@/lib/sanitize-error';
import { apiFetch } from '@/lib/api-client';
import { useNavigationStore } from '../../store/navigation-store';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { ModelSelectorDialog } from './ModelSelectorDialog';
import { formatModelIdentityLine, getModelPrimaryName } from '../../lib/model-display';

// ─── Types ────────────────────────────────────────────────────────────────

interface AvailableModel {
  id: string;
  displayName: string;
  provider: string;
  modelId: string;
  tier: string;
  supportsTools?: boolean;
}

interface QueryLLMStatus {
  enabled: boolean;
  configured: boolean;
  autoSelect: boolean;
  preferredTier: string;
  model: {
    id: string | null;
    displayName: string;
    provider: string;
    modelId: string;
    tier: string;
    isActive: boolean;
  } | null;
  resolution: string;
  availableModels: AvailableModel[];
  fallback: string | null;
  warning: string | null;
}

interface QueryPipelineLLMSectionProps {
  indexId: string;
  projectId: string;
}

// ─── Component ────────────────────────────────────────────────────────────

export function QueryPipelineLLMSection({ indexId, projectId }: QueryPipelineLLMSectionProps) {
  const t = useTranslations('search_ai.query_llm');
  const navigate = useNavigationStore((s) => s.navigate);
  const modelsSettingsPath = `/projects/${projectId}/settings/models`;
  const [status, setStatus] = useState<QueryLLMStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);

  const loadStatus = useCallback(
    async (silent = false) => {
      try {
        // Silent mode: refresh data without showing the loading skeleton.
        // Used after saves so the card doesn't blink/pop out and back in.
        if (!silent) setLoading(true);
        setError(null);
        const res = await apiFetch(`/api/search-ai/indexes/${indexId}/query-llm-status`);
        if (!res.ok) throw new Error(t('error_load'));
        const data = await res.json();
        setStatus(data);
      } catch (err) {
        setError(sanitizeError(err, t('error_load_config')));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [indexId, t],
  );

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function updateConfig(payload: {
    enabled?: boolean;
    modelId?: string | null;
    autoSelect?: boolean;
    preferredTier?: string;
  }) {
    try {
      setSaving(true);
      setError(null);

      // Optimistic update: apply the change immediately so the toggle
      // doesn't wait for the round-trip. Reverts on error.
      if (status) {
        const optimistic = { ...status };
        if (payload.enabled !== undefined) optimistic.enabled = payload.enabled;
        if (payload.autoSelect !== undefined) optimistic.autoSelect = payload.autoSelect;
        setStatus(optimistic);
      }

      const res = await apiFetch(`/api/search-ai/indexes/${indexId}/query-llm-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(t('error_update'));
      // Silent refresh — update data without showing loading skeleton
      await loadStatus(true);
    } catch (err) {
      setError(sanitizeError(err, t('error_save')));
      // Revert optimistic update on failure
      await loadStatus(true);
    } finally {
      setSaving(false);
    }
  }

  function handleToggle() {
    if (!status) return;
    const newEnabled = !isEnabled;
    updateConfig({ enabled: newEnabled });
  }

  function handleModelSelect(modelId: string) {
    updateConfig({ modelId, autoSelect: false });
    setSelectorOpen(false);
  }

  function handleAutoSelectToggle(enabled: boolean) {
    if (enabled) {
      updateConfig({ modelId: null, autoSelect: true });
    } else if (status?.model?.id) {
      updateConfig({ modelId: status.model.id, autoSelect: false });
    } else {
      updateConfig({ autoSelect: false });
    }
  }

  // Derive enabled state — default disabled, user opts in
  const isEnabled = status?.enabled ?? false;

  // ─── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-3">
        <SectionHeader />
        <Card className="p-4" hoverable={false}>
          <div className="flex items-center gap-2 text-sm text-muted">
            <Bot className="w-4 h-4" />
            {t('loading')}
          </div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <SectionHeader />
        <Alert variant="error">
          <AlertTriangle className="w-4 h-4" />
          <div>
            <div className="font-medium">{t('card_title')}</div>
            <div className="text-sm mt-1">{error}</div>
            <Button size="sm" variant="secondary" onClick={() => loadStatus()} className="mt-2">
              {t('retry')}
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  if (!status) return null;

  // ─── Journey 1: No workspace models ─────────────────────────────────────

  if (status.availableModels.length === 0) {
    return (
      <div className="space-y-3">
        <SectionHeader />
        <Card className="p-4 border-warning/30 bg-warning/5" hoverable={false}>
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t('no_model_title')}</h3>
              <p className="text-xs text-muted mt-1">{t('no_model_description')}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={() => navigate(modelsSettingsPath)}
              >
                {t('add_model_cta')}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ─── Main Card (enabled or disabled) ────────────────────────────────────

  return (
    <TooltipProvider>
      <div className="space-y-3">
        <SectionHeader />
        <Card className="p-4" hoverable={false}>
          <div className="flex items-start justify-between gap-3">
            {/* Left: Icon + Content */}
            <div className="flex items-start gap-3 flex-1 min-w-0">
              {/* Icon */}
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent-subtle flex items-center justify-center">
                <Radio className="w-5 h-5 text-accent" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                {/* Name + Toggle + Badge */}
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-foreground">{t('card_title')}</h3>
                  <button
                    onClick={handleToggle}
                    disabled={saving}
                    className={`
                    relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0
                    ${isEnabled ? 'bg-success' : 'bg-background-elevated border border-default'}
                  `}
                    role="switch"
                    aria-checked={isEnabled}
                  >
                    <span
                      className={`
                      inline-block h-3.5 w-3.5 rounded-full shadow-sm transition-transform
                      ${isEnabled ? 'bg-white translate-x-[18px]' : 'bg-foreground translate-x-[3px]'}
                    `}
                    />
                  </button>
                  {isEnabled ? (
                    <Badge variant="success" dot>
                      {t('badge_active')}
                    </Badge>
                  ) : (
                    <Badge variant="default">{t('badge_disabled')}</Badge>
                  )}
                </div>

                {/* Model Info (when enabled) or suggestion text (when disabled) */}
                {isEnabled && status.model ? (
                  <div className="flex items-center gap-2 mt-1.5 text-xs text-muted flex-wrap">
                    <span>{getModelPrimaryName(status.model)}</span>
                    <span className="text-muted/50">·</span>
                    <span>
                      {t('label_tier')}: {status.model.tier}
                    </span>
                    {formatModelIdentityLine(status.model) && (
                      <>
                        <span className="text-muted/50">·</span>
                        <span>{formatModelIdentityLine(status.model)}</span>
                      </>
                    )}
                    {status.resolution === 'auto-selected' && (
                      <>
                        <span className="text-muted/50">·</span>
                        <Badge variant="info">{t('badge_auto_selected')}</Badge>
                      </>
                    )}
                    {status.resolution === 'pinned' && (
                      <>
                        <span className="text-muted/50">·</span>
                        <Badge variant="default">{t('badge_pinned')}</Badge>
                      </>
                    )}
                  </div>
                ) : isEnabled && !status.model ? (
                  <div className="text-xs text-muted mt-1.5">{t('disabled_model_hint')}</div>
                ) : (
                  <div className="text-xs text-muted mt-1.5">{t('disabled_model_hint')}</div>
                )}

                {/* Description */}
                <p className="text-xs text-muted mt-2 leading-relaxed">{t('card_description')}</p>

                {/* Info Note: Not used via Agent & Tools */}
                <div
                  className={`flex items-center gap-1.5 mt-2.5 px-2.5 py-1.5 rounded-md bg-info-subtle border border-info/10 transition-opacity ${
                    isEnabled ? 'opacity-100' : 'opacity-50'
                  }`}
                >
                  <Info className="w-3.5 h-3.5 text-info shrink-0" />
                  <span className="text-xs text-info">{t('info_agent_note')}</span>
                </div>

                {/* Warning when disabled */}
                {!isEnabled && (
                  <div className="flex items-center gap-1.5 mt-2 text-xs text-warning">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>{t('disabled_warning')}</span>
                  </div>
                )}

                {/* Pinned model deactivated warning */}
                {isEnabled && status.warning && (
                  <div className="flex items-start gap-2 mt-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                    <div>
                      <span className="text-xs text-warning">{status.warning}</span>
                      <div className="flex gap-2 mt-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setSelectorOpen(true)}
                          disabled={saving}
                        >
                          {t('select_different_model')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleAutoSelectToggle(true)}
                          disabled={saving}
                        >
                          {t('enable_auto_select')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Change button */}
            <div className="flex-shrink-0">
              {isEnabled ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSelectorOpen(true)}
                  disabled={saving}
                >
                  {t('change')}
                  <ChevronDown className="w-3 h-3 ml-1" />
                </Button>
              ) : (
                <Tooltip content={t('disabled_change_tooltip')} side="top">
                  <span>
                    <Button size="sm" variant="secondary" disabled className="cursor-not-allowed">
                      {t('change')}
                      <ChevronDown className="w-3 h-3 ml-1" />
                    </Button>
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
        </Card>

        {/* Model Selector Dialog */}
        <ModelSelectorDialog
          open={selectorOpen}
          onClose={() => setSelectorOpen(false)}
          onSelect={handleModelSelect}
          availableModels={status.availableModels}
          currentModelId={status.model?.id ?? undefined}
          autoSelect={status.autoSelect}
          onAutoSelectChange={handleAutoSelectToggle}
          onNavigateToModels={() => navigate(modelsSettingsPath)}
        />
      </div>
    </TooltipProvider>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function SectionHeader() {
  const t = useTranslations('search_ai.query_llm');
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{t('section_title')}</h3>
      <p className="text-xs text-muted mt-0.5">{t('section_description')}</p>
    </div>
  );
}
