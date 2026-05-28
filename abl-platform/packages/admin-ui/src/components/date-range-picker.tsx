'use client';

import { useState } from 'react';
import { cn } from '../lib/cn';

const PRESETS = [
  { id: '24h', label: '24h', hours: 24 },
  { id: '7d', label: '7d', hours: 7 * 24 },
  { id: '30d', label: '30d', hours: 30 * 24 },
  { id: '90d', label: '90d', hours: 90 * 24 },
] as const;

type PresetId = (typeof PRESETS)[number]['id'] | 'custom';

interface DateRangePickerProps {
  onChange: (range: { from: string; to: string }) => void;
  defaultRange?: string;
  className?: string;
}

function computeRange(presetId: string): { from: string; to: string } {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    // Fallback to 7d
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: now.toISOString() };
  }
  const now = new Date();
  const from = new Date(now.getTime() - preset.hours * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

export function DateRangePicker({
  onChange,
  defaultRange = '7d',
  className,
}: DateRangePickerProps) {
  const [selected, setSelected] = useState<PresetId>(defaultRange as PresetId);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  function handlePresetClick(presetId: PresetId) {
    setSelected(presetId);
    if (presetId !== 'custom') {
      onChange(computeRange(presetId));
    }
  }

  function handleCustomApply() {
    if (customFrom && customTo) {
      onChange({
        from: new Date(customFrom).toISOString(),
        to: new Date(customTo).toISOString(),
      });
    }
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => handlePresetClick(preset.id)}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium transition-colors',
            'border',
            selected === preset.id
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-border bg-transparent text-foreground-muted hover:text-foreground hover:border-foreground-subtle',
          )}
        >
          {preset.label}
        </button>
      ))}

      <button
        type="button"
        onClick={() => handlePresetClick('custom')}
        className={cn(
          'rounded-full px-3 py-1 text-xs font-medium transition-colors',
          'border',
          selected === 'custom'
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-border bg-transparent text-foreground-muted hover:text-foreground hover:border-foreground-subtle',
        )}
      >
        Custom
      </button>

      {selected === 'custom' && (
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className={cn(
              'h-7 rounded-md border px-2 text-xs',
              'border-border',
              'bg-background-subtle',
              'text-foreground',
              'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
            )}
          />
          <span className="text-xs text-foreground-muted">to</span>
          <input
            type="datetime-local"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className={cn(
              'h-7 rounded-md border px-2 text-xs',
              'border-border',
              'bg-background-subtle',
              'text-foreground',
              'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
            )}
          />
          <button
            type="button"
            onClick={handleCustomApply}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium',
              'bg-accent text-accent-foreground',
              'hover:bg-accent/85',
              'transition-colors',
            )}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
