/**
 * Reusable Chart Widget Component
 * Provides consistent styling and structure for voice analytics charts
 */

'use client';

import { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

interface ChartWidgetProps {
  title: string;
  description?: string;
  children: ReactNode;
  infoTooltip?: string;
  className?: string;
}

export function ChartWidget({
  title,
  description,
  children,
  infoTooltip,
  className = '',
}: ChartWidgetProps) {
  return (
    <div
      className={`bg-background-elevated rounded-xl border border-default overflow-hidden ${className}`}
    >
      {/* Widget Header */}
      <div className="px-6 py-4 border-b border-default">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description && <p className="text-xs text-muted mt-1">{description}</p>}
          </div>
          {infoTooltip && (
            <Tooltip content={infoTooltip} side="left">
              <button
                aria-label={`More information about ${title}`}
                className="text-muted hover:text-foreground transition-colors"
              >
                <Info className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Widget Content */}
      <div className="p-6">{children}</div>
    </div>
  );
}
