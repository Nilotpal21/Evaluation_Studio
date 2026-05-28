'use client';

/**
 * GuidanceBanner — Post-discovery guidance shown before user starts selecting.
 *
 * Uses InfoCard (dismissible). Shows after discovery completes when auto-matched
 * sections exist. Two actions: "Select suggested sections" and "I'll pick manually".
 * Dismissible, state stored in parent (not localStorage — avoids stale state across sources).
 */

import { InfoCard } from '@/components/ui/InfoCard';
import { Button } from '@/components/ui/Button';
import { Sparkles } from 'lucide-react';

export interface GuidanceBannerProps {
  /** Number of auto-matched sections found */
  suggestedCount: number;
  /** Called when user clicks "Select suggested sections" */
  onSelectSuggested: () => void;
  /** Called when user dismisses the banner (picks manually or X) */
  onDismiss: () => void;
}

export function GuidanceBanner({
  suggestedCount,
  onSelectSuggested,
  onDismiss,
}: GuidanceBannerProps) {
  if (suggestedCount === 0) return null;

  return (
    <div className="px-4 pt-2" data-testid="tree-guidance-banner">
      <InfoCard
        variant="info"
        size="sm"
        title="Select the content you want to crawl"
        onDismiss={onDismiss}
        message={
          <div className="space-y-2">
            <p>
              We found content matching your samples in{' '}
              <strong>
                {suggestedCount} {suggestedCount === 1 ? 'section' : 'sections'}
              </strong>
              . They&apos;re pre-selected below. Review and adjust, or explore more sections.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="primary"
                size="xs"
                onClick={() => {
                  onSelectSuggested();
                  onDismiss();
                }}
                icon={<Sparkles className="w-3.5 h-3.5" />}
              >
                Select suggested sections
              </Button>
              <Button variant="ghost" size="xs" onClick={onDismiss}>
                I&apos;ll pick manually
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
