'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitBranch,
  GitCompare,
  MessageSquareText,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { ModificationProposal, ProposedChange } from '@/lib/arch-ai/types/arch';
import { useArchChatController } from '@/lib/arch-ai/ui/hook';
import {
  markDiffResolutionInFlight,
  updateDiffTabStatus,
} from '@/lib/arch-ai/ui/proposal-artifacts';

interface ImpactPanelProps {
  proposal: ModificationProposal;
  onViewDiff: () => void;
}

interface ImpactEdge {
  from: string;
  to: string;
  type: string;
}

interface RenameImpact {
  from: string;
  to: string;
  cascadeAgents: string[];
  referenceUpdates: Array<{ agent: string; from: string; to: string; count: number }>;
}

interface NormalizedImpact {
  runtimeReady: boolean;
  summary: string;
  changedAgent: string;
  declaredAgentName: string;
  impactedAgents: string[];
  rename?: RenameImpact;
  topology: {
    addedEdges: ImpactEdge[];
    removedEdges: ImpactEdge[];
  };
  tools: {
    added: string[];
    removed: string[];
    unresolved: string[];
  };
  nextActions: string[];
}

export function ImpactPanel({ proposal, onViewDiff }: ImpactPanelProps) {
  const actions = useArchChatController();
  const [isRefining, setIsRefining] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submittingAction, setSubmittingAction] = useState<'accept' | 'modify' | 'reject' | null>(
    null,
  );

  const impact = useMemo(() => normalizeImpact(proposal), [proposal]);
  const feedbackTrimmed = feedback.trim();
  const canResolve = proposal.reviewStatus === 'pending';
  const statusTone = impact.runtimeReady
    ? 'border-success/40 bg-success/10 text-success'
    : 'border-error/40 bg-error/10 text-error';
  const sections = summarizeSections(proposal.changes);

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
      if (action === 'accept') {
        markDiffResolutionInFlight();
      }
      await actions.sendProposal(action, action === 'modify' ? feedbackTrimmed : undefined);
      if (action === 'modify') {
        setFeedback('');
        setIsRefining(false);
      }
    } catch (err) {
      if (action === 'accept') {
        updateDiffTabStatus(
          'pending',
          err instanceof Error ? err.message : 'Failed to submit proposal response.',
          'applying',
        );
      }
      throw err;
    } finally {
      setSubmittingAction(null);
    }
  };

  return (
    <div
      data-testid="arch-impact-panel"
      className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {impact.changedAgent}
            </h3>
            {impact.declaredAgentName !== impact.changedAgent && (
              <span className="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                declares {impact.declaredAgentName}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-foreground-muted">{impact.summary}</p>
        </div>
        <span
          data-testid="arch-impact-runtime-status"
          aria-live="polite"
          className={clsx(
            'inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium uppercase',
            statusTone,
          )}
        >
          {impact.runtimeReady ? (
            <ShieldCheck className="h-3.5 w-3.5" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5" />
          )}
          {impact.runtimeReady ? 'Ready' : 'Blocked'}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-testid="arch-impact-view-diff"
          onClick={onViewDiff}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          <GitCompare className="h-3.5 w-3.5" />
          View Diff
        </button>

        {canResolve && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ImpactActionButton
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              label="Approve"
              tone="success"
              testId="arch-impact-approve"
              disabled={Boolean(submittingAction) || !impact.runtimeReady}
              onClick={() => void handleResolve('accept')}
            />
            <ImpactActionButton
              icon={<MessageSquareText className="h-3.5 w-3.5" />}
              label="Revise"
              tone="neutral"
              testId="arch-impact-revise"
              disabled={Boolean(submittingAction)}
              onClick={() => setIsRefining((value) => !value)}
            />
            <ImpactActionButton
              icon={<XCircle className="h-3.5 w-3.5" />}
              label="Cancel"
              tone="danger"
              testId="arch-impact-cancel"
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
            placeholder="What should Arch change before applying this?"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              data-testid="arch-impact-send-revision"
              disabled={!feedbackTrimmed || Boolean(submittingAction)}
              onClick={() => void handleResolve('modify')}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              Send
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <ImpactSection title="Sections" icon={<GitBranch className="h-3.5 w-3.5" />}>
          <TokenList items={sections} emptyLabel="No section summary available" />
        </ImpactSection>

        <ImpactSection title="Affected Agents" icon={<ArrowRight className="h-3.5 w-3.5" />}>
          <TokenList items={impact.impactedAgents} emptyLabel="No dependent agents detected" />
        </ImpactSection>

        <ImpactSection title="Topology">
          <EdgeList edges={impact.topology.addedEdges} tone="success" emptyLabel="No added edges" />
          <EdgeList
            edges={impact.topology.removedEdges}
            tone="danger"
            emptyLabel="No removed edges"
          />
        </ImpactSection>

        <ImpactSection title="Tools">
          <TokenGroup label="Added" items={impact.tools.added} tone="success" />
          <TokenGroup label="Removed" items={impact.tools.removed} tone="danger" />
          <TokenGroup label="Unresolved" items={impact.tools.unresolved} tone="warning" />
        </ImpactSection>
      </div>

      {impact.rename && (
        <ImpactSection title="Rename Cascade">
          <p className="text-xs text-foreground-muted">
            {impact.rename.from} <span className="text-foreground-subtle">to</span>{' '}
            {impact.rename.to}
          </p>
          <TokenGroup label="Cascade agents" items={impact.rename.cascadeAgents} tone="neutral" />
          {impact.rename.referenceUpdates.length > 0 && (
            <div className="space-y-1">
              {impact.rename.referenceUpdates.map((update, index) => (
                <div
                  key={`${update.agent}-${update.from}-${update.to}-${index}`}
                  className="rounded border border-border bg-background px-3 py-2 text-xs text-foreground-muted"
                >
                  {update.agent}: {update.from} to {update.to} ({update.count})
                </div>
              ))}
            </div>
          )}
        </ImpactSection>
      )}

      {proposal.validation && (
        <ImpactSection title="Validation">
          <TokenGroup
            label="Errors"
            items={proposal.validation.errors.map(formatValidationIssue)}
            tone="danger"
          />
          <TokenGroup
            label="Warnings"
            items={proposal.validation.warnings.map(formatValidationIssue)}
            tone="warning"
          />
          {proposal.validation.hint && (
            <p className="text-xs leading-5 text-foreground-muted">{proposal.validation.hint}</p>
          )}
        </ImpactSection>
      )}

      <ImpactSection title="Next Actions">
        <TokenList items={impact.nextActions} emptyLabel="No follow-up actions reported" />
      </ImpactSection>
    </div>
  );
}

function ImpactActionButton({
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
  const toneClass = {
    success: 'border-success/40 bg-success/10 text-success hover:bg-success/15',
    danger: 'border-error/40 bg-error/10 text-error hover:bg-error/15',
    neutral:
      'border-border bg-background text-foreground-muted hover:border-accent/50 hover:text-foreground',
  }[tone];

  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        toneClass,
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ImpactSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded border border-border bg-surface/40 p-3">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-foreground-muted">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

function TokenList({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <p className="text-xs text-foreground-subtle">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground-muted"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function TokenGroup({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: 'success' | 'danger' | 'warning' | 'neutral';
}) {
  if (items.length === 0) {
    return null;
  }

  const toneClass = {
    success: 'border-success/30 bg-success/10 text-success',
    danger: 'border-error/30 bg-error/10 text-error',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    neutral: 'border-border bg-background text-foreground-muted',
  }[tone];

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase text-foreground-subtle">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item} className={clsx('rounded border px-2 py-1 text-[11px]', toneClass)}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function EdgeList({
  edges,
  tone,
  emptyLabel,
}: {
  edges: ImpactEdge[];
  tone: 'success' | 'danger';
  emptyLabel: string;
}) {
  if (edges.length === 0) {
    return <p className="text-xs text-foreground-subtle">{emptyLabel}</p>;
  }

  const toneClass =
    tone === 'success'
      ? 'border-success/30 bg-success/10 text-success'
      : 'border-error/30 bg-error/10 text-error';

  return (
    <div className="space-y-1.5">
      {edges.map((edge) => (
        <div
          key={`${edge.from}-${edge.type}-${edge.to}`}
          className={clsx('rounded border px-3 py-2 text-xs', toneClass)}
        >
          {edge.from} <span className="text-foreground-subtle">{edge.type}</span> {edge.to}
        </div>
      ))}
    </div>
  );
}

function normalizeImpact(proposal: ModificationProposal): NormalizedImpact {
  const impact = isRecord(proposal.impact) ? proposal.impact : {};
  const topology = isRecord(impact.topology) ? impact.topology : {};
  const tools = isRecord(impact.tools) ? impact.tools : {};
  const rename = normalizeRename(impact.rename);

  return {
    runtimeReady: typeof impact.runtimeReady === 'boolean' ? impact.runtimeReady : true,
    summary: stringValue(impact.summary) ?? proposal.change ?? 'Arch prepared a project change.',
    changedAgent: stringValue(impact.changedAgent) ?? proposal.agentName,
    declaredAgentName: stringValue(impact.declaredAgentName) ?? proposal.agentName,
    impactedAgents: stringArray(impact.impactedAgents),
    rename,
    topology: {
      addedEdges: edgeArray(topology.addedEdges),
      removedEdges: edgeArray(topology.removedEdges),
    },
    tools: {
      added: stringArray(tools.added),
      removed: stringArray(tools.removed),
      unresolved: stringArray(tools.unresolved),
    },
    nextActions: stringArray(impact.nextActions),
  };
}

function normalizeRename(value: unknown): RenameImpact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const from = stringValue(value.from);
  const to = stringValue(value.to);
  if (!from || !to) {
    return undefined;
  }

  return {
    from,
    to,
    cascadeAgents: stringArray(value.cascadeAgents),
    referenceUpdates: recordArray(value.referenceUpdates).map((update) => ({
      agent: stringValue(update.agent) ?? 'unknown',
      from: stringValue(update.from) ?? from,
      to: stringValue(update.to) ?? to,
      count: typeof update.count === 'number' ? update.count : 0,
    })),
  };
}

function summarizeSections(changes: ProposedChange[]): string[] {
  return changes
    .map((change) => change.construct)
    .filter((construct, index, all) => {
      return all.indexOf(construct) === index;
    });
}

function edgeArray(value: unknown): ImpactEdge[] {
  return recordArray(value)
    .map((edge) => ({
      from: stringValue(edge.from) ?? '',
      to: stringValue(edge.to) ?? '',
      type: stringValue(edge.type) ?? 'edge',
    }))
    .filter((edge) => edge.from.length > 0 && edge.to.length > 0);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValidationIssue(issue: { agent?: string | null; line?: number; message: string }) {
  const prefix = [
    issue.agent ? `[${issue.agent}]` : null,
    typeof issue.line === 'number' ? `Line ${issue.line}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return prefix ? `${prefix}: ${issue.message}` : issue.message;
}
