'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { ConfirmationInput, ConfirmationAnswer } from './types';

interface ConfirmationProps {
  input: ConfirmationInput;
  onSubmit: (answer: ConfirmationAnswer) => void;
  statusMirror?: {
    label: string;
    onJumpToPanel: () => void;
  };
}

/**
 * Confirmation widget — Contract 5
 * Two buttons side by side. Either is a valid response. No validation needed.
 */
export function Confirmation({ input, onSubmit, statusMirror }: ConfirmationProps) {
  const { confirmLabel, denyLabel } = input;
  const [submitted, setSubmitted] = useState(false);
  const [submittedValue, setSubmittedValue] = useState<boolean | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleClick = useCallback(
    (value: boolean) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitted(true);
      setSubmittedValue(value);
      onSubmit(value);
    },
    [onSubmit],
  );

  if (statusMirror) {
    return (
      <div className="my-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm">
        <span className="text-foreground-muted">{statusMirror.label}</span>
        <button
          type="button"
          onClick={statusMirror.onJumpToPanel}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          Open review
        </button>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        {submittedValue ? confirmLabel : denyLabel}
      </div>
    );
  }

  return (
    <motion.div
      ref={containerRef}
      tabIndex={0}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 flex gap-3"
    >
      <button
        onClick={() => handleClick(true)}
        className="btn-press rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
      >
        {confirmLabel}
      </button>
      <button
        onClick={() => handleClick(false)}
        className="btn-press rounded-lg border border-border px-5 py-2.5 text-sm text-foreground/80 transition-colors hover:bg-background-muted"
      >
        {denyLabel}
      </button>
    </motion.div>
  );
}
