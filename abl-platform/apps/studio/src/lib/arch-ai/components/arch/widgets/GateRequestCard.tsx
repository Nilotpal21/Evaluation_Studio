'use client';

import { useMemo, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { GateActionOption, GateRequestAnswer, GateRequestInput } from './types';

interface GateRequestCardProps {
  input: GateRequestInput;
  onSubmit: (answer: GateRequestAnswer) => void;
}

function actionButtonClass(action: GateActionOption): string {
  if (action.tone === 'danger') {
    return 'border-error/30 bg-error/5 text-error hover:bg-error/10';
  }
  if (action.tone === 'primary') {
    return 'border-accent bg-accent text-accent-foreground hover:bg-accent-muted';
  }
  return 'border-border bg-background-elevated text-foreground/80 hover:border-accent/40 hover:bg-background-muted';
}

export function GateRequestCard({ input, onSubmit }: GateRequestCardProps) {
  const [submitted, setSubmitted] = useState<GateRequestAnswer | null>(null);
  const [pendingAction, setPendingAction] = useState<GateActionOption | null>(null);
  const [feedback, setFeedback] = useState('');
  const feedbackRequired = pendingAction?.requiresFeedback === true;
  const trimmedFeedback = feedback.trim();
  const canSubmitFeedback = !feedbackRequired || trimmedFeedback.length > 0;

  const submittedLabel = useMemo(() => {
    if (!submitted) {
      return '';
    }
    const action = input.actions.find((item) => item.value === submitted.action);
    return action?.label ?? submitted.action;
  }, [input.actions, submitted]);

  const handleImmediateSubmit = useCallback(
    (action: GateActionOption) => {
      if (submitted) {
        return;
      }

      if (action.requiresFeedback) {
        setFeedback('');
        setPendingAction(action);
        return;
      }

      const nextAnswer: GateRequestAnswer = { action: action.value };
      setSubmitted(nextAnswer);
      onSubmit(nextAnswer);
    },
    [onSubmit, submitted],
  );

  const handleFeedbackSubmit = useCallback(() => {
    if (!pendingAction || submitted) {
      return;
    }

    if (pendingAction.requiresFeedback && feedback.trim().length === 0) {
      return;
    }

    const nextAnswer: GateRequestAnswer = {
      action: pendingAction.value,
      feedback: trimmedFeedback || undefined,
    };
    setSubmitted(nextAnswer);
    onSubmit(nextAnswer);
  }, [feedback, onSubmit, pendingAction, submitted, trimmedFeedback]);

  if (submitted) {
    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        {submittedLabel}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 rounded-xl border border-border/20 bg-background-subtle p-4"
    >
      <div className="mb-3">
        <div className="text-sm font-semibold text-foreground">{input.title}</div>
        <p className="mt-1 text-sm leading-relaxed text-foreground/80">{input.question}</p>
        {input.description && (
          <p className="mt-1 text-xs leading-relaxed text-foreground-muted">{input.description}</p>
        )}
      </div>

      {input.details && input.details.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {input.details.map((detail) => (
            <span
              key={detail}
              className="inline-flex rounded-full border border-border/30 bg-background px-2.5 py-1 text-xs text-foreground-muted"
            >
              {detail}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {input.actions.map((action) => (
          <button
            key={action.value}
            type="button"
            onClick={() => handleImmediateSubmit(action)}
            className={clsx(
              'rounded-lg border px-4 py-2.5 text-left text-sm font-medium transition-colors',
              actionButtonClass(action),
            )}
          >
            {action.label}
          </button>
        ))}
      </div>

      {pendingAction && (
        <div className="mt-3 space-y-2 rounded-lg border border-border/20 bg-background px-3 py-3">
          <label className="block text-xs font-medium uppercase tracking-wide text-foreground-muted">
            {pendingAction.label}
          </label>
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={pendingAction.feedbackPlaceholder ?? 'Add context'}
            rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleFeedbackSubmit}
              disabled={!canSubmitFeedback}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              Submit
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingAction(null);
                setFeedback('');
              }}
              className="rounded-lg border border-border px-3 py-2 text-sm text-foreground-muted transition-colors hover:bg-background-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
