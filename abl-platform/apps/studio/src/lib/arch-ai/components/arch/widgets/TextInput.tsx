'use client';
import { motion } from 'framer-motion';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { TextInputInput, TextInputAnswer } from './types';

interface TextInputProps {
  input: TextInputInput;
  onSubmit: (answer: TextInputAnswer) => void;
}

function resolveInitialValue(defaultValue?: string, placeholder?: string): string {
  const trimmedDefault = defaultValue?.trim();
  if (trimmedDefault) {
    return defaultValue ?? '';
  }

  const trimmedPlaceholder = placeholder?.trim();
  if (!trimmedPlaceholder) {
    return '';
  }

  if (/^(e\.g\.,?|for example[:,]?)/i.test(trimmedPlaceholder)) {
    return trimmedPlaceholder.replace(/^(e\.g\.,?|for example[:,]?)\s*/i, '');
  }

  return '';
}

/**
 * TextInput widget — Contract 5
 * Single-line or multi-line. Enter submits. Shift+Enter for newlines in multiline.
 * Cannot submit empty/whitespace-only.
 */
export function TextInput({ input, onSubmit }: TextInputProps) {
  const { placeholder, multiline, defaultValue } = input;
  const [value, setValue] = useState(() => resolveInitialValue(defaultValue, placeholder));
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || submitted) return;
    setSubmitted(true);
    onSubmit(trimmed);
  }, [value, submitted, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (multiline && e.shiftKey) return; // Allow newline in multiline
        e.preventDefault();
        handleSubmit();
      }
    },
    [multiline, handleSubmit],
  );

  if (submitted) {
    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted whitespace-pre-wrap">
        {value.trim()}
      </div>
    );
  }

  const sharedProps = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(e.target.value),
    onKeyDown: handleKeyDown,
    placeholder: placeholder ?? 'Type your answer...',
    className:
      'w-full rounded-lg border border-border bg-background-elevated px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/40 transition-colors focus:border-accent',
  };

  const canSubmit = !!value.trim();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 flex gap-2"
    >
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          {...sharedProps}
          rows={3}
        />
      ) : (
        <input ref={inputRef as React.RefObject<HTMLInputElement>} type="text" {...sharedProps} />
      )}
      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className={`btn-press self-end rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
          canSubmit
            ? 'bg-accent text-accent-foreground hover:bg-accent-muted'
            : 'cursor-not-allowed border border-border bg-background-subtle text-foreground/30'
        }`}
      >
        Submit
      </button>
    </motion.div>
  );
}
