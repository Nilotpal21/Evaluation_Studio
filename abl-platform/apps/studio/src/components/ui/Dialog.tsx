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
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { springs, transitions } from '../../lib/animation';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Width convention:
   * - `sm` / `md` — simple forms (1–3 fields, single concern). Default `md`.
   * - `lg` / `xl` / `2xl` — complex forms (multi-section, multi-column, code/regex
   *   blocks, browsers with scrollable lists). Pick the smallest that fits the
   *   content without horizontal crowding.
   * - `4xl`+ — full-screen-ish dialogs (rare; usually a panel/page is better).
   */
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '5xl' | '6xl' | '7xl';
  /**
   * When true, skip the default body wrapper (p-6 max-h overflow-y-auto) and
   * render `children` directly inside the dialog panel. Use for dialogs that
   * manage their own scrolling layout (e.g. sticky header/footer with a
   * single scroll region in the middle).
   */
  noBodyWrapper?: boolean;
}

const maxWidthStyles: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
  '7xl': 'max-w-7xl',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  maxWidth = 'md',
  noBodyWrapper = false,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            {/* Backdrop */}
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm"
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
                    'relative w-full bg-background-elevated border border-default rounded-2xl shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] bg-noise',
                    maxWidthStyles[maxWidth],
                    className,
                  )}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={springs.default}
                >
                  {/* DialogTitle - Always required for accessibility */}
                  {!title && (
                    <VisuallyHidden.Root>
                      <RadixDialog.Title>Dialog</RadixDialog.Title>
                    </VisuallyHidden.Root>
                  )}

                  {/* Header */}
                  {title || description ? (
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
                  ) : (
                    /* Radix requires DialogTitle for accessibility; hide it when callers render their own */
                    <RadixDialog.Title className="sr-only">Dialog</RadixDialog.Title>
                  )}

                  {/* Body — wrapped by default; caller can opt out via
                      noBodyWrapper to manage its own layout (sticky regions). */}
                  {noBodyWrapper ? (
                    children
                  ) : (
                    <div className="p-6 max-h-[calc(85vh-4rem)] overflow-y-auto">{children}</div>
                  )}
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
