'use client';

import { clsx } from 'clsx';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { SectionHeader } from './SectionHeader';

const PHASE_BADGE: Record<string, string> = {
  INTERVIEW: 'bg-accent/10 text-accent',
  BLUEPRINT: 'bg-info/10 text-info',
  BUILD: 'bg-success/10 text-success',
  CREATE: 'bg-warning/10 text-warning',
};

interface DecisionEntry {
  date?: string;
  what: string;
  why?: string;
  phase?: string;
}

export function DecisionsSection() {
  const doc = useArchAIStore((s) => s.specDocument);
  const decisions = (doc?.decisions as DecisionEntry[]) ?? [];

  const hasContent = decisions.length > 0;
  const status = hasContent ? 'draft' : 'empty';

  return (
    <SectionHeader title="Decisions" status={status}>
      {!hasContent ? (
        <p className="text-xs text-foreground-muted/70">
          Decisions will appear as you progress through the interview
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {decisions.map((entry, i) => (
            <div key={i} className="rounded-lg border border-border/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">{entry.what}</span>
                {entry.phase && (
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                      PHASE_BADGE[entry.phase] ?? 'bg-foreground/5 text-foreground-muted',
                    )}
                  >
                    {entry.phase}
                  </span>
                )}
              </div>
              {entry.why && (
                <p className="mt-0.5 text-[11px] leading-relaxed text-foreground-muted">
                  {entry.why}
                </p>
              )}
              {entry.date && (
                <p className="mt-1 text-[10px] text-foreground-subtle">{entry.date}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionHeader>
  );
}
