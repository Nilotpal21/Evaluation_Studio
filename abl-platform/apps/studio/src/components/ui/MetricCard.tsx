'use client';

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { METRIC_NUMBER_CLASS } from '../../lib/format/metric-style';
import { SECTION_LABEL_CLASS } from '../../lib/typography';

interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: {
    value: string;
    direction: 'up' | 'down' | 'neutral';
    favorable: boolean;
  };
  context?: string;
  icon?: React.ReactNode;
  className?: string;
}

/**
 * Animate a numeric value from 0 to `end` over `duration` ms.
 * Returns the current display value as a string.
 * Non-numeric values (e.g. "—", "3 / 5") are returned immediately.
 */
function useCountUp(value: string | number, duration = 600): string {
  const [display, setDisplay] = useState('0');
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    // If value is a pure integer, animate it
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num === 0) {
      setDisplay(String(value));
      return;
    }

    const end = num;
    startTimeRef.current = 0;

    const tick = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(eased * end);
      setDisplay(String(current));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return display;
}

export function MetricCard({ label, value, trend, context, icon, className }: MetricCardProps) {
  const animatedValue = useCountUp(value);

  const trendColor = trend
    ? trend.direction === 'neutral'
      ? 'text-subtle'
      : (trend.direction === 'up') === trend.favorable
        ? 'text-success'
        : 'text-error'
    : '';

  const trendArrow = trend
    ? trend.direction === 'up'
      ? '↑'
      : trend.direction === 'down'
        ? '↓'
        : '→'
    : '';

  return (
    <div
      className={clsx(
        'bg-background-elevated border border-default rounded-xl p-4 card-hover',
        className,
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon && <span className="text-subtle">{icon}</span>}
        <span className={SECTION_LABEL_CLASS}>{label}</span>
      </div>
      <p className={clsx('text-2xl font-semibold text-foreground', METRIC_NUMBER_CLASS)}>
        {animatedValue}
      </p>
      {/* Reserve the trend/context row height even when empty so sibling
          MetricCards in a grid stay the same height regardless of content. */}
      <div className="flex items-center gap-2 mt-1 min-h-[1rem]">
        {trend && (
          <span className={clsx('text-xs font-medium', METRIC_NUMBER_CLASS, trendColor)}>
            {trendArrow} {trend.value}
          </span>
        )}
        {context && <span className="text-xs text-subtle">{context}</span>}
      </div>
    </div>
  );
}
