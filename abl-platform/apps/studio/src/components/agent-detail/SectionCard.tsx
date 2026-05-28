'use client';

/**
 * SectionCard — collapsible card wrapper for agent detail sections.
 *
 * Every section (Identity, Tools, Gather, Flow, Rules, Coordination, Lifecycle)
 * renders inside a SectionCard. It provides consistent expand/collapse UX,
 * the Arch integration point (sparkle button), save feedback, and empty-state prompts.
 */

import React, { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Sparkles, Check, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { SectionId, SaveStatus } from '@/store/agent-detail-store';
import { springs } from '@/lib/animation';

// =============================================================================
// CONSTANTS
// =============================================================================

const SECTION_EMPTY_KEYS: Record<string, string> = {
  TOOLS: 'no_tools_defined',
  GATHER: 'no_gather_fields_defined',
  FLOW: 'no_flow_steps_defined',
  RULES: 'no_rules_defined',
  COORDINATION: 'no_coordination_configured',
  LIFECYCLE: 'no_lifecycle_hooks_configured',
};

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface SaveIndicatorProps {
  status: SaveStatus;
}

function SaveIndicator({ status }: SaveIndicatorProps) {
  const t = useTranslations('agents.section_card');
  if (status === 'idle') return null;

  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t('saving')}
      </span>
    );
  }

  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <Check className="w-3 h-3" />
        {t('saved')}
      </span>
    );
  }

  if (status === 'error') {
    return <span className="flex items-center gap-1 text-xs text-error">{t('save_failed')}</span>;
  }

  return null;
}

// =============================================================================
// PROPS
// =============================================================================

export interface SectionCardProps {
  /** Section display name */
  title: string;
  /** Section identifier for store lookups */
  sectionId: SectionId;
  /** Optional item count badge */
  count?: number;
  /** Controlled expand state */
  isExpanded: boolean;
  /** Toggle callback */
  onToggle: () => void;
  /** Arch sparkle button callback */
  onArchClick?: () => void;
  /** Collapsed summary content */
  summary?: ReactNode;
  /** Expanded editor content */
  children: ReactNode;
  /** Save status indicator */
  saveStatus?: SaveStatus;
  /** Show empty state prompt */
  isEmpty?: boolean;
  /** Additional className */
  className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SectionCard({
  title,
  sectionId,
  count,
  isExpanded,
  onToggle,
  onArchClick,
  summary,
  children,
  saveStatus,
  isEmpty,
  className,
}: SectionCardProps) {
  const t = useTranslations('agents.section_card');
  const ChevronIcon = isExpanded ? ChevronUp : ChevronDown;

  return (
    <div
      className={clsx(
        'rounded-xl border bg-background-elevated shadow-sm',
        isExpanded ? 'border-accent/30 shadow-md' : 'border-default',
        className,
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className={clsx(
          'w-full flex items-center justify-between px-4 py-3',
          'transition-fast cursor-pointer',
          'focus-ring rounded-xl',
        )}
      >
        {/* Left: title + count badge + summary */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-foreground">{title}</span>

          {count !== undefined && (
            <span className="rounded-full bg-accent-subtle text-accent text-xs font-medium px-1.5 h-5 flex items-center justify-center">
              {count}
            </span>
          )}

          {!isExpanded && summary && <span className="text-xs text-muted truncate">{summary}</span>}
        </div>

        {/* Right: save indicator + arch button + chevron */}
        <div className="flex items-center gap-2 shrink-0">
          {isExpanded && saveStatus && <SaveIndicator status={saveStatus} />}

          {onArchClick && (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Ask Arch about ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onArchClick();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onArchClick();
                }
              }}
              className={clsx('p-1 rounded-md transition-fast', 'text-purple hover:bg-purple/10')}
            >
              <Sparkles className="w-4 h-4" />
            </span>
          )}

          <ChevronIcon className="w-4 h-4 text-muted" />
        </div>
      </button>

      {/* Empty state (shown when collapsed and empty) */}
      {isEmpty && !isExpanded && (
        <div className="px-4 pb-3 -mt-1">
          <span className="text-xs text-subtle">
            {t(SECTION_EMPTY_KEYS[sectionId] ?? 'no_items_defined')}.{' '}
          </span>
          {onArchClick && (
            <button
              type="button"
              onClick={onArchClick}
              className="text-xs text-purple hover:underline transition-fast"
            >
              {t('ask_arch_to_suggest')} &rarr;
            </button>
          )}
        </div>
      )}

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.gentle}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-4 pb-4 pt-1 border-t border-default/50">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
