'use client';
import { motion } from 'framer-motion';

import { useState, useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import type { SingleSelectInput, SingleSelectAnswer } from './types';

interface SingleSelectProps {
  input: SingleSelectInput;
  onSubmit: (answer: SingleSelectAnswer) => void;
}

/**
 * SingleSelect widget — Contract 5
 * Horizontal wrapping pill buttons. One selection. Optional "Other" inline input.
 * Keyboard: ArrowUp/Down to navigate, Enter to select.
 */
export function SingleSelect({ input, onSubmit }: SingleSelectProps) {
  const { options, allowCustom, defaultValue } = input;
  const normalizedDefault = defaultValue?.trim();
  const defaultOptionIndex =
    normalizedDefault == null
      ? -1
      : options.findIndex(
          (option) => option.value === normalizedDefault || option.label === normalizedDefault,
        );
  const initialCustomText =
    normalizedDefault && defaultOptionIndex === -1 && allowCustom ? normalizedDefault : '';
  const [focusIndex, setFocusIndex] = useState(defaultOptionIndex >= 0 ? defaultOptionIndex : 0);
  const [submitted, setSubmitted] = useState(false);
  const [submittedValue, setSubmittedValue] = useState('');
  const [showCustom, setShowCustom] = useState(initialCustomText.length > 0);
  const [customText, setCustomText] = useState(initialCustomText);
  const containerRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  const handleSelect = useCallback(
    (value: string) => {
      if (submitted) return;
      setSubmitted(true);
      setSubmittedValue(value);
      onSubmit(value);
    },
    [submitted, onSubmit],
  );

  const handleCustomSubmit = useCallback(() => {
    const trimmed = customText.trim();
    if (trimmed && !submitted) {
      handleSelect(`Custom: ${trimmed}`);
    }
  }, [customText, submitted, handleSelect]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showCustom) {
      customInputRef.current?.focus();
    }
  }, [showCustom]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (submitted) return;

      if (showCustom) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCustomSubmit();
        } else if (e.key === 'Escape') {
          setShowCustom(false);
          containerRef.current?.focus();
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const max = allowCustom ? options.length : options.length - 1;
        setFocusIndex((prev) => Math.min(prev + 1, max));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setFocusIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (focusIndex < options.length) {
          handleSelect(options[focusIndex].value);
        } else if (allowCustom) {
          setShowCustom(true);
        }
      }
    },
    [submitted, showCustom, focusIndex, options, allowCustom, handleSelect, handleCustomSubmit],
  );

  if (submitted) {
    return (
      <div data-widget="SingleSelect" className="my-3">
        <span className="inline-flex items-center rounded-full bg-accent/15 px-4 py-2 text-sm font-medium text-accent">
          {submittedValue}
        </span>
      </div>
    );
  }

  return (
    <motion.div
      data-widget="SingleSelect"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 flex flex-wrap gap-2 outline-none"
    >
      {options.map((option, i) => (
        <button
          key={option.value}
          data-value={option.value}
          onClick={() => handleSelect(option.value)}
          className={clsx(
            'inline-flex items-center rounded-full border px-4 py-2 text-sm font-medium transition-colors',
            i === focusIndex
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-border bg-background-elevated text-foreground/60 hover:border-foreground/20 hover:text-foreground/80',
          )}
        >
          {option.label}
        </button>
      ))}
      {allowCustom && !showCustom && (
        <button
          onClick={() => setShowCustom(true)}
          className={clsx(
            'inline-flex items-center rounded-full border border-dashed px-4 py-2 text-sm font-medium transition-colors',
            focusIndex === options.length
              ? 'border-accent text-accent'
              : 'border-border bg-background-elevated text-foreground/40 hover:border-foreground/30 hover:text-foreground/60',
          )}
        >
          Other...
        </button>
      )}
      {showCustom && (
        <div className="flex w-full gap-2 pt-1">
          <input
            ref={customInputRef}
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Type your answer..."
            className="flex-1 rounded-full border border-accent bg-background px-4 py-2 text-sm outline-none"
          />
          <button
            onClick={handleCustomSubmit}
            disabled={!customText.trim()}
            className="btn-press rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      )}
    </motion.div>
  );
}
