'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import {
  SeveritySelector,
  type SeverityLevel,
  thresholdToSeverity,
  severityToThreshold,
} from './SeveritySelector';

// ─── Types ───────────────────────────────────────────────────────────────────

export type RuleKind = 'input' | 'output' | 'both';
export type RuleAction = 'block' | 'warn' | 'redact' | 'escalate' | 'fix' | 'reask' | 'filter';
export type CheckType = 'cel' | 'provider' | 'llm';

export interface RuleData {
  name: string;
  enabled: boolean;
  kind: RuleKind;
  checkType: CheckType;
  check?: string; // CEL expression (tier 1)
  provider?: string; // Provider name (tier 2)
  category?: string; // Provider category (tier 2)
  llmCheck?: string; // Natural language check (tier 3)
  threshold: number;
  action: RuleAction;
  message?: string;
  // SDB (Sensitive Data Block) preset fields — ABLP-723
  presetKey?: string;
  entities?: string[];
  actionMessage?: string;
}

interface RuleCardProps {
  rule: RuleData;
  onChange: (rule: RuleData) => void;
  onRemove?: () => void;
  providerOptions: { value: string; label: string }[];
  isCustom?: boolean;
  /**
   * Restrict the Action dropdown to a subset of the global vocabulary.
   * Used by the Sensitive Data Block preset (FR-1.2) to expose only
   * `block` / `warn` / `escalate`, matching the Decision Matrix modal.
   */
  allowedActions?: RuleAction[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const KIND_OPTIONS = [
  { value: 'input', label: 'Input' },
  { value: 'output', label: 'Output' },
  { value: 'both', label: 'Both' },
];

const ACTION_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'warn', label: 'Warn' },
  { value: 'redact', label: 'Redact' },
  { value: 'escalate', label: 'Escalate' },
  { value: 'fix', label: 'Fix' },
  { value: 'reask', label: 'Reask' },
  { value: 'filter', label: 'Filter' },
];

const CHECK_TYPE_OPTIONS = [
  { value: 'cel', label: 'CEL Expression' },
  { value: 'provider', label: 'Provider' },
  { value: 'llm', label: 'LLM Check' },
];

const ACTION_BADGE_COLORS: Record<string, string> = {
  block: 'bg-error-subtle text-error',
  warn: 'bg-warning-subtle text-warning',
  redact: 'bg-background-muted text-foreground-muted',
  escalate: 'bg-warning-subtle text-warning',
  fix: 'bg-success-subtle text-success',
  reask: 'bg-info-subtle text-info',
  filter: 'bg-background-muted text-foreground-muted',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function RuleCard({
  rule,
  onChange,
  onRemove,
  providerOptions,
  isCustom,
  allowedActions,
}: RuleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const severity = thresholdToSeverity(rule.threshold);
  const actionOptions = allowedActions
    ? ACTION_OPTIONS.filter((o) => allowedActions.includes(o.value as RuleAction))
    : ACTION_OPTIONS;

  const handleSeverityChange = (level: SeverityLevel) => {
    onChange({ ...rule, threshold: severityToThreshold(level) });
  };

  const actionColor = ACTION_BADGE_COLORS[rule.action] ?? ACTION_BADGE_COLORS.block;

  return (
    <div
      className={clsx(
        'rounded-xl border bg-background-elevated overflow-hidden transition-default',
        rule.enabled ? 'border-accent/40' : 'border-default',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Toggle
          checked={rule.enabled}
          onChange={(checked) => onChange({ ...rule, enabled: checked })}
        />

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          )}
          <span className="text-sm font-medium text-foreground truncate">
            {rule.name || 'Unnamed Rule'}
          </span>
        </button>

        <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', actionColor)}>
          {rule.action}
        </span>

        {isCustom && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded hover:bg-error-subtle text-muted hover:text-error transition-default"
            aria-label="Remove rule"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Expanded config */}
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-default space-y-4">
          {isCustom && (
            <Input
              label="Rule Name"
              value={rule.name}
              onChange={(e) => onChange({ ...rule, name: e.target.value })}
              placeholder="e.g. custom_safety_check"
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Applies To"
              options={KIND_OPTIONS}
              value={rule.kind}
              onChange={(v) => onChange({ ...rule, kind: v as RuleKind })}
            />
            <Select
              label="Action"
              options={actionOptions}
              value={rule.action}
              onChange={(v) => onChange({ ...rule, action: v as RuleAction })}
            />
          </div>

          {/* Check type — only show selector for custom rules */}
          {isCustom && (
            <Select
              label="Check Type"
              options={CHECK_TYPE_OPTIONS}
              value={rule.checkType}
              onChange={(v) => onChange({ ...rule, checkType: v as CheckType })}
            />
          )}

          {/* Tier 1: CEL expression */}
          {rule.checkType === 'cel' && (
            <Input
              label="CEL Expression"
              value={rule.check ?? ''}
              onChange={(e) => onChange({ ...rule, check: e.target.value })}
              placeholder='e.g. not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")'
            />
          )}

          {/* Tier 2: Provider */}
          {rule.checkType === 'provider' && (
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Provider"
                options={[{ value: '', label: 'Select provider...' }, ...providerOptions]}
                value={rule.provider ?? ''}
                onChange={(v) => onChange({ ...rule, provider: v })}
              />
              <Input
                label="Category"
                value={rule.category ?? ''}
                onChange={(e) => onChange({ ...rule, category: e.target.value })}
                placeholder="e.g. hate, pii, violence"
              />
            </div>
          )}

          {/* Tier 3: LLM check */}
          {rule.checkType === 'llm' && (
            <Input
              label="LLM Check"
              value={rule.llmCheck ?? ''}
              onChange={(e) => onChange({ ...rule, llmCheck: e.target.value })}
              placeholder="e.g. Does this message contain instructions for illegal activity?"
            />
          )}

          {/* Severity */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">Severity Threshold</label>
            <SeveritySelector value={severity} onChange={handleSeverityChange} />
          </div>

          {/* Action message */}
          <Input
            label="Action Message"
            value={rule.message ?? ''}
            onChange={(e) => onChange({ ...rule, message: e.target.value })}
            placeholder="Message shown when guardrail triggers"
          />
        </div>
      )}
    </div>
  );
}
