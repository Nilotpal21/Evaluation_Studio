/**
 * DecisionContent — Humanized decision step display.
 *
 * Renders structured decision information (handoff, completion check,
 * engine decision, etc.) with outcome badges, trigger details,
 * and expandable raw event data.
 */

import { useMemo, useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { FlowStepContextLine } from './FlowStepContextLine';
import { RawEventBlock } from './RawEventBlock';
import type { InteractionStep as InteractionStepData } from './types';

const DECISION_META: Record<string, { label: string; description: string }> = {
  // From emitDecisionEvent (data.decisionKind)
  handoff: { label: 'Agent Handoff', description: 'Routing to another agent' },
  delegation: { label: 'Delegation', description: 'Delegating to sub-agent' },
  flow_transition: { label: 'Flow Transition', description: 'Moving to next flow step' },
  field_validation: { label: 'Field Validation', description: 'Validating field value' },
  escalation: { label: 'Escalation', description: 'Escalating conversation priority' },
  completion: { label: 'Completion Check', description: 'Checking task completion' },
  constraint_check: { label: 'Constraint Check', description: 'Evaluating constraint rules' },
  guardrail_check: { label: 'Guardrail Check', description: 'Safety guardrail evaluation' },
  gather_extraction: {
    label: 'Data Extraction',
    description: 'Extracting field values from input',
  },
  correction: { label: 'Value Correction', description: 'Correcting a previously extracted value' },
  data_mutation: { label: 'Data Update', description: 'Updating session data' },
  await_attachment: { label: 'Awaiting Attachment', description: 'Waiting for file upload' },
  // From event type (no decisionKind in data)
  'agent.handoff': { label: 'Agent Handoff', description: 'Routing to another agent' },
  handoff_condition_check: {
    label: 'Handoff Check',
    description: 'Evaluating handoff condition',
  },
  completion_check: { label: 'Completion Check', description: 'Checking if task is complete' },
  engine_decision: { label: 'Engine Decision', description: 'Internal engine routing decision' },
  'agent.decision': { label: 'Agent Decision', description: 'Agent routing decision' },
  // Fallback for generic 'decision' event type (no decisionKind)
  decision: { label: 'Decision', description: 'Agent decision point' },
};

function humanizeDecisionKind(kind: string): { label: string; description: string } {
  if (DECISION_META[kind]) return DECISION_META[kind];
  // Fallback: convert snake_case to Title Case
  const label = kind
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return { label, description: '' };
}

/** Keys already rendered in the structured header/details — skip in dynamic metadata */
const RENDERED_DECISION_KEYS = new Set([
  'decisionType',
  'outcome',
  'matched',
  'condition',
  'field',
  'target',
  'from',
  'reason',
  'violation',
]);

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function renderValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

interface DecisionContentProps {
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
}

export function DecisionContent({ step, styles }: DecisionContentProps) {
  const [expanded, setExpanded] = useState(false);
  const kind = String(step.data.decisionType ?? 'unknown');
  const { label, description } = humanizeDecisionKind(kind);
  const outcome = step.data.outcome != null ? String(step.data.outcome) : null;
  const matched = step.data.matched;
  const condition = step.data.condition != null ? String(step.data.condition) : null;
  const field = step.data.field != null ? String(step.data.field) : null;
  const target = step.data.target != null ? String(step.data.target) : null;
  const from = step.data.from != null ? String(step.data.from) : null;
  const reason = step.data.reason != null ? String(step.data.reason) : null;
  const violation = step.data.violation != null ? String(step.data.violation) : null;
  const agent = step.agentName ?? (step.data.agent != null ? String(step.data.agent) : null);
  const hasFlowStepContext = Boolean(step.flowStepName || step.flowStepType);

  // Trigger object (guardrail details: guardrail name, tier, kind)
  const trigger = step.data.trigger as
    | { guardrail?: string; tier?: string; kind?: string; [k: string]: unknown }
    | undefined;

  const isPassed = matched === true || outcome === 'pass' || outcome === 'true';
  const isFailed =
    matched === false ||
    outcome === 'fail' ||
    outcome === 'false' ||
    outcome === 'block' ||
    violation != null;

  // Format outcome for display — booleans and technical values get humanized
  const displayOutcome = outcome === 'true' ? 'pass' : outcome === 'false' ? 'fail' : outcome;

  // Collect remaining metadata not rendered in structured sections
  const extraMeta = useMemo(() => {
    const entries: { key: string; label: string; value: string }[] = [];
    for (const [key, val] of Object.entries(step.data)) {
      if (RENDERED_DECISION_KEYS.has(key) || key === 'trigger') continue;
      if (val == null) continue;
      // Skip objects/arrays that are empty
      if (typeof val === 'object' && Object.keys(val as object).length === 0) continue;
      entries.push({ key, label: humanizeKey(key), value: renderValue(val) });
    }
    return entries;
  }, [step.data]);

  // Build raw event data for expandable details
  const rawEventData = useMemo(() => {
    return step.events.map((evt) => ({
      id: evt.id,
      type: evt.type,
      agent: evt.agentName,
      data: evt.data,
    }));
  }, [step.events]);

  const hasDetails = rawEventData.length > 0;

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-foreground">{label}</span>

        {/* Outcome badge */}
        {displayOutcome != null && (
          <span
            className={clsx(
              'text-[9px] font-medium px-1.5 py-0.5 rounded',
              isFailed
                ? 'bg-error/10 text-error'
                : isPassed
                  ? 'bg-success/10 text-success'
                  : 'bg-foreground-subtle/10 text-foreground-muted',
            )}
          >
            {displayOutcome}
          </span>
        )}

        {/* Guardrail kind badge (input / output) */}
        {trigger?.kind && (
          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-foreground-subtle/10 text-foreground-muted">
            {String(trigger.kind)}
          </span>
        )}

        {/* Handoff: from → target */}
        {from && target ? (
          <span className="text-foreground-muted">
            {from} → {target}
          </span>
        ) : target ? (
          <span className="text-foreground-muted">→ {target}</span>
        ) : null}

        <div className="flex-1" />

        {/* Expand/collapse for raw event data */}
        {hasDetails && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors"
          >
            <span className="text-[9px]">{expanded ? 'Hide' : 'Details'}</span>
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* Structured details */}
      <div className="px-3 pb-1.5 space-y-0.5">
        {description ? (
          <div className="text-[9px] text-foreground-subtle">{description}</div>
        ) : null}

        <FlowStepContextLine step={step} />

        {/* Agent name */}
        {agent && !hasFlowStepContext ? (
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-foreground-muted">Agent:</span>
            <span className="font-mono text-foreground">{agent}</span>
          </div>
        ) : null}

        {/* Trigger details (guardrail name, tier) */}
        {trigger?.guardrail && (
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-foreground-muted">Guardrail:</span>
            <span className="font-mono text-foreground">{String(trigger.guardrail)}</span>
            {trigger.tier && (
              <span className="text-[9px] text-foreground-subtle font-mono">
                (tier: {String(trigger.tier)})
              </span>
            )}
          </div>
        )}

        {/* Flatten any extra trigger keys beyond guardrail/tier/kind */}
        {trigger &&
          Object.entries(trigger)
            .filter(([k, v]) => !['guardrail', 'tier', 'kind'].includes(k) && v != null)
            .map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 text-[10px]">
                <span className="text-foreground-muted">{humanizeKey(k)}:</span>
                <span className="font-mono text-foreground-subtle">{renderValue(v)}</span>
              </div>
            ))}

        {/* Condition expression */}
        {condition ? (
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-foreground-muted">Condition:</span>
            <span className="font-mono text-foreground-subtle">{condition}</span>
          </div>
        ) : null}

        {/* Field being checked */}
        {field ? (
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-foreground-muted">Field:</span>
            <span className="font-mono text-foreground">{field}</span>
            {violation ? <span className="text-error text-[9px]">({violation})</span> : null}
          </div>
        ) : null}

        {/* Reason */}
        {reason ? <div className="text-[10px] text-foreground-subtle">{reason}</div> : null}

        {/* Dynamic extra metadata — all remaining non-null fields */}
        {extraMeta.map(({ key, label: metaLabel, value }) => (
          <div key={key} className="flex items-start gap-1.5 text-[10px]">
            <span className="text-foreground-muted shrink-0">{metaLabel}:</span>
            <span
              className={clsx(
                'font-mono text-foreground-subtle break-words',
                value.includes('\n') && 'whitespace-pre-wrap',
              )}
            >
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Expandable raw event data */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-border-muted pt-1.5">
          {rawEventData.map((evt) => (
            <RawEventBlock
              key={evt.id}
              type={evt.type}
              agent={evt.agent}
              data={evt.data as Record<string, unknown>}
            />
          ))}
        </div>
      )}
    </div>
  );
}
