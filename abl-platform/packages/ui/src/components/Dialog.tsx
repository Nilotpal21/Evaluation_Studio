'use client';

/**
 * Dialog Component
 *
 * Accessible modal dialog built on Radix UI primitives with Framer Motion
 * enter/exit animations. Provides focus trapping, ARIA attributes, and
 * keyboard interaction (Escape to close) out of the box.
 */

import { clsx } from 'clsx';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { springs, transitions } from '../tokens/index.js';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
}

const maxWidthStyles: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  maxWidth = 'md',
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            {/* Backdrop */}
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transitions.backdrop}
              />
            </RadixDialog.Overlay>

            {/* Centering wrapper */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              {/* Content */}
              <RadixDialog.Content
                asChild
                onEscapeKeyDown={() => onClose()}
                onPointerDownOutside={() => onClose()}
              >
                <motion.div
                  className={clsx(
                    'relative w-full bg-background-elevated border border-default rounded-2xl shadow-xl bg-noise',
                    maxWidthStyles[maxWidth],
                    className,
                  )}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={springs.default}
                >
                  {/* Header */}
                  {(title || description) && (
                    <div className="flex items-start justify-between p-6 pb-0">
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
                          aria-label="Close dialog"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </RadixDialog.Close>
                    </div>
                  )}

                  {/* Body */}
                  <div className="p-6 max-h-[calc(85vh-4rem)] overflow-y-auto">{children}</div>
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
