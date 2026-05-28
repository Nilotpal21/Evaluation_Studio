'use client';

/**
 * SchedulePresetPicker
 *
 * Preset-based schedule configuration for cron triggers. Supports daily,
 * weekly, monthly, once, and custom cron expression modes. Generates a
 * cron preview and manages timezone selection.
 */

import { useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PresetConfig {
  preset: 'daily' | 'weekly' | 'monthly' | 'once' | 'cron';
  timezone: string;
  time?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  datetime?: string;
  cronExpression?: string;
}

interface SchedulePresetPickerProps {
  value: PresetConfig;
  onChange: (config: PresetConfig) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function presetToCron(config: PresetConfig): string | null {
  const [hours, minutes] = (config.time ?? '09:00').split(':').map(Number);

  switch (config.preset) {
    case 'daily':
      return `${minutes} ${hours} * * *`;
    case 'weekly':
      return `${minutes} ${hours} * * ${config.dayOfWeek ?? 1}`;
    case 'monthly':
      return `${minutes} ${hours} ${config.dayOfMonth ?? 1} * *`;
    case 'cron':
      return config.cronExpression ?? null;
    case 'once':
      return null; // One-shot triggers use datetime, not cron
    default:
      return null;
  }
}

function describeCron(expression: string): string {
  const patterns: Record<string, string> = {
    '* * * * *': 'Every minute',
    '0 * * * *': 'Every hour',
    '0 0 * * *': 'Daily at midnight',
    '0 9 * * *': 'Daily at 9:00 AM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 0 * * 1': 'Weekly on Monday at midnight',
    '0 0 1 * *': 'Monthly on the 1st at midnight',
  };
  return patterns[expression] ?? expression;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchedulePresetPicker({ value, onChange }: SchedulePresetPickerProps) {
  const t = useTranslations('workflows.triggers');

  const presets: { value: PresetConfig['preset']; label: string }[] = useMemo(
    () => [
      { value: 'daily', label: t('preset_daily') },
      { value: 'weekly', label: t('preset_weekly') },
      { value: 'monthly', label: t('preset_monthly') },
      { value: 'once', label: t('preset_once') },
      { value: 'cron', label: t('preset_cron') },
    ],
    [t],
  );

  const timezones: string[] = useMemo(() => {
    try {
      // Intl.supportedValuesOf is available in modern browsers but not in all TS libs
      const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
      if (typeof intl.supportedValuesOf === 'function') {
        return intl.supportedValuesOf('timeZone');
      }
      return FALLBACK_TIMEZONES;
    } catch {
      return FALLBACK_TIMEZONES;
    }
  }, []);

  const cronPreview = useMemo(() => {
    const cron = presetToCron(value);
    if (!cron) return null;
    return describeCron(cron);
  }, [value]);

  const resolvedCron = useMemo(() => presetToCron(value), [value]);

  const update = useCallback(
    (partial: Partial<PresetConfig>) => {
      onChange({ ...value, ...partial });
    },
    [value, onChange],
  );

  const inputClasses = clsx(
    'w-full px-3 py-2 text-sm rounded-lg border border-default',
    'bg-background-muted text-foreground',
    'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
  );

  return (
    <div className="space-y-4">
      {/* Preset selector */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">{t('schedule_preset')}</label>
        <div className="flex gap-2 flex-wrap">
          {presets.map((p) => (
            <button
              key={p.value}
              onClick={() =>
                update({
                  preset: p.value,
                  // Reset fields when switching preset
                  ...(p.value === 'cron'
                    ? { cronExpression: value.cronExpression ?? '0 9 * * 1-5' }
                    : {}),
                })
              }
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg border transition-default',
                value.preset === p.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default bg-background-muted text-muted hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Timezone */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">{t('timezone')}</label>
        <select
          value={value.timezone}
          onChange={(e) => update({ timezone: e.target.value })}
          aria-label={t('timezone')}
          className={inputClasses}
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      {/* Per-preset fields */}
      {(value.preset === 'daily' || value.preset === 'weekly' || value.preset === 'monthly') && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">{t('time')}</label>
          <input
            type="time"
            value={value.time ?? '09:00'}
            onChange={(e) => update({ time: e.target.value })}
            aria-label={t('time')}
            className={inputClasses}
          />
        </div>
      )}

      {value.preset === 'weekly' && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">{t('day_of_week')}</label>
          <select
            value={value.dayOfWeek ?? 1}
            onChange={(e) => update({ dayOfWeek: Number(e.target.value) })}
            aria-label={t('day_of_week')}
            className={inputClasses}
          >
            {DAYS_OF_WEEK.map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        </div>
      )}

      {value.preset === 'monthly' && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">{t('day_of_month')}</label>
          <select
            value={value.dayOfMonth ?? 1}
            onChange={(e) => update({ dayOfMonth: Number(e.target.value) })}
            aria-label={t('day_of_month')}
            className={inputClasses}
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      {value.preset === 'once' && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">{t('datetime')}</label>
          <input
            type="datetime-local"
            value={value.datetime ?? ''}
            onChange={(e) => update({ datetime: e.target.value })}
            aria-label={t('datetime')}
            className={inputClasses}
          />
        </div>
      )}

      {value.preset === 'cron' && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">{t('cron_expression_input')}</label>
          <input
            type="text"
            value={value.cronExpression ?? ''}
            onChange={(e) => update({ cronExpression: e.target.value })}
            placeholder="0 9 * * 1-5"
            aria-label={t('cron_expression_input')}
            className={clsx(inputClasses, 'font-mono')}
          />
        </div>
      )}

      {/* Cron preview */}
      {resolvedCron && (
        <div className="flex items-center gap-2 rounded-lg border border-default bg-background-muted p-3">
          <span className="text-xs font-medium text-muted">{t('cron_preview')}:</span>
          <code className="text-xs font-mono text-foreground">{resolvedCron}</code>
          {cronPreview && cronPreview !== resolvedCron && (
            <span className="text-xs text-muted">({cronPreview})</span>
          )}
        </div>
      )}
    </div>
  );
}
