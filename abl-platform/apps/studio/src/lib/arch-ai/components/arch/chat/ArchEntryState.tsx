'use client';

/**
 * ArchEntryState — orchestrates the three entry zones:
 *   Zone A: ArchHeroStrip (full variant) — always shown
 *   Zone B: SessionResumeCard — only when an existing session is passed
 *   Zone C: UseCaseChips — always shown (hidden when session card is shown)
 *
 * The page injects contextual inline content, such as provider/config warnings,
 * between the resume card and the use-case prompts.
 */

import type { ReactNode } from 'react';
import type { ArchSession } from '@agent-platform/arch-ai';
import { ArchHeroStrip } from './ArchHeroStrip';
import { SessionResumeCard } from './SessionResumeCard';
import { UseCaseChips } from './UseCaseChips';

interface ChipSelectPayload {
  chatPrompt: string;
  projectName: string;
  projectDescription: string;
}

interface ArchEntryStateProps {
  /** Non-null when an existing active session with prior history should be surfaced. */
  session: ArchSession | null;
  onContinue: () => void;
  onDismiss: () => void;
  sessionError?: string | null;
  /** Called when the user clicks a use-case chip. */
  onChipSend: (payload: ChipSelectPayload) => void;
  /** Contextual inline slot rendered before the use-case prompts. */
  children: ReactNode;
}

export function ArchEntryState({
  session,
  onContinue,
  onDismiss,
  sessionError,
  onChipSend,
  children,
}: ArchEntryStateProps) {
  return (
    <div className="flex flex-col gap-6 pb-4">
      {/* Zone A — Hero */}
      <ArchHeroStrip variant="full" />

      {/* Zone B — Session resume card (only if existing session passed) */}
      {session && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-foreground/40">You have an in-progress session.</p>
          <SessionResumeCard
            session={session}
            onContinue={onContinue}
            onDismiss={onDismiss}
            error={sessionError}
          />
        </div>
      )}

      {/* Extra slot (error banners etc.) */}
      {children}

      {/* Zone C — Use-case chips — always shown */}
      <UseCaseChips onSelect={onChipSend} />
    </div>
  );
}
