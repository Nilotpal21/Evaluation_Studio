'use client';

/**
 * ContinueCTA — Type 9 message block.
 * Appears after the last historical message once the preload orchestrator
 * finishes. Clicking dismisses the card (with an exit animation) so the user
 * can continue the conversation.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CornerDownLeft } from 'lucide-react';

interface ContinueCTAProps {
  onDismiss?: () => void;
}

export function ContinueCTA({ onDismiss }: ContinueCTAProps) {
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mt-4 rounded-xl border border-border/40 bg-background-subtle px-5 py-3"
        >
          <div className="flex items-center gap-3">
            <CornerDownLeft className="h-4 w-4 shrink-0 text-foreground/30" />
            <p className="flex-1 text-sm text-foreground/60">Continuing from where you left off</p>
            <button
              onClick={handleDismiss}
              className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              Continue →
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
