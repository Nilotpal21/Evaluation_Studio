'use client';

/**
 * TimeRangeSelector Component
 *
 * Preset time range buttons (1h, 24h, 7d, 30d, 90d) with an optional
 * custom date-range picker. Exports the TimeRange interface for consumers.
 */

import { useState, useCallback } from 'react';
import { Calendar, Clock, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimeRangePreset = '1h' | '24h' | '7d' | '30d' | '90d' | 'custom';

export interface TimeRange {
  /** Active preset, or "custom" when the user picks arbitrary dates */
  preset: TimeRangePreset;
  /** Resolved start timestamp (always set) */
  start: Date;
  /** Resolved end timestamp (always set) */
  end: Date;
}

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRESETS: { label: string; value: TimeRangePreset }[] = [
  { label: '1h', value: '1h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '90d', value: '90d' },
];

function resolvePreset(preset: TimeRangePreset): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  switch (preset) {
    case '1h':
      start.setHours(start.getHours() - 1);
      break;
    case '24h':
      start.setDate(start.getDate() - 1);
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '90d':
      start.setDate(start.getDate() - 90);
      break;
    default:
      break;
  }
  return { start, end };
}

/** Format a Date to the datetime-local input value (YYYY-MM-DDTHH:mm) */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TimeRangeSelector({ value, onChange, className }: TimeRangeSelectorProps) {
  const t = useTranslations('observability');
  const [showCustom, setShowCustom] = useState(value.preset === 'custom');

  const handlePreset = useCallback(
    (preset: TimeRangePreset) => {
      if (preset === 'custom') {
        setShowCustom(true);
        return;
      }
      setShowCustom(false);
      const { start, end } = resolvePreset(preset);
      onChange({ preset, start, end });
    },
    [onChange],
  );

  const handleCustomStart = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const start = new Date(e.target.value);
      if (Number.isNaN(start.getTime())) return;
      onChange({ preset: 'custom', start, end: value.end });
    },
    [onChange, value.end],
  );

  const handleCustomEnd = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const end = new Date(e.target.value);
      if (Number.isNaN(end.getTime())) return;
      onChange({ preset: 'custom', start: value.start, end });
    },
    [onChange, value.start],
  );

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      {/* Preset row */}
      <div className="flex items-center gap-1">
        <Clock className="w-4 h-4 text-muted shrink-0" />
        <div className="flex items-center gap-1 rounded-lg bg-background-subtle border border-default p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              onClick={() => handlePreset(p.value)}
              className={clsx(
                'px-2.5 py-1 text-xs font-medium rounded-md transition-default',
                value.preset === p.value
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:text-foreground hover:bg-background-muted',
              )}
            >
              {p.label}
            </button>
          ))}

          {/* Custom toggle */}
          <button
            onClick={() => handlePreset('custom')}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-default',
              value.preset === 'custom' || showCustom
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-foreground hover:bg-background-muted',
            )}
          >
            <Calendar className="w-3 h-3" />
            {t('timeRange.custom')}
            <ChevronDown
              className={clsx('w-3 h-3 transition-transform', showCustom && 'rotate-180')}
            />
          </button>
        </div>
      </div>

      {/* Custom date picker (animated) */}
      <AnimatePresence>
        {showCustom && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-3 px-1">
              <label className="flex flex-col gap-1 text-xs text-muted">
                <span>{t('timeRange.from')}</span>
                <input
                  type="datetime-local"
                  value={toDateTimeLocal(value.start)}
                  onChange={handleCustomStart}
                  className={clsx(
                    'rounded-lg border border-default bg-background-subtle text-foreground',
                    'text-xs px-2 py-1.5 transition-default',
                    'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                  )}
                />
              </label>
              <span className="text-muted mt-4">-</span>
              <label className="flex flex-col gap-1 text-xs text-muted">
                <span>{t('timeRange.to')}</span>
                <input
                  type="datetime-local"
                  value={toDateTimeLocal(value.end)}
                  onChange={handleCustomEnd}
                  className={clsx(
                    'rounded-lg border border-default bg-background-subtle text-foreground',
                    'text-xs px-2 py-1.5 transition-default',
                    'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                  )}
                />
              </label>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
