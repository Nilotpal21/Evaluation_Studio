'use client';

/**
 * ScrollToBottomButton — fixed-within-scroll-area chevron button.
 * Fades in when the user has scrolled more than 200px from the bottom.
 * Positioned absolute inside a relative wrapper around the scroll container.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({ visible, onClick }: ScrollToBottomButtonProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
          onClick={onClick}
          aria-label="Scroll to bottom"
          className="absolute bottom-4 right-4 rounded-full border border-border bg-background p-2 shadow-sm transition-colors hover:bg-background-subtle"
        >
          <ChevronDown className="h-4 w-4 text-foreground/60" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
