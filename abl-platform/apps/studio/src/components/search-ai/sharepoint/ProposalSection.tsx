'use client';

/**
 * ProposalSection
 *
 * Generic collapsible section wrapper for proposal review.
 * Contains a header (title + badge), expandable content area,
 * and action buttons in the footer.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button, type ButtonVariant } from '../../ui/Button';

interface ProposalSectionAction {
  label: string;
  variant: ButtonVariant;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

interface ProposalSectionProps {
  sectionId: string;
  title: string;
  badge: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  actions: ProposalSectionAction[];
  children: React.ReactNode;
}

export function ProposalSection({
  sectionId,
  title,
  badge,
  expanded,
  onToggle,
  actions,
  children,
}: ProposalSectionProps) {
  return (
    <div
      id={`proposal-section-${sectionId}`}
      className="border border-default rounded-lg bg-background-subtle"
    >
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-background-muted rounded-t-lg transition-default"
        aria-expanded={expanded}
        aria-controls={`proposal-section-content-${sectionId}`}
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
          )}
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        {badge}
      </button>

      {/* Content */}
      {expanded && (
        <div id={`proposal-section-content-${sectionId}`} className="px-4 pb-4 space-y-4">
          <div className="pt-2 border-t border-default">{children}</div>

          {/* Actions */}
          {actions.length > 0 && (
            <div className="flex items-center justify-end gap-2 pt-2">
              {actions.map((action) => (
                <Button
                  key={action.label}
                  variant={action.variant}
                  size="sm"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  loading={action.loading}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
