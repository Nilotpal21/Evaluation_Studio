'use client';

import { clsx } from 'clsx';

export interface ActivityItem {
  id: string;
  icon?: React.ReactNode;
  description: string;
  timestamp: string;
  onClick?: () => void;
}

interface ActivityTimelineProps {
  items: ActivityItem[];
  maxItems?: number;
  className?: string;
}

export function ActivityTimeline({ items, maxItems = 8, className }: ActivityTimelineProps) {
  const visible = items.slice(0, maxItems);

  return (
    <div className={clsx('space-y-0', className)}>
      {visible.map((item, i) => (
        <div
          key={item.id}
          role={item.onClick ? 'button' : undefined}
          tabIndex={item.onClick ? 0 : undefined}
          onClick={item.onClick}
          onKeyDown={(e) => {
            if (item.onClick && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              item.onClick();
            }
          }}
          className={clsx(
            'flex items-start gap-3 py-2 px-2 rounded-md',
            item.onClick && 'cursor-pointer hover:bg-background-muted transition-default',
            i < visible.length - 1 && 'border-b border-default/50',
          )}
        >
          {item.icon && <span className="mt-0.5 text-subtle shrink-0">{item.icon}</span>}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground truncate">{item.description}</p>
          </div>
          <span className="text-xs text-subtle shrink-0 mt-0.5">{item.timestamp}</span>
        </div>
      ))}
      {visible.length === 0 && (
        <p className="text-sm text-subtle italic py-4 text-center">No recent activity</p>
      )}
    </div>
  );
}
