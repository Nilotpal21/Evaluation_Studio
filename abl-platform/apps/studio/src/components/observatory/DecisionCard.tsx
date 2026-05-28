'use client';

/**
 * DecisionCard — Unified decision renderer for Observatory.
 *
 * Uses DECISION_KIND_META for icon/color per decision kind, and renders
 * conditional sections (candidates, reasoning, conditions, field) based
 * on which data fields are present in the event.
 */

import { Check } from 'lucide-react';
import clsx from 'clsx';
import { Badge } from '../ui/Badge';
import { DECISION_KIND_META, type DecisionKind } from '../../lib/event-types';
import { formatAbsoluteTime } from './format-time';

interface DecisionCardProps {
  data: Record<string, unknown>;
  /** Override timestamp display */
  timestamp?: Date;
  /** Compact mode for inline rendering (e.g. SpanTree badges) */
  compact?: boolean;
}

export function DecisionCard({ data, timestamp, compact }: DecisionCardProps) {
  const rawKind = typeof data.decisionKind === 'string' ? data.decisionKind : 'decision';
  const meta = DECISION_KIND_META[rawKind as DecisionKind];
  const Icon = meta?.icon;
  const color = meta?.color ?? 'text-purple';
  const label = meta?.label ?? rawKind;
  const sections = meta?.sections ?? [];

  const reason = typeof data.reason === 'string' ? data.reason : null;
  const reasoning = typeof data.reasoning === 'string' ? data.reasoning : null;
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const selected = typeof data.selected === 'string' ? data.selected : null;
  const outcome = typeof data.outcome === 'string' ? data.outcome : null;
  const conditions = Array.isArray(data.conditions) ? data.conditions : [];
  const field = typeof data.field === 'string' ? data.field : null;
  const fieldValue = data.value !== undefined ? data.value : null;
  const decision = typeof data.decision === 'string' ? data.decision : null;

  if (compact) {
    return (
      <span className={clsx('inline-flex items-center gap-1 text-xs', color)}>
        {Icon && <Icon className="w-3 h-3" />}
        <span className="font-medium">{label}</span>
        {(outcome || decision) && <span className="text-muted">: {outcome || decision}</span>}
      </span>
    );
  }

  return (
    <div className="rounded-lg border border-purple/20 bg-purple-subtle/30 p-3 text-xs space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        {Icon && <Icon className={clsx('w-3.5 h-3.5', color)} />}
        <Badge variant="purple">{label}</Badge>
        {(outcome || decision) && (
          <span className="text-foreground font-medium">{outcome || decision}</span>
        )}
        {timestamp && <span className="text-subtle ml-auto">{formatAbsoluteTime(timestamp)}</span>}
      </div>

      {/* Reasoning section */}
      {sections.includes('reasoning') && (reason || reasoning) && (
        <p className="text-foreground">{reason || reasoning}</p>
      )}

      {/* Candidates section */}
      {sections.includes('candidates') && candidates.length > 0 && (
        <div>
          <span className="text-muted text-xs uppercase tracking-wider">Candidates</span>
          <div className="mt-1 space-y-0.5">
            {candidates.map((c: unknown, i: number) => {
              const name =
                typeof c === 'string'
                  ? c
                  : typeof c === 'object' && c !== null && 'name' in c
                    ? String((c as Record<string, unknown>).name)
                    : String(c);
              const isSelected = name === selected;
              return (
                <div
                  key={i}
                  className={clsx(
                    'flex items-center gap-1.5 px-2 py-1 rounded',
                    isSelected ? 'bg-purple-subtle text-purple font-medium' : 'text-muted',
                  )}
                >
                  {isSelected && <Check className="w-3 h-3 text-purple" />}
                  <span>{name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conditions section */}
      {sections.includes('conditions') && conditions.length > 0 && (
        <div>
          <span className="text-muted text-xs uppercase tracking-wider">Conditions</span>
          <div className="mt-1 space-y-0.5">
            {conditions.map((c: unknown, i: number) => (
              <div key={i} className="px-2 py-1 rounded bg-background-subtle text-muted">
                {String(c)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Field section */}
      {sections.includes('field') && field && (
        <div>
          <span className="text-muted text-xs uppercase tracking-wider">Field</span>
          <div className="mt-1 px-2 py-1 rounded bg-background-subtle">
            <span className="text-foreground font-medium">{field}</span>
            {fieldValue !== null && <span className="text-muted ml-2">= {String(fieldValue)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
