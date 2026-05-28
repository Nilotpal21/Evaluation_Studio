'use client';

/**
 * PerSiteProgressBar
 *
 * Individual site progress bar for sync progress view.
 * Shows site name, progress bar, percentage, and doc count.
 */

import { CheckCircle } from 'lucide-react';
import { Progress } from '../../ui/Progress';

interface PerSiteProgressBarProps {
  siteName: string;
  percentage: number;
  docsProcessed: number;
  docsTotal: number;
  isComplete: boolean;
}

export function PerSiteProgressBar({
  siteName,
  percentage,
  docsProcessed,
  docsTotal,
  isComplete,
}: PerSiteProgressBarProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground truncate max-w-[50%]">{siteName}</span>
        <span className="text-muted flex items-center gap-1.5">
          {isComplete ? (
            <CheckCircle className="w-3.5 h-3.5 text-success" />
          ) : (
            <span>
              {percentage.toFixed(0)}% ({docsProcessed}/{docsTotal})
            </span>
          )}
        </span>
      </div>
      <Progress value={percentage} indicatorClassName={isComplete ? 'bg-success' : ''} />
    </div>
  );
}
