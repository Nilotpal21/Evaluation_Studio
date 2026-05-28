'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { CheckCircle2, MessageSquareText, Send, XCircle } from 'lucide-react';
import type { PendingPlan } from '@agent-platform/arch-ai/types';
import { useArchChatController } from '@/lib/arch-ai/ui/hook';

type Density = 'compact' | 'comfortable';

const STATUS_TONE: Record<string, string> = {
  proposed: 'border-accent/40 bg-accent/10 text-accent',
  approved: 'border-success/40 bg-success/10 text-success',
  refining: 'border-warning/40 bg-warning/10 text-warning',
  cancelled: 'border-border bg-surface text-foreground-muted',
  invalidated: 'border-error/40 bg-error/10 text-error',
};

export function PlanPanel({ data }: { data: unknown }) {
  const plan = data as Partial<PendingPlan>;
  const actions = useArchChatController();
  const [density, setDensity] = useState<Density>('comfortable');
  const [isRefining, setIsRefining] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submittingAction, setSubmittingAction] = useState<'accept' | 'modify' | 'reject' | null>(
    null,
  );

  const canResolve = plan.status === 'proposed';
  const feedbackTrimmed = feedback.trim();
  const sectionGap = density === 'compact' ? 'gap-3' : 'gap-4';
  const itemPadding = density === 'compact' ? 'px-2.5 py-1.5' : 'px-3 py-2';
  const planStatus = plan.status ?? 'proposed';

  const handleResolve = async (action: 'accept' | 'modify' | 'reject') => {
    if (!canResolve || submittingAction) {
      return;
    }
    if (action === 'modify' && !feedbackTrimmed) {
      setIsRefining(true);
      return;
    }

    setSubmittingAction(action);
    try {
      await actions.sendProposal(action, action === 'modify' ? feedbackTrimmed : undefined);
      if (action === 'modify') {
        setFeedback('');
        setIsRefining(false);
      }
    } finally {
      setSubmittingAction(null);
    }
  };

  const references = useMemo(
    () => plan.dependentsAnalysis?.referencesFound ?? [],
    [plan.dependentsAnalysis?.referencesFound],
  );

  return (
    <div
      data-testid="arch-plan-panel"
      className={clsx(
        'flex h-full flex-col overflow-y-auto p-4 text-sm',
        sectionGap,
        planStatus === 'invalidated' && 'border-l-2 border-error',
      )}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{plan.title ?? 'Plan'}</h3>
          {plan.goal && <p className="mt-1 text-xs leading-5 text-foreground-muted">{plan.goal}</p>}
        </div>
        <span
          data-testid="arch-plan-status"
          aria-live="polite"
          className={clsx(
            'shrink-0 rounded border px-2 py-1 text-[11px] font-medium uppercase',
            STATUS_TONE[planStatus] ?? 'border-border text-foreground-muted',
          )}
        >
          {planStatus}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border bg-surface/40 p-0.5">
          {(['comfortable', 'compact'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setDensity(mode)}
              className={clsx(
                'rounded px-2 py-1 text-[11px] font-medium capitalize transition-colors',
                density === mode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-foreground-muted hover:text-foreground',
              )}
            >
              {mode}
            </button>
          ))}
        </div>

        {canResolve && (
          <div className="flex flex-wrap items-center gap-1.5">
            <PlanActionButton
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              label="Approve"
              tone="success"
              testId="arch-plan-approve"
              disabled={Boolean(submittingAction)}
              onClick={() => void handleResolve('accept')}
            />
            <PlanActionButton
              icon={<MessageSquareText className="h-3.5 w-3.5" />}
              label="Refine"
              tone="neutral"
              testId="arch-plan-refine"
              disabled={Boolean(submittingAction)}
              onClick={() => setIsRefining((value) => !value)}
            />
            <PlanActionButton
              icon={<XCircle className="h-3.5 w-3.5" />}
              label="Cancel"
              tone="danger"
              testId="arch-plan-cancel"
              disabled={Boolean(submittingAction)}
              onClick={() => void handleResolve('reject')}
            />
          </div>
        )}
      </div>

      {isRefining && canResolve && (
        <div className="rounded border border-border bg-surface/40 p-3">
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={3}
            className="min-h-20 w-full resize-y rounded border border-border bg-background px-3 py-2 text-xs text-foreground outline-none transition-colors placeholder:text-foreground-subtle focus:border-accent"
            placeholder="What should Arch change in this plan?"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              data-testid="arch-plan-send-refinement"
              disabled={!feedbackTrimmed || Boolean(submittingAction)}
              onClick={() => void handleResolve('modify')}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          </div>
        </div>
      )}

      {plan.summary && <p className="text-sm leading-6 text-foreground">{plan.summary}</p>}
      {plan.architecturalPattern && (
        <PlanSection
          title="Architectural Pattern"
          items={[plan.architecturalPattern]}
          itemPadding={itemPadding}
        />
      )}

      <PlanSection title="Affected Agents" items={plan.affectedAgents} itemPadding={itemPadding} />
      <PlanSection title="Evidence" items={plan.evidence} itemPadding={itemPadding} />
      <PlanStructuredList
        title="Sections"
        items={plan.sectionsToChange}
        itemPadding={itemPadding}
        renderItem={(section) =>
          `${section.agentName} / ${section.construct} / ${section.operation} - ${section.reason}`
        }
      />
      {plan.dependentsAnalysis?.summary && (
        <PlanSection
          title="Dependents"
          items={[plan.dependentsAnalysis.summary]}
          itemPadding={itemPadding}
        />
      )}
      <PlanStructuredList
        title="References"
        items={references}
        itemPadding={itemPadding}
        renderItem={(reference) =>
          `${reference.kind} / ${reference.sourceAgent}${reference.targetAgent ? ` -> ${reference.targetAgent}` : ''}${reference.fieldName ? ` / ${reference.fieldName}` : ''}${reference.toolName ? ` / ${reference.toolName}` : ''}${reference.variableName ? ` / ${reference.variableName}` : ''}${reference.detail ? ` - ${reference.detail}` : ''}`
        }
      />
      <PlanStructuredList
        title="Alternatives"
        items={plan.alternativesConsidered}
        itemPadding={itemPadding}
        renderItem={(alternative) =>
          `${alternative.option} - rejected because ${alternative.rejectedBecause}`
        }
      />
      <PlanStructuredList
        title="Citations"
        items={plan.citations}
        itemPadding={itemPadding}
        renderItem={(citation) =>
          `${citation.sourceType}:${citation.reference} - ${citation.relevance}`
        }
      />

      {Array.isArray(plan.plannedMutations) && plan.plannedMutations.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase text-foreground-muted">Mutations</h4>
          <div className="space-y-2">
            {plan.plannedMutations.map((mutation, index) => (
              <div key={index} className="rounded border border-border bg-surface/40 p-3">
                <div className="font-mono text-xs text-foreground">
                  {mutation.sourceTool}:{mutation.sourceAction} / {mutation.operation}
                </div>
                <div className="mt-1 text-xs text-foreground-muted">
                  {mutation.targetKind}
                  {mutation.agentName ? ` / ${mutation.agentName}` : ''}
                </div>
                {mutation.rationale && (
                  <p className="mt-2 text-xs leading-5 text-foreground-muted">
                    {mutation.rationale}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <PlanStructuredList
        title="Risks"
        items={plan.risks}
        itemPadding={itemPadding}
        renderItem={(risk) =>
          `${risk.severity} - ${risk.description}${risk.mitigation ? ` Mitigation: ${risk.mitigation}` : ''}`
        }
      />
      <PlanSection title="Questions" items={plan.questionsForUser} itemPadding={itemPadding} />
      <PlanSection title="Validation" items={plan.validationNotes} itemPadding={itemPadding} />
    </div>
  );
}

function PlanActionButton({
  icon,
  label,
  tone,
  testId,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tone: 'success' | 'danger' | 'neutral';
  testId?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'success' && 'border-success/30 text-success hover:bg-success/10',
        tone === 'danger' && 'border-error/30 text-error hover:bg-error/10',
        tone === 'neutral' && 'border-border text-foreground-muted hover:bg-background-muted',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PlanStructuredList<T>({
  title,
  items,
  itemPadding,
  renderItem,
}: {
  title: string;
  items?: T[];
  itemPadding: string;
  renderItem: (item: T) => string;
}) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  return <PlanSection title={title} items={items.map(renderItem)} itemPadding={itemPadding} />;
}

function PlanSection({
  title,
  items,
  itemPadding,
}: {
  title: string;
  items?: string[];
  itemPadding: string;
}) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase text-foreground-muted">{title}</h4>
      <ul className="space-y-1.5">
        {items.map((item, index) => (
          <li
            key={index}
            className={clsx('rounded bg-surface/40 text-xs text-foreground-muted', itemPadding)}
          >
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
