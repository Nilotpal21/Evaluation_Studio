'use client';

/**
 * ContentTypeBreakdown
 *
 * Horizontal bar chart showing content type distribution.
 * Top 4 types individually, rest grouped as "Other".
 */

import { useMemo } from 'react';

interface ContentTypeBreakdownProps {
  data: Array<{
    type: string;
    count: number;
    percentage: number;
  }>;
}

const BAR_COLORS = ['bg-accent', 'bg-info', 'bg-success', 'bg-warning', 'bg-muted'];

export function ContentTypeBreakdown({ data }: ContentTypeBreakdownProps) {
  const items = useMemo(() => {
    if (data.length <= 5) return data;
    const top4 = data.slice(0, 4);
    const rest = data.slice(4);
    const otherCount = rest.reduce((sum, item) => sum + item.count, 0);
    const otherPercentage = rest.reduce((sum, item) => sum + item.percentage, 0);
    return [...top4, { type: 'Other', count: otherCount, percentage: otherPercentage }];
  }, [data]);

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={item.type} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-foreground font-medium">{item.type}</span>
            <span className="text-muted">
              {item.count.toLocaleString()} ({item.percentage.toFixed(1)}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-background-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${BAR_COLORS[index % BAR_COLORS.length]}`}
              style={{ width: `${Math.max(item.percentage, 1)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
