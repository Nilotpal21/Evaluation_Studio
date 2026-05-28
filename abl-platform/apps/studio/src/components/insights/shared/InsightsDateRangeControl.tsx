/**
 * InsightsDateRangeControl
 *
 * The shared date-range control used across every Insights surface
 * (Dashboard, Quality Monitor, Customer Insights, Billing, Agent
 * Performance, Voice Analytics, Analytics). One visual treatment, one
 * mental model — replaces the four bespoke variants the audit found
 * (dropdown, inline pills, two SegmentedControls with different option
 * sets, plus a missing one on Agent Performance).
 *
 * The audit's design call (Theme 1) settled on SegmentedControl as
 * the lone treatment because it surfaces the available ranges at a
 * glance, which dropdowns hide behind a click.
 *
 * Two presets cover almost every surface:
 *
 *   - `day` (7d / 30d / 90d) — the executive cadence used by every
 *     review surface where "minutes" granularity is irrelevant.
 *   - `operational` (30m / 1h / 24h / 7d / 30d) — Analytics' shorter
 *     windows for live operational triage.
 *
 * Voice Analytics historically uses a 3-option subset (24h / 7d /
 * 30d) so it gets its own preset rather than forcing a granularity
 * change.
 *
 * Surfaces with non-preset ranges can pass an explicit `options`
 * array. A `Custom` range option is intentionally NOT in Phase 1 —
 * it would require a calendar dialog and is a separate scope.
 *
 * Audit reference: Theme 1.
 */

'use client';

import { SegmentedControl, type SegmentOption } from '../../ui/SegmentedControl';

export type DayRange = '7d' | '30d' | '90d';
export type OperationalRange = '30m' | '1h' | '24h' | '7d' | '30d';
export type VoiceRange = '24h' | '7d' | '30d';

const DAY_OPTIONS: SegmentOption[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
];

const OPERATIONAL_OPTIONS: SegmentOption[] = [
  { id: '30m', label: '30m' },
  { id: '1h', label: '1h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];

const VOICE_OPTIONS: SegmentOption[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];

export type DateRangePreset = 'day' | 'operational' | 'voice';

const PRESET_OPTIONS: Record<DateRangePreset, SegmentOption[]> = {
  day: DAY_OPTIONS,
  operational: OPERATIONAL_OPTIONS,
  voice: VOICE_OPTIONS,
};

interface InsightsDateRangeControlProps {
  value: string;
  onChange: (value: string) => void;
  preset?: DateRangePreset;
  options?: SegmentOption[];
  className?: string;
  ariaLabel?: string;
}

export function InsightsDateRangeControl({
  value,
  onChange,
  preset = 'day',
  options,
  className,
  ariaLabel = 'Date range',
}: InsightsDateRangeControlProps) {
  const resolvedOptions = options ?? PRESET_OPTIONS[preset];
  return (
    <SegmentedControl
      ariaLabel={ariaLabel}
      size="sm"
      value={value}
      onChange={onChange}
      options={resolvedOptions}
      className={className}
    />
  );
}
