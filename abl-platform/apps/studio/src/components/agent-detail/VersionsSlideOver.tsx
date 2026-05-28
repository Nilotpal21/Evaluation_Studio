'use client';

/**
 * VersionsSlideOver -- slide-from-right panel wrapping the version list.
 *
 * Structural shell with placeholder content. The actual VersionListTab will be
 * wired inside this wrapper in a future task.
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, GitBranch } from 'lucide-react';
import clsx from 'clsx';
import { springs, transitions } from '@/lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';
import { VersionListTab } from '../agents/VersionListTab';

// =============================================================================
// CONSTANTS
// =============================================================================

const PANEL_WIDTH = 'w-[460px]';

// =============================================================================
// PROPS
// =============================================================================

export interface VersionsSlideOverProps {
  /** Whether the panel is visible */
  isOpen: boolean;
  /** Callback to close the panel */
  onClose: () => void;
  /** Project identifier */
  projectId: string;
  /** Agent name */
  agentName: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function VersionsSlideOver({
  isOpen,
  onClose,
  projectId,
  agentName,
}: VersionsSlideOverProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="versions-backdrop"
            data-testid="versions-backdrop"
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="versions-panel"
            className={clsx(
              'fixed top-0 right-0 z-50 h-full',
              PANEL_WIDTH,
              'bg-background-elevated border-l border-default shadow-xl',
              'flex flex-col',
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
              <div className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">Versions</h2>
              </div>
              <button
                type="button"
                aria-label="Close versions panel"
                onClick={onClose}
                className={clsx(
                  'p-1.5 rounded-md transition-fast',
                  'text-muted hover:text-foreground hover:bg-background-muted',
                )}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Version list content */}
            <div className="flex-1 overflow-y-auto px-5">
              <VersionListTab projectId={projectId} agentName={agentName} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
