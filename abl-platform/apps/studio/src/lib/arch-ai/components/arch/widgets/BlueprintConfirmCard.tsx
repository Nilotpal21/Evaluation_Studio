'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { BlueprintConfirmAnswer, BlueprintConfirmInput } from './types';

interface BlueprintConfirmCardProps {
  input: BlueprintConfirmInput;
  onSubmit: (answer: BlueprintConfirmAnswer) => void;
}

export function BlueprintConfirmCard({ input, onSubmit }: BlueprintConfirmCardProps) {
  const [submitted, setSubmitted] = useState<BlueprintConfirmAnswer | null>(null);

  const handleSubmit = (answer: BlueprintConfirmAnswer) => {
    if (submitted) {
      return;
    }

    setSubmitted(answer);
    onSubmit(answer);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 rounded-2xl border border-border/50 bg-background-muted/20 p-4"
    >
      <div className="mb-3">
        <div className="text-sm font-semibold text-foreground">{input.title}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {input.options.map((option) => {
          const isSelected = submitted === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => handleSubmit(option.value)}
              disabled={submitted !== null}
              className={clsx(
                'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                isSelected
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-background-elevated text-foreground/70 hover:border-foreground/20 hover:text-foreground',
              )}
            >
              {option.label === 'Generate draft topology'
                ? 'Generate draft blueprint'
                : option.label}
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
