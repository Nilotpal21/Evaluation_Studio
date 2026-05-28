'use client';

/**
 * SlidePanel Component
 *
 * Slide-out panel from the right edge. Built on Radix Dialog for
 * accessibility (focus trap, Escape key, ARIA) with Framer Motion animations.
 */

import { clsx } from 'clsx';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { springs, transitions } from '../tokens/index.js';

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  width?: 'sm' | 'md' | 'lg';
}

const widthStyles: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export function SlidePanel({
  open,
  onClose,
  title,
  description,
  children,
  className,
  width = 'md',
}: SlidePanelProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            {/* Backdrop */}
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transitions.backdrop}
              />
            </RadixDialog.Overlay>

            {/* Panel — anchored to right edge */}
            <RadixDialog.Content
              asChild
              onEscapeKeyDown={() => onClose()}
              onPointerDownOutside={() => onClose()}
            >
              <motion.div
                className={clsx(
                  'fixed top-0 right-0 z-50 h-full w-full bg-background-elevated border-l border-default shadow-xl flex flex-col bg-noise',
                  widthStyles[width],
                  className,
                )}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={springs.gentle}
              >
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
                <div className="flex-1 overflow-y-auto p-6">{children}</div>
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
