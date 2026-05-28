'use client';

/**
 * SlidePanel Component
 *
 * Slide-out panel from the right edge. Built on Radix Dialog for
 * accessibility (focus trap, Escape key, ARIA) with Framer Motion animations.
 */

import { clsx } from 'clsx';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { springs, transitions } from '../../lib/animation';

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  width?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | 'full';
  /** When true, no backdrop overlay and clicking outside does not close the panel.
   * The panel sits alongside the page content without blocking interaction. */
  nonBlocking?: boolean;
  /** Inline style overrides for the panel container (use for dynamic top/height that
   * Tailwind JIT can't generate from variable class strings). */
  style?: React.CSSProperties;
  /** When true, the body wrapper has no padding — useful when children manage their own layout. */
  noPadding?: boolean;
}

const widthStyles: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '4xl': 'max-w-4xl',
  full: 'max-w-full',
};

export function SlidePanel({
  open,
  onClose,
  title,
  description,
  children,
  className,
  width = 'md',
  nonBlocking = false,
  style,
  noPadding = false,
}: SlidePanelProps) {
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      modal={!nonBlocking}
    >
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            {/* Backdrop — hidden in nonBlocking mode so page stays interactive */}
            {!nonBlocking && (
              <RadixDialog.Overlay asChild>
                <motion.div
                  className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={transitions.backdrop}
                />
              </RadixDialog.Overlay>
            )}

            {/* Panel — anchored to right edge */}
            <RadixDialog.Content
              asChild
              onEscapeKeyDown={() => onClose()}
              onOpenAutoFocus={(e) => {
                if (nonBlocking) e.preventDefault(); // Don't steal focus from page
              }}
              onPointerDownOutside={(e) => {
                if (nonBlocking) {
                  e.preventDefault();
                } else {
                  onClose();
                }
              }}
              onInteractOutside={(e) => {
                if (nonBlocking) e.preventDefault();
              }}
              // Disable focus trap for nonBlocking mode so page stays interactive
              {...(nonBlocking ? { 'aria-modal': false } : {})}
            >
              <motion.div
                className={clsx(
                  'fixed top-0 right-0 z-50 h-full w-full bg-background-elevated border-l border-default shadow-xl flex flex-col',
                  widthStyles[width],
                  className,
                )}
                style={style}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={springs.gentle}
              >
                {/* DialogTitle — always present for accessibility */}
                {!title && (
                  <VisuallyHidden.Root>
                    <RadixDialog.Title>Panel</RadixDialog.Title>
                  </VisuallyHidden.Root>
                )}

                {/* Header */}
                {(title || description) && (
                  <div className="flex items-start justify-between p-6 pb-4 border-b border-default shrink-0">
                    <div>
                      {title && (
                        <RadixDialog.Title className="text-lg font-semibold text-foreground">
                          {title}
                        </RadixDialog.Title>
                      )}
                      {description && (
                        <RadixDialog.Description className="text-sm text-muted mt-1">
                          {description}
                        </RadixDialog.Description>
                      )}
                    </div>
                    <RadixDialog.Close asChild>
                      <button
                        className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
                        aria-label="Close panel"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </RadixDialog.Close>
                  </div>
                )}

                {/* Body */}
                <div className={clsx('flex-1 overflow-y-auto', !noPadding && 'p-6')}>
                  {children}
                </div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
