'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

const STEPS = [
  'Running pre-built scenarios…',
  'Running SOP-derived tests…',
  'Running user-defined tests…',
  'Scoring categories…',
  'Generating report…',
];

export function ReRunButton({ onComplete }: { onComplete?: () => void }) {
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(0);

  const run = () => {
    if (running) return;
    setRunning(true);
    setStep(0);
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setStep(i);
      if (i >= STEPS.length) {
        clearInterval(interval);
        setTimeout(() => {
          setRunning(false);
          setStep(0);
          onComplete?.();
        }, 600);
      }
    }, 1100);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className={cn(
          'h-9 px-3 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed',
          running && 'bg-background-elevated text-foreground-muted',
        )}
      >
        <RefreshCw className={cn('size-3.5', running && 'animate-spin')} />
        {running ? 'Re-running…' : 'Re-run evaluation'}
      </button>
      {running && (
        <div className="absolute top-full mt-2 right-0 w-[280px] rounded-md border border-border bg-background-elevated shadow-xl p-3 animate-fade-in z-20">
          <div className="text-[11px] text-foreground-muted mb-2">{STEPS[Math.min(step, STEPS.length - 1)]}</div>
          <div className="h-1 rounded-full bg-background-muted overflow-hidden">
            <div
              className="h-full bg-foreground/80 transition-all duration-1000"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
