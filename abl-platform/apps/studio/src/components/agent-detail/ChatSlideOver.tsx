'use client';

/**
 * ChatSlideOver -- slide-from-right panel for chatting with an agent.
 *
 * Structural shell with placeholder content. The actual ChatPanel will be
 * wired inside this wrapper in a future task.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import { springs, transitions } from '@/lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';

// =============================================================================
// CONSTANTS
// =============================================================================

const PANEL_WIDTH = 'w-[460px]';

// =============================================================================
// PROPS
// =============================================================================

export interface ChatSlideOverProps {
  /** Whether the panel is visible */
  isOpen: boolean;
  /** Callback to close the panel */
  onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ChatSlideOver({ isOpen, onClose }: ChatSlideOverProps) {
  const t = useTranslations('agents.chat_slide_over');
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="chat-backdrop"
            data-testid="chat-backdrop"
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="chat-panel"
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
                <MessageSquare className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
              </div>
              <button
                type="button"
                aria-label="Close chat panel"
                onClick={onClose}
                className={clsx(
                  'p-1.5 rounded-md transition-fast',
                  'text-muted hover:text-foreground hover:bg-background-muted',
                )}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content placeholder */}
            <div className="flex-1 flex items-center justify-center p-5">
              <div className="text-center">
                <MessageSquare className="w-10 h-10 text-muted mx-auto mb-3" />
                <p className="text-sm text-muted">{t('placeholder')}</p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
