/**
 * MetricInfoIcon Component
 *
 * Displays an info icon that opens a dialog with detailed explanation
 * about a voice metric when clicked. Used in voice metrics cards.
 */

'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';

interface MetricInfoIconProps {
  /**
   * The metric key for translation lookup (e.g., 'asr_quality', 'e2e_latency')
   */
  metricKey: string;
  /**
   * Optional custom className for the button
   */
  className?: string;
}

export function MetricInfoIcon({ metricKey, className }: MetricInfoIconProps) {
  const [open, setOpen] = useState(false);
  const tv = useTranslations(`sessions.voice.${metricKey}`);
  const tVoice = useTranslations('sessions.voice');

  return (
    <>
      <TooltipProvider>
        <Tooltip content={tVoice('click_for_details')} side="top">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            className={`p-1 text-muted hover:text-accent transition-colors rounded-md hover:bg-background-muted ${className || ''}`}
            aria-label={`More information about ${tv('title')}`}
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={open} onClose={() => setOpen(false)} title={tv('info_title')} maxWidth="lg">
        <div className="space-y-4">
          {/* Description */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-2">What is this metric?</h4>
            <p className="text-sm text-muted leading-relaxed">{tv('info_description')}</p>
          </div>

          {/* How it works */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-2">How it works</h4>
            <p className="text-sm text-muted leading-relaxed">{tv('info_how_it_works')}</p>
          </div>

          {/* Example */}
          <div className="rounded-lg bg-background-subtle border border-default p-4">
            <h4 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
              <span className="text-accent">💡</span>
              Example
            </h4>
            <p className="text-sm text-muted leading-relaxed italic">{tv('info_example')}</p>
          </div>
        </div>
      </Dialog>
    </>
  );
}
