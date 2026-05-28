/**
 * FeatureCard Component
 *
 * Displays an LLM feature with its status, model info, and configuration options.
 * Matches the wireframe layout: Feature Name → Toggle → Status Badge, with
 * "Change" button at top-right. Disabled state replaces model info with
 * suggestion text and adds tooltip on the Change button.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  Clock,
  XCircle,
  Info,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Settings,
  Bot,
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { useNavigationStore } from '../../store/navigation-store';
import { ModelSelectorDialog } from './ModelSelectorDialog';
import { formatModelIdentityLine, getModelPrimaryName } from '../../lib/model-display';

// ─── Types ───────────────────────────────────────────────────────────────

interface AvailableModel {
  id: string;
  displayName: string;
  provider: string;
  modelId: string;
  tier: string;
  supportsTools?: boolean;
}

export interface FeatureCardProps {
  /** Feature name (e.g., "progressiveSummarization") */
  feature: string;

  /** Display name (e.g., "Progressive Summarization") */
  displayName: string;

  /** Short description */
  description: string;

  /** Lucide icon name */
  icon: string;

  /** Feature status */
  status: 'active' | 'pending' | 'disabled' | 'fallback' | 'degraded';

  /** Whether feature is enabled (user toggle) */
  enabled: boolean;

  /** Requested model tier */
  modelTier: 'fast' | 'balanced' | 'powerful';

  /** Resolved model info (only present if active/fallback) */
  model?: {
    modelId: string;
    provider: string;
    tier: 'fast' | 'balanced' | 'powerful';
    displayName: string;
  };

  /** Resolution metadata */
  resolution: {
    reason: string;
    attemptedTier: string;
    fallbackChain?: string[];
    message: string;
  };

  /** Action required (for pending features) */
  actionRequired?: {
    action: string;
    message: string;
    ctaText: string;
    ctaLink: string;
  };

  /** Cost estimate */
  estimatedCost?: {
    perDocument: number;
    perMonth: number;
    currency: string;
  };

  /** Feature parameters */
  params?: Record<string, any>;

  /** Available tenant models for the model selector */
  availableModels?: AvailableModel[];

  /** Project ID for same-page navigation to model settings */
  projectId?: string;

  /** Callback when feature is enabled/disabled */
  onToggle?: (enabled: boolean) => void;

  /** Callback when configuration changes */
  onChange?: (config: Record<string, any>) => void;

  /** Callback when model is selected for this feature */
  onModelChange?: (modelId: string | null, autoSelect: boolean) => void;
}

// ─── Component ───────────────────────────────────────────────────────────

