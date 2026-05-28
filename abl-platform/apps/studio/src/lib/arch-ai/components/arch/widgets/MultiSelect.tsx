'use client';
import { motion } from 'framer-motion';

import { useState, useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import type { MultiSelectInput, MultiSelectAnswer } from './types';

interface MultiSelectProps {
  input: MultiSelectInput;
  onSubmit: (answer: MultiSelectAnswer) => void;
}

/**
 * MultiSelect widget — Contract 5
 * Horizontal wrapping toggle pills. Min/max selection count. Optional custom items.
 */
export function MultiSelect({ input, onSubmit }: MultiSelectProps) {
  const { options, minSelect = 1, maxSelect, allowCustom, defaultValues } = input;
  const initialSelections = (() => {
    const normalizedDefaults = (defaultValues ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const optionValues = new Set<string>();
    const customValues = new Set<string>();

    for (const value of normalizedDefaults) {
      const matchedOption = options.find(
        (option) => option.value === value || option.label === value,
      );
      if (matchedOption) {
        optionValues.add(matchedOption.value);
        continue;
      }

      if (allowCustom) {
        customValues.add(value.startsWith('Custom: ') ? value : `Custom: ${value}`);
      }
    }

    return {
      selected: [...optionValues, ...customValues],
      customItems: [...customValues],
    };
  })();
  const [selected, setSelected] = useState<string[]>(initialSelections.selected);
  const [submitted, setSubmitted] = useState(false);
  const [customText, setCustomText] = useState('');
  const [customItems, setCustomItems] = useState<string[]>(initialSelections.customItems);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const canSubmit = selected.length >= minSelect && (!maxSelect || selected.length <= maxSelect);

  const toggleOption = useCallback(
    (value: string) => {
      if (submitted) return;
      setSelected((prev) => {
        if (prev.includes(value)) {
          return prev.filter((v) => v !== value);
        }
        if (maxSelect && prev.length >= maxSelect) return prev;
        return [...prev, value];
      });
    },
    [submitted, maxSelect],
  );

  const handleAddCustom = useCallback(() => {
    const trimmed = customText.trim();
    const customValue = `Custom: ${trimmed}`;
    if (trimmed && !customItems.includes(customValue)) {
      setCustomItems((prev) => [...prev, customValue]);
      setSelected((prev) => {
        if (maxSelect && prev.length >= maxSelect) return prev;
        return [...prev, customValue];
      });
      setCustomText('');
    }
  }, [customText, customItems, maxSelect]);

  const handleSubmit = useCallback(() => {
    if (!canSubmit || submitted) return;
    setSubmitted(true);
    onSubmit(selected);
  }, [canSubmit, submitted, selected, onSubmit]);

  if (submitted) {
    return (
      <div className="my-3 flex flex-wrap gap-2">
        {selected.map((value) => (
          <span
            key={value}
            className="inline-flex items-center rounded-full bg-accent/15 px-4 py-2 text-sm font-medium text-accent"
          >
            {value}
          </span>
        ))}
      </div>
    );
  }

  const allOptions = [...options, ...customItems.map((item) => ({ label: item, value: item }))];

  return (
    <motion.div
      ref={containerRef}
      tabIndex={0}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 flex flex-col gap-3 outline-none"
    >
      <div className="flex flex-wrap gap-2">
        {allOptions.map((option) => {
          const isSelected = selected.includes(option.value);
          return (
            <button
              key={option.value}
              onClick={() => toggleOption(option.value)}
              className={clsx(
                'rounded-full px-4 py-2 text-sm font-medium transition-colors',
                isSelected
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-foreground/[0.07] text-foreground/75 hover:bg-foreground/[0.11] hover:text-foreground/90',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {allowCustom && (
        <div className="flex gap-2">
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddCustom();
              }
            }}
            placeholder="Add custom option..."
            className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={handleAddCustom}
            disabled={!customText.trim()}
            className="rounded-full border border-accent px-4 py-2 text-sm text-accent disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-xs text-foreground-muted">
          {selected.length < minSelect
            ? `Select at least ${minSelect}`
            : `${selected.length} selected`}
        </span>
        {canSubmit && (
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={handleSubmit}
            className="btn-press rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
          >
            Done
          </motion.button>
        )}
      </div>
    </motion.div>
  );
}
