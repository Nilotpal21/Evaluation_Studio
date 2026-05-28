'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { TopologyRevisionAnswer, TopologyRevisionInput } from './types';

interface TopologyRevisionCardProps {
  input: TopologyRevisionInput;
  onSubmit: (answer: TopologyRevisionAnswer) => void;
}

export function TopologyRevisionCard({ input, onSubmit }: TopologyRevisionCardProps) {
  const [selectedTargets, setSelectedTargets] = useState<TopologyRevisionAnswer['targets']>([]);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const canSubmit =
    selectedTargets.length >= input.minSelect && selectedTargets.length <= input.maxSelect;

  const helperText = useMemo(() => {
    if (selectedTargets.length === 0) {
      return `Choose at least ${input.minSelect} revision target${input.minSelect === 1 ? '' : 's'}.`;
    }

    return `${selectedTargets.length} target${selectedTargets.length === 1 ? '' : 's'} selected`;
  }, [input.minSelect, selectedTargets.length]);
  const title =
    input.title === 'Refine the draft topology' ? 'Refine the draft blueprint' : input.title;

  const toggleTarget = (target: TopologyRevisionAnswer['targets'][number]) => {
    if (submitted) {
      return;
    }

    setSelectedTargets((current) => {
      if (current.includes(target)) {
        return current.filter((entry) => entry !== target);
      }

      if (current.length >= input.maxSelect) {
        return current;
      }

      return [...current, target];
    });
  };

  const handleSubmit = () => {
    if (!canSubmit || submitted) {
      return;
    }

    setSubmitted(true);
    onSubmit({
      targets: selectedTargets,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 rounded-2xl border border-border/50 bg-background-muted/20 p-4"
    >
      <div className="mb-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {input.options.map((option) => {
          const isSelected = selectedTargets.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              disabled={submitted}
              onClick={() => toggleTarget(option.value)}
              className={clsx(
                'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                isSelected
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-background-elevated text-foreground/70 hover:border-foreground/20 hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="mb-3 text-xs text-foreground-muted">{helperText}</div>
      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder={input.notesPlaceholder ?? 'Describe the blueprint changes you want.'}
        rows={3}
        className="mb-3 w-full rounded-lg border border-border bg-background-elevated px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/40 transition-colors focus:border-accent"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit || submitted}
        className={clsx(
          'rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
          canSubmit && !submitted
            ? 'bg-accent text-accent-foreground hover:bg-accent-muted'
            : 'cursor-not-allowed border border-border bg-background-subtle text-foreground/30',
        )}
      >
        Submit
      </button>
    </motion.div>
  );
}
