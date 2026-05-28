'use client';

/**
 * PhaseTransitionMarker — hairline divider inserted between messages when
 * the session phase advances (e.g. INTERVIEW → BLUEPRINT).
 *
 * Rendered inline in the message list when the current message's phase
 * differs from the previous message's phase.
 */

import { motion } from 'framer-motion';

const PHASE_LABELS: Record<string, string> = {
  INTERVIEW: 'Interview',
  BLUEPRINT: 'Blueprint',
  BUILD: 'Build',
  CREATE: 'Create',
};

interface PhaseTransitionMarkerProps {
  phase: string;
}

export function PhaseTransitionMarker({ phase }: PhaseTransitionMarkerProps) {
  const label = PHASE_LABELS[phase] ?? phase;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="flex items-center gap-3 px-4 py-3"
      aria-label={`Phase transition: ${label}`}
    >
      <div className="h-px flex-1 bg-border/40" />
      <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/30">
        {label}
      </span>
      <div className="h-px flex-1 bg-border/40" />
    </motion.div>
  );
}
