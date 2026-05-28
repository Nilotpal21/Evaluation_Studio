'use client';

import { useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';

/**
 * IntegrationPlan widget input — Contract 5
 *
 * Triggered by ask_user with widgetType: 'IntegrationPlan'. Renders a
 * numbered checklist of plan steps with editable descriptions, plus an
 * optional rationale and feedback box. The user approves, edits, or
 * rejects the plan.
 */
export interface PlanStep {
  id: string;
  description: string;
}

export interface IntegrationPlanInput {
  widgetType?: 'IntegrationPlan';
  steps: PlanStep[];
  rationale?: string;
  question?: string;
}

export interface IntegrationPlanAnswer {
  action: 'approve' | 'edit' | 'reject';
  editedSteps?: PlanStep[];
  feedback?: string;
}

interface Props {
  input: IntegrationPlanInput;
  onSubmit: (answer: IntegrationPlanAnswer) => void;
}

export function IntegrationPlan({ input, onSubmit }: Props) {
  const [steps, setSteps] = useState<PlanStep[]>(input.steps);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);

  const finalize = useCallback(
    (answer: IntegrationPlanAnswer) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitted(true);
      onSubmit(answer);
    },
    [onSubmit],
  );

  const handleStepChange = useCallback((id: string, description: string) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, description } : s)));
  }, []);

  const handleApprove = useCallback(() => {
    finalize({ action: 'approve', editedSteps: steps });
  }, [finalize, steps]);

  const handleEdit = useCallback(() => {
    finalize({
      action: 'edit',
      editedSteps: steps,
      feedback: feedback.trim() ? feedback.trim() : undefined,
    });
  }, [finalize, steps, feedback]);

  const handleReject = useCallback(() => {
    finalize({
      action: 'reject',
      feedback: feedback.trim() ? feedback.trim() : undefined,
    });
  }, [finalize, feedback]);

  if (submitted) {
    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        Plan response sent.
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 rounded-lg border border-border bg-background-muted/30 p-4"
    >
      {input.rationale ? (
        <p className="mb-3 text-sm text-foreground-muted">{input.rationale}</p>
      ) : null}
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li key={step.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 w-5 shrink-0 text-foreground-muted">{i + 1}.</span>
            {editingId === step.id ? (
              <input
                aria-label={`Step ${i + 1} description`}
                value={step.description}
                onChange={(e) => handleStepChange(step.id, e.target.value)}
                onBlur={() => setEditingId(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault();
                    setEditingId(null);
                  }
                }}
                autoFocus
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingId(step.id)}
                className="flex-1 cursor-text rounded border border-transparent px-2 py-1 text-left text-foreground/80 hover:border-border hover:bg-background-muted"
              >
                {step.description}
              </button>
            )}
          </li>
        ))}
      </ol>
      <textarea
        aria-label="Optional feedback"
        placeholder="Optional feedback…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        className="mt-3 w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground focus:border-accent focus:outline-none"
        rows={2}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleApprove}
          className="btn-press rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={handleEdit}
          className="btn-press rounded-lg border border-border px-4 py-2 text-sm text-foreground/80 transition-colors hover:bg-background-muted"
        >
          Edit & continue
        </button>
        <button
          type="button"
          onClick={handleReject}
          className="btn-press rounded-lg border border-border px-4 py-2 text-sm text-error transition-colors hover:bg-background-muted"
        >
          Reject
        </button>
      </div>
    </motion.div>
  );
}
