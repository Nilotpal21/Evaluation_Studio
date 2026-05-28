'use client';

/**
 * ArchHeroStrip — two variants:
 *   "full"    — shown in entry state (no messages). Hero with tagline + PhaseJourneyPills.
 *   "compact" — shown in active state (messages present). Header strip with icon + project name + phase badge + reset.
 */

import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { MessageSquarePlus } from 'lucide-react';
import { ArchGradientMark } from '@/components/arch-shared/ArchGradientMark';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { SpecialistChip } from './SpecialistChip';

const PHASE_BADGE_CLASSES: Record<string, string> = {
  INTERVIEW: 'border-warning/40 bg-warning-subtle text-warning',
  BLUEPRINT: 'border-info/40 bg-info-subtle text-info',
  BUILD: 'border-success/40 bg-success-subtle text-success',
  CREATE: 'border-purple/40 bg-purple-subtle text-purple',
};

interface ArchHeroStripProps {
  variant: 'full' | 'compact';
  projectName?: string;
  phase?: string | null;
  onReset?: () => void;
  /** Extra action buttons rendered to the left of "New chat" */
  headerActions?: ReactNode;
}

export function ArchHeroStrip({
  variant,
  projectName,
  phase,
  onReset,
  headerActions,
}: ArchHeroStripProps) {
  if (variant === 'compact') {
    return (
      <CompactHeroStrip
        projectName={projectName}
        phase={phase}
        onReset={onReset}
        headerActions={headerActions}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ArchGradientMark size="md" />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Hi, I&apos;m Arch</h1>
        <p className="text-sm leading-relaxed text-foreground/50">
          Tell me what you want to build. I&apos;ll ask a few questions, design the agent
          architecture, write the code, and get it ready to deploy as a working project.
        </p>
      </div>
    </div>
  );
}

/**
 * Compact variant — extracted so we can subscribe to the Arch UI store
 * (useArchUIStore) for the live specialist indicator without re-rendering
 * the full hero variant.
 */
function CompactHeroStrip({
  projectName,
  phase,
  onReset,
  headerActions,
}: Omit<ArchHeroStripProps, 'variant'>) {
  // Atomic-selector: returns { name, icon } | null. Re-renders only when
  // the active specialist actually changes.
  const currentSpecialist = useArchUIStore((s) => s.currentSpecialist);
  const badgeClass = phase ? PHASE_BADGE_CLASSES[phase] : '';
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <ArchGradientMark size="xs" />
        <span className="text-sm font-semibold text-foreground truncate">
          {projectName || 'Arch'}
        </span>
        {phase && (
          <span
            className={clsx(
              'shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide',
              badgeClass,
            )}
          >
            {phase}
          </span>
        )}
        {currentSpecialist && (
          <SpecialistChip name={currentSpecialist.name} icon={currentSpecialist.icon} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {headerActions}
        {onReset && (
          <button
            onClick={onReset}
            title="New chat"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground/60 transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            <MessageSquarePlus className="h-3 w-3" />
            New chat
          </button>
        )}
      </div>
    </div>
  );
}
