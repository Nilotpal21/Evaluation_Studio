/**
 * TriggerManager Component
 *
 * Displays a list of supported triggers for a builtin pipeline,
 * with active/inactive toggles and sampling rate controls.
 *
 * Each trigger row shows: toggle, label, description, type badge,
 * kafka topic or schedule expression, and a sampling rate slider
 * (only visible when the trigger is active).
 *
 * Sampling rate unit contract: props and callbacks use a fraction
 * in [0, 1] (matching the backend schema in
 * `packages/pipeline-engine/src/schemas/pipeline-config.schema.ts`).
 * Percentage display (0–100%) is a UI concern kept local to this
 * component so draft state, dirty tracking, and API payloads
 * stay in fraction units everywhere else.
 */

'use client';

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { Badge, type BadgeVariant } from '../ui/Badge';
import type { TriggerEntry } from '@agent-platform/pipeline-engine';

// =============================================================================
// TYPES
// =============================================================================

export interface TriggerManagerProps {
  triggers: TriggerEntry[];
  activeTriggerIds: string[];
  /** Per-trigger sampling rate as a fraction in [0, 1] (1 = process all events). */
  triggerConfigs: Record<string, { samplingRate?: number }>;
  onToggleTrigger: (triggerId: string, active: boolean) => void;
  /** Emits sampling rate as a fraction in [0, 1]. */
  onSamplingRateChange: (triggerId: string, rate: number) => void;
  disabled?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

const TRIGGER_TYPE_BADGE_VARIANT: Record<string, BadgeVariant> = {
  kafka: 'info',
  schedule: 'accent',
  manual: 'default',
};

// Slider is calibrated in whole percent (0–100) for UX; stored/emitted as fraction (0–1).
const SAMPLING_PERCENT_MIN = 0;
const SAMPLING_PERCENT_MAX = 100;
const SAMPLING_PERCENT_STEP = 1;
/** Fraction used when no per-trigger rate is configured (matches backend default). */
const DEFAULT_SAMPLING_FRACTION = 1;

function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 100);
}

function percentToFraction(percent: number): number {
  return percent / 100;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TriggerManager({
  triggers,
  activeTriggerIds,
  triggerConfigs,
  onToggleTrigger,
  onSamplingRateChange,
  disabled,
}: TriggerManagerProps) {
  const t = useTranslations('pipelines');

  if (triggers.length === 0) {
    return (
      <p className="text-sm text-muted py-4">
        {t('config_section_triggers')} — no triggers defined.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {triggers.map((trigger) => {
        const isActive = activeTriggerIds.includes(trigger.id);
        const samplingFraction =
          triggerConfigs[trigger.id]?.samplingRate ?? DEFAULT_SAMPLING_FRACTION;
        const samplingPercent = fractionToPercent(samplingFraction);

        return (
          <div
            key={trigger.id}
            className={clsx(
              'rounded-lg border p-4 transition-default',
              isActive
                ? 'border-accent/30 bg-accent-subtle/20'
                : 'border-default bg-background-elevated',
            )}
          >
            {/* Row 1: toggle + label + type badge */}
            <div className="flex items-center gap-3">
              <Toggle
                checked={isActive}
                onChange={(checked) => onToggleTrigger(trigger.id, checked)}
                disabled={disabled}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground truncate">
                    {trigger.label}
                  </span>
                  <Badge variant={TRIGGER_TYPE_BADGE_VARIANT[trigger.type] ?? 'default'}>
                    {t(`trigger_type_${trigger.type}` as any)}
                  </Badge>
                  <span
                    className={clsx(
                      'text-xs font-medium',
                      isActive ? 'text-success' : 'text-muted',
                    )}
                  >
                    {isActive ? t('trigger_active') : t('trigger_inactive')}
                  </span>
                </div>
                {trigger.description && (
                  <p className="text-xs text-muted mt-0.5 line-clamp-2">{trigger.description}</p>
                )}
              </div>
            </div>

            {/* Row 2: Kafka topic / schedule + sampling rate */}
            <div className="mt-2 ml-12 space-y-2">
              {/* Topic or schedule expression */}
              {trigger.kafkaTopic && (
                <p className="text-xs text-subtle font-mono">topic: {trigger.kafkaTopic}</p>
              )}
              {trigger.schedule && (
                <p className="text-xs text-subtle font-mono">schedule: {trigger.schedule}</p>
              )}

              {/* Sampling rate slider — only when active */}
              {isActive && (
                <div className="flex items-center gap-3 pt-1">
                  <label className="text-xs font-medium text-muted whitespace-nowrap">
                    {t('trigger_sampling_rate')}
                  </label>
                  <input
                    type="range"
                    min={SAMPLING_PERCENT_MIN}
                    max={SAMPLING_PERCENT_MAX}
                    step={SAMPLING_PERCENT_STEP}
                    value={samplingPercent}
                    onChange={(e) =>
                      onSamplingRateChange(trigger.id, percentToFraction(Number(e.target.value)))
                    }
                    disabled={disabled}
                    className="flex-1 h-1.5 rounded-full appearance-none bg-background-muted accent-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="text-xs font-mono text-foreground w-10 text-right">
                    {samplingPercent}%
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
