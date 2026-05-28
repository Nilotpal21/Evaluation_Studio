'use client';

interface ProgressBarProps {
  /** Value between 0 and 100 */
  value: number;
  /** Optional label shown to the right of the bar */
  label?: string;
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-background-muted"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-gradient-brand transition-all duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {label !== undefined && (
        <span className="shrink-0 text-xs text-foreground-muted">{label}</span>
      )}
    </div>
  );
}
