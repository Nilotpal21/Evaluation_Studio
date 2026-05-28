'use client';

/**
 * SectionHeader -- shared AI assistant button rendered at the top of each
 * section editor when `onArchClick` is provided. Clicking the sparkle button
 * opens the Arch panel with context for the current section.
 */

import { Sparkles } from 'lucide-react';

interface SectionHeaderProps {
  onArchClick?: () => void;
}

export function SectionHeader({ onArchClick }: SectionHeaderProps) {
  if (!onArchClick) return null;

  return (
    <div className="flex justify-end mb-2">
      <button
        onClick={onArchClick}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-accent/70 hover:text-accent hover:bg-accent-subtle transition-default"
        title="Ask AI for help with this section"
      >
        <Sparkles className="w-3 h-3" />
        AI Assist
      </button>
    </div>
  );
}
