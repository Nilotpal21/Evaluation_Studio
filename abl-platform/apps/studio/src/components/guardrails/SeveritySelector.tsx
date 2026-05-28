'use client';

import { clsx } from 'clsx';

export type SeverityLevel = 'safe' | 'low' | 'medium' | 'high';

const SEVERITY_LEVELS: { value: SeverityLevel; label: string; threshold: number }[] = [
  { value: 'safe', label: 'Safe', threshold: 0 },
  { value: 'low', label: 'Low', threshold: 0.3 },
  { value: 'medium', label: 'Med', threshold: 0.5 },
  { value: 'high', label: 'High', threshold: 0.7 },
];

const SEVERITY_COLORS: Record<SeverityLevel, { active: string; inactive: string }> = {
  safe: {
    active: 'bg-success text-success-foreground',
    inactive: 'text-success hover:bg-success-subtle',
  },
  low: {
    active: 'bg-info text-info-foreground',
    inactive: 'text-info hover:bg-info-subtle',
  },
  medium: {
    active: 'bg-warning text-warning-foreground',
    inactive: 'text-warning hover:bg-warning-subtle',
  },
  high: {
    active: 'bg-error text-error-foreground',
    inactive: 'text-error hover:bg-error-subtle',
  },
};

interface SeveritySelectorProps {
  value: SeverityLevel;
  onChange: (level: SeverityLevel) => void;
  disabled?: boolean;
}

export function thresholdToSeverity(threshold: number): SeverityLevel {
  if (threshold >= 0.7) return 'high';
  if (threshold >= 0.5) return 'medium';
  if (threshold >= 0.3) return 'low';
  return 'safe';
}

export function severityToThreshold(level: SeverityLevel): number {
  const found = SEVERITY_LEVELS.find((l) => l.value === level);
  return found?.threshold ?? 0.5;
}

export function SeveritySelector({ value, onChange, disabled }: SeveritySelectorProps) {
  return (
    <div className="flex gap-1">
      {SEVERITY_LEVELS.map((level) => {
        const isActive = value === level.value;
        const colors = SEVERITY_COLORS[level.value];
        return (
          <button
            key={level.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(level.value)}
            className={clsx(
              'px-2.5 py-1 text-xs font-medium rounded-md transition-default',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              isActive ? colors.active : clsx('border border-default', colors.inactive),
            )}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}
