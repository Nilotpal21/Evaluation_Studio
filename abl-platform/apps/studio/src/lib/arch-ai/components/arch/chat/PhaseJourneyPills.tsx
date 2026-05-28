'use client';

/**
 * PhaseJourneyPills — decorative phase flow indicator shown in the Arch entry hero.
 * Educational only — shows the three-stage journey: Interview → Blueprint → Build.
 */

export function PhaseJourneyPills() {
  const phases = ['Interview', 'Blueprint', 'Build'] as const;

  return (
    <div className="flex items-center gap-1.5">
      {phases.map((phase, idx) => (
        <div key={phase} className="flex items-center gap-1.5">
          {idx > 0 && <span className="text-[10px] text-foreground/20">→</span>}
          <span className="rounded-full bg-foreground/[0.05] px-3 py-1 font-mono text-xs text-foreground/50">
            {phase}
          </span>
        </div>
      ))}
    </div>
  );
}
