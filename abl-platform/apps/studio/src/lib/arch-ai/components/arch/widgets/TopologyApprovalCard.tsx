'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { TopologyApprovalAnswer, TopologyApprovalInput } from './types';

interface TopologyApprovalCardProps {
  input: TopologyApprovalInput;
  onSubmit: (answer: TopologyApprovalAnswer) => void;
}

const ACTION_COPY: Record<TopologyApprovalAnswer['action'], { label: string; tone: string }> = {
  accept: { label: 'Accept blueprint', tone: 'primary' },
  request_changes: { label: 'Request changes', tone: 'secondary' },
  reject: { label: 'Reject and restart', tone: 'danger' },
};

export function TopologyApprovalCard({ input, onSubmit }: TopologyApprovalCardProps) {
  const [selectedAction, setSelectedAction] = useState<TopologyApprovalAnswer['action'] | null>(
    null,
  );
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const requiresNotes = selectedAction === 'request_changes' || selectedAction === 'reject';
  const canSubmit = selectedAction !== null && (!requiresNotes || notes.trim().length > 0);

  const subtitle = useMemo(() => {
    const details = [`${input.agentCount} agents`, `${input.edgeCount} handoffs`];
    if (input.entryPoint) {
      details.push(`entry: ${input.entryPoint}`);
    }
    return details.join(' · ');
  }, [input.agentCount, input.edgeCount, input.entryPoint]);
  const title = input.title === 'Draft topology ready' ? 'Draft blueprint ready' : input.title;

  const handleSubmit = () => {
    if (!canSubmit || submitted || !selectedAction) {
      return;
    }

    setSubmitted(true);
    onSubmit({
      action: selectedAction,
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
        <div className="mt-1 text-xs text-foreground-muted">{subtitle}</div>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {(Object.keys(ACTION_COPY) as Array<TopologyApprovalAnswer['action']>).map((action) => {
          const isSelected = selectedAction === action;
          const tone = ACTION_COPY[action].tone;
          return (
            <button
              key={action}
              type="button"
              disabled={submitted}
              onClick={() => setSelectedAction(action)}
              className={clsx(
                'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                isSelected && tone === 'primary' && 'border-accent bg-accent/10 text-accent',
                isSelected &&
                  tone === 'secondary' &&
                  'border-warning/40 bg-warning/10 text-warning',
                isSelected && tone === 'danger' && 'border-error/40 bg-error/10 text-error',
                !isSelected &&
                  'border-border bg-background-elevated text-foreground/70 hover:border-foreground/20 hover:text-foreground',
              )}
            >
              {ACTION_COPY[action].label}
            </button>
          );
        })}
      </div>
      {requiresNotes ? (
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={
            selectedAction === 'request_changes'
              ? 'Describe the change you want in the next draft.'
              : 'Describe why this draft should be discarded.'
          }
          rows={3}
          className="mb-3 w-full rounded-lg border border-border bg-background-elevated px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/40 transition-colors focus:border-accent"
        />
      ) : null}
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