export function FeatureCard({
  feature,
  displayName,
  description,
  icon,
  status,
  enabled,
  modelTier,
  model,
  resolution,
  actionRequired,
  estimatedCost,
  params,
  availableModels,
  projectId,
  onToggle,
  onChange,
  onModelChange,
}: FeatureCardProps) {
  const t = useTranslations('search_ai.feature_card');
  const navigate = useNavigationStore((s) => s.navigate);
  const [expanded, setExpanded] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);

  const statusConfig = useMemo(
    () =>
      ({
        active: {
          icon: CheckCircle2,
          variant: 'success' as BadgeVariant,
          label: t('status_active'),
          color: 'text-success',
        },
        pending: {
          icon: Clock,
          variant: 'warning' as BadgeVariant,
          label: t('status_pending'),
          color: 'text-warning',
        },
        disabled: {
          icon: XCircle,
          variant: 'default' as BadgeVariant,
          label: t('status_disabled'),
          color: 'text-muted',
        },
        fallback: {
          icon: Info,
          variant: 'info' as BadgeVariant,
          label: t('status_fallback'),
          color: 'text-info',
        },
        degraded: {
          icon: AlertTriangle,
          variant: 'error' as BadgeVariant,
          label: t('status_degraded'),
          color: 'text-error',
        },
      }) satisfies Record<
        FeatureCardProps['status'],
        {
          icon: React.ComponentType<{ className?: string }>;
          variant: BadgeVariant;
          label: string;
          color: string;
        }
      >,
    [t],
  );

  const config = statusConfig[status];

  // Get icon component dynamically
  const IconComponent = (LucideIcons as any)[icon] || Settings;

  // Determine if auto-select is active (currently always true since we don't have per-feature pinning yet)
  const isAutoSelected = resolution.reason !== 'pinned';

  function handleModelSelect(modelId: string) {
    onModelChange?.(modelId, false);
    setSelectorOpen(false);
  }

  function handleAutoSelectToggle(autoSelect: boolean) {
    if (autoSelect) {
      onModelChange?.(null, true);
    } else if (model) {
      // Pin current model
      onModelChange?.(model.modelId, false);
    }
  }

  return (
    <TooltipProvider>
      <Card className="p-4" hoverable={false}>
        <div className="flex items-start justify-between gap-3">
          {/* Left: Icon + Content */}
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Icon */}
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent-subtle flex items-center justify-center">
              <IconComponent className="w-5 h-5 text-accent" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              {/* Name + Toggle + Badge row */}
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">{displayName}</h3>

                {/* Toggle */}
                {onToggle && (
                  <Toggle checked={enabled} onChange={onToggle} ariaLabel={displayName} />
                )}

                {/* Status Badge */}
                {enabled ? (
                  <Badge variant={config.variant}>
                    {status === 'active' && <config.icon className="w-3 h-3" />}
                    {config.label}
                  </Badge>
                ) : (
                  <Badge variant="default">{t('status_disabled')}</Badge>
                )}
              </div>

              {/* Model Info (enabled) or suggestion text (disabled) */}
              {enabled && model ? (
                <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted flex-wrap">
                  <span>{getModelPrimaryName(model)}</span>
                  <span className="text-muted/50">·</span>
                  <span>
                    {t('label_tier')} {model.tier}
                  </span>
                  {formatModelIdentityLine(model) && (
                    <>
                      <span className="text-muted/50">·</span>
                      <span>{formatModelIdentityLine(model)}</span>
                    </>
                  )}
                </div>
              ) : !enabled ? (
                <div className="text-xs text-muted mt-1.5">
                  Turn on to automatically assign the best available model
                </div>
              ) : null}

              <p className="text-xs text-muted mt-1.5 leading-relaxed">{description}</p>

              {/* Resolution Message */}
              {enabled && resolution.message && (
                <div className={`text-xs mt-1.5 ${config.color}`}>{resolution.message}</div>
              )}

              {/* No model resolved (enabled but no model) */}
              {enabled && !model && status !== 'disabled' && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-warning">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('no_model')}</span>
                </div>
              )}

              {/* Action Required */}
              {actionRequired && (
                <div className="mt-3 p-3 rounded-lg bg-warning-subtle border border-warning/20">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground mb-2">{actionRequired.message}</p>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (actionRequired.ctaLink.startsWith('/') && projectId) {
                            navigate(
                              actionRequired.ctaLink === '/admin/models'
                                ? `/projects/${projectId}/settings/models`
                                : actionRequired.ctaLink,
                            );
                          } else {
                            navigate(actionRequired.ctaLink);
                          }
                        }}
                      >
                        {actionRequired.ctaText}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Cost Estimate (shown inline) */}
              {enabled && estimatedCost && (
                <div className="flex items-center gap-1.5 mt-2 text-xs">
                  <span className="text-muted">{t('label_estimated_cost')}</span>
                  <span className="text-foreground font-medium">
                    {t('cost_per_doc', { cost: estimatedCost.perDocument.toFixed(4) })}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Change button + Expand button */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Change button */}
            {availableModels && availableModels.length > 0 && (
              <>
                {enabled ? (
                  <Button size="sm" variant="secondary" onClick={() => setSelectorOpen(true)}>
                    {t('change_model')}
                    <ChevronDown className="w-3 h-3 ml-1" />
                  </Button>
                ) : (
                  <Tooltip content="Enable the feature to select a model" side="top">
                    <span>
                      <Button size="sm" variant="secondary" disabled className="cursor-not-allowed">
                        {t('change_model')}
                        <ChevronDown className="w-3 h-3 ml-1" />
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </>
            )}

            {/* Expand Parameters Button */}
            {params && Object.keys(params).length > 0 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="p-1 rounded hover:bg-background-muted transition-colors"
              >
                {expanded ? (
                  <ChevronUp className="w-4 h-4 text-muted" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Expanded Parameters */}
        {expanded && params && (
          <div className="mt-4 pt-4 border-t border-border space-y-3">
            <h4 className="text-xs font-semibold text-foreground mb-2">{t('configuration')}</h4>

            {Object.entries(params).map(([key, value]) => {
              // Skip internal fields
              if (['enabled', 'modelTier', 'model', 'provider', 'apiKey'].includes(key)) {
                return null;
              }

              return (
                <div key={key} className="flex items-center justify-between gap-4">
                  <label className="text-xs text-muted capitalize">
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                  </label>
                  <input
                    type={typeof value === 'number' ? 'number' : 'text'}
                    value={value}
                    onChange={(e) => {
                      const newValue =
                        typeof value === 'number' ? Number(e.target.value) : e.target.value;
                      onChange?.({ ...params, [key]: newValue });
                    }}
                    className="w-32 px-2 py-1 text-xs rounded border border-border bg-background-elevated focus:outline-none focus:ring-1 focus:ring-border-focus"
                    disabled={!enabled}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Model Selector Dialog */}
        {availableModels && availableModels.length > 0 && (
          <ModelSelectorDialog
            open={selectorOpen}
            onClose={() => setSelectorOpen(false)}
            onSelect={handleModelSelect}
            availableModels={availableModels}
            currentModelId={model?.modelId}
            onNavigateToModels={
              projectId ? () => navigate(`/projects/${projectId}/settings/models`) : undefined
            }
            autoSelect={isAutoSelected}
            onAutoSelectChange={onModelChange ? handleAutoSelectToggle : undefined}
          />
        )}
      </Card>
    </TooltipProvider>
  );
}
