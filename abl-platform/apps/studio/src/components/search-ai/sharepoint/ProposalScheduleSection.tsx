'use client';

/**
 * ProposalScheduleSection
 *
 * Displays schedule configuration: sync frequency and recommendation.
 * In simplified view, provides inline frequency editing.
 */

import { useState, useCallback } from 'react';
import { Calendar } from 'lucide-react';
import { Button } from '../../ui/Button';

const FREQUENCY_OPTIONS = ['hourly', 'daily', 'weekly', 'monthly'] as const;

interface ProposalScheduleSectionProps {
  frequency: string;
  recommendedFrequency: string;
  nextRun: string | null;
  simplifiedView: boolean;
  onModify?: (data: Record<string, unknown>) => void;
  labels: {
    frequency_label: string;
    recommended_label: string;
    next_run_label: string;
    not_scheduled: string;
    save_changes: string;
    frequency_hourly: string;
    frequency_daily: string;
    frequency_weekly: string;
    frequency_monthly: string;
  };
}

export function ProposalScheduleSection({
  frequency,
  recommendedFrequency,
  nextRun,
  simplifiedView,
  onModify,
  labels,
}: ProposalScheduleSectionProps) {
  const [editing, setEditing] = useState(false);
  const [editFrequency, setEditFrequency] = useState(frequency);

  const frequencyLabelMap: Record<string, string> = {
    hourly: labels.frequency_hourly,
    daily: labels.frequency_daily,
    weekly: labels.frequency_weekly,
    monthly: labels.frequency_monthly,
  };

  const handleSave = useCallback(() => {
    onModify?.({
      frequency: editFrequency,
      recommendedFrequency,
      nextRun,
    });
    setEditing(false);
  }, [editFrequency, recommendedFrequency, nextRun, onModify]);

  return (
    <div className="space-y-3">
      {/* Frequency */}
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4 text-accent flex-shrink-0" />
        <span className="text-sm text-muted">{labels.frequency_label}:</span>
        {editing && simplifiedView ? (
          <div className="flex items-center gap-2">
            <select
              value={editFrequency}
              onChange={(e) => setEditFrequency(e.target.value)}
              className="rounded-lg border border-default bg-background-subtle text-foreground text-sm py-1.5 px-2"
              aria-label={labels.frequency_label}
            >
              {FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {frequencyLabelMap[opt] ?? opt}
                </option>
              ))}
            </select>
            <Button variant="primary" size="xs" onClick={handleSave}>
              {labels.save_changes}
            </Button>
          </div>
        ) : (
          <span className="text-sm font-medium text-foreground">
            {frequencyLabelMap[frequency] ?? frequency}
          </span>
        )}
        {simplifiedView && !editing && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            {labels.save_changes}
          </Button>
        )}
      </div>

      {/* Recommended */}
      {recommendedFrequency !== frequency && (
        <p className="text-xs text-muted">
          {labels.recommended_label}:{' '}
          {frequencyLabelMap[recommendedFrequency] ?? recommendedFrequency}
        </p>
      )}

      {/* Next run */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{labels.next_run_label}:</span>
        <span className="text-sm text-foreground">
          {nextRun
            ? new Date(nextRun).toLocaleDateString(undefined, { dateStyle: 'medium' })
            : labels.not_scheduled}
        </span>
      </div>
    </div>
  );
}
