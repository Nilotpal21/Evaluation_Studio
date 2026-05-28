/**
 * ModelSelectorDialog
 *
 * Modal dialog for selecting which LLM model powers the query pipeline.
 * Groups models by tier with fast-tier recommended badge.
 */

'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Zap, Scale, Crown } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
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

interface ModelSelectorDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (modelId: string) => void;
  availableModels: AvailableModel[];
  currentModelId?: string;
  /** Callback to navigate to model settings page (same-page navigation) */
  onNavigateToModels?: () => void;
  /** Whether auto-select is currently enabled */
  autoSelect?: boolean;
  /** Callback when auto-select toggle changes */
  onAutoSelectChange?: (enabled: boolean) => void;
}

const TIER_ORDER = ['fast', 'balanced', 'powerful'];

// ─── Component ────────────────────────────────────────────────────────────

export function ModelSelectorDialog({
  open,
  onClose,
  onSelect,
  availableModels,
  currentModelId,
  onNavigateToModels,
  autoSelect,
  onAutoSelectChange,
}: ModelSelectorDialogProps) {
  const t = useTranslations('search_ai.model_selector');
  const [selected, setSelected] = useState<string | null>(currentModelId ?? null);
  // Local override for immediate toggle response (parent update is async)
  const [localAutoSelect, setLocalAutoSelect] = useState<boolean | null>(null);
  const effectiveAutoSelect = localAutoSelect ?? autoSelect ?? false;
  // Reset local override when dialog opens/closes or parent value syncs
  if (localAutoSelect !== null && autoSelect === localAutoSelect) {
    // Parent caught up — clear local override on next render
    setTimeout(() => setLocalAutoSelect(null), 0);
  }

  const TIER_CONFIG = useMemo(
    () =>
      ({
        fast: {
          label: t('tier_fast'),
          icon: Zap,
          variant: 'success' as const,
          note: t('tier_fast_note'),
        },
        balanced: {
          label: t('tier_balanced'),
          icon: Scale,
          variant: 'info' as const,
          note: t('tier_balanced_note'),
        },
        powerful: {
          label: t('tier_powerful'),
          icon: Crown,
          variant: 'accent' as const,
          note: t('tier_powerful_note'),
        },
      }) as Record<
        string,
        { label: string; icon: typeof Zap; variant: 'success' | 'info' | 'accent'; note: string }
      >,
    [t],
  );

  // Group models by tier
  const modelsByTier = TIER_ORDER.reduce(
    (acc, tier) => {
      const models = availableModels.filter((m) => m.tier === tier);
      if (models.length > 0) acc[tier] = models;
      return acc;
    },
    {} as Record<string, AvailableModel[]>,
  );

  function handleSelect() {
    if (selected) {
      onSelect(selected);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="md">
      <div className="space-y-4">
        <p className="text-xs text-muted">{t('description')}</p>

        {/* Auto-select toggle */}
        {onAutoSelectChange && (
          <button
            type="button"
            onClick={() => {
              const next = !effectiveAutoSelect;
              setLocalAutoSelect(next);
              onAutoSelectChange(next);
              if (next) {
                onClose();
              }
            }}
            className="w-full flex items-center justify-between rounded-lg border border-default bg-background-subtle p-3 cursor-pointer hover:bg-background-muted transition-default"
          >
            <div className="text-left">
              <div className="text-sm font-medium text-foreground">{t('auto_select_label')}</div>
              <div className="text-xs text-muted mt-0.5">
                {effectiveAutoSelect
                  ? t('auto_select_on_description')
                  : t('auto_select_off_description')}
              </div>
            </div>
            <div
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-default shrink-0 ${effectiveAutoSelect ? 'bg-success' : 'bg-background-elevated border border-default'}`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full shadow-sm transition-transform ${effectiveAutoSelect ? 'bg-white translate-x-[18px]' : 'bg-foreground translate-x-[3px]'}`}
              />
            </div>
          </button>
        )}

        {/* Model list grouped by tier */}
        <div
          className={`space-y-4 max-h-[400px] overflow-y-auto ${effectiveAutoSelect ? 'opacity-40 pointer-events-none' : ''}`}
        >
          {TIER_ORDER.map((tier) => {
            const models = modelsByTier[tier];
            if (!models) return null;

            const tierConfig = TIER_CONFIG[tier];
            const TierIcon = tierConfig.icon;

            return (
              <div key={tier} className="space-y-2">
                <div className="flex items-center gap-2">
                  <TierIcon className="w-3.5 h-3.5 text-muted" />
                  <span className="text-xs font-semibold text-muted uppercase tracking-wide">
                    {t('tier_label', { tier: tierConfig.label })}
                  </span>
                  {tier === 'fast' && <Badge variant="success">{t('recommended')}</Badge>}
                </div>

                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => setSelected(model.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selected === model.id
                        ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                        : 'border-default hover:border-accent/40 hover:bg-background-subtle'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                            selected === model.id ? 'border-accent' : 'border-muted'
                          }`}
                        >
                          {selected === model.id && (
                            <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                          )}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            {getModelPrimaryName(model)}
                          </div>
                          <div className="text-xs text-muted mt-0.5">
                            {formatModelIdentityLine(model) || model.provider}
                            {model.id === currentModelId && (
                              <span className="ml-2 text-info">({t('current')})</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <Badge variant={tierConfig.variant}>{tierConfig.label}</Badge>
                    </div>
                    {tier !== 'fast' && (
                      <div className="mt-1.5 ml-5.5 text-xs text-warning">{tierConfig.note}</div>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        {/* Add model link */}
        {onNavigateToModels && (
          <div className="pt-2 border-t border-default">
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigateToModels();
              }}
              className="text-xs text-muted hover:text-foreground flex items-center gap-1"
            >
              {t('add_model_hint')}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSelect} disabled={!selected}>
            {t('select')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
