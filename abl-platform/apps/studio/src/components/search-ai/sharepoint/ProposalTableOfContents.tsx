'use client';

/**
 * ProposalTableOfContents
 *
 * Renders a list of proposal sections with status badges.
 * Clicking a section scrolls to the corresponding section element.
 */

import { useCallback } from 'react';
import { Badge, type BadgeVariant } from '../../ui/Badge';

interface TOCEntry {
  sectionId: string;
  label: string;
  status: 'pending' | 'accepted' | 'modified' | 'skipped';
}

interface ProposalTableOfContentsProps {
  entries: TOCEntry[];
  activeSectionId: string | null;
  onSectionClick: (sectionId: string) => void;
  progressLabel: string;
}

const STATUS_BADGE_MAP: Record<TOCEntry['status'], { variant: BadgeVariant; key: string }> = {
  pending: { variant: 'default', key: 'Pending' },
  accepted: { variant: 'success', key: 'Accepted' },
  modified: { variant: 'accent', key: 'Modified' },
  skipped: { variant: 'warning', key: 'Skipped' },
};

export function ProposalTableOfContents({
  entries,
  activeSectionId,
  onSectionClick,
  progressLabel,
}: ProposalTableOfContentsProps) {
  const handleClick = useCallback(
    (sectionId: string) => {
      onSectionClick(sectionId);
      const el = document.getElementById(`proposal-section-${sectionId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [onSectionClick],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">{progressLabel}</p>
      </div>

      <nav className="space-y-1" aria-label="Proposal sections">
        {entries.map((entry) => {
          const badgeInfo = STATUS_BADGE_MAP[entry.status];
          const isActive = entry.sectionId === activeSectionId;

          return (
            <button
              key={entry.sectionId}
              type="button"
              onClick={() => handleClick(entry.sectionId)}
              className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-left text-sm transition-default ${
                isActive
                  ? 'bg-accent-subtle text-accent font-medium'
                  : 'hover:bg-background-muted text-foreground'
              }`}
            >
              <span>{entry.label}</span>
              <Badge variant={badgeInfo.variant}>{badgeInfo.key}</Badge>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
