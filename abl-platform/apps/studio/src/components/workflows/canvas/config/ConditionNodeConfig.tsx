'use client';

import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Select } from '../../../ui/Select';
import { ExpressionInput } from './ExpressionInput';
import type { WorkflowPreviousStep, TriggerOption } from '../hooks/useWorkflowExpressionContext';
import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

interface Condition {
  id: string;
  label: string;
  field?: string;
  operator?: string;
  value?: unknown;
}

const OPERATOR_OPTIONS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Not Contains' },
  { value: 'is_empty', label: 'Is Empty' },
  { value: 'is_not_empty', label: 'Is Not Empty' },
  { value: 'matches_regex', label: 'Matches Regex' },
];

interface ConditionCardProps {
  condition: Condition;
  index: number;
  initialExpanded: boolean;
  triggers: TriggerOption[];
  previousSteps: WorkflowPreviousStep[];
  onUpdate: (index: number, field: string, value: unknown) => void;
  onRemove: (index: number) => void;
}

function ConditionCard({
  condition,
  index,
  initialExpanded,
  triggers,
  previousSteps,
  onUpdate,
  onRemove,
}: ConditionCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const operatorLabel = OPERATOR_OPTIONS.find((o) => o.value === condition.operator)?.label ?? '';
  const isFirst = index === 0;

  return (
    <div className="rounded-lg border border-default bg-background-subtle">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-2 px-2 py-2 text-left min-w-0"
          data-testid={`condition-toggle-${index}`}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
          )}
          <span className="text-sm font-medium text-foreground shrink-0">
            {isFirst ? 'If' : 'Else If'}
          </span>
          <span className="text-xs text-foreground-muted truncate flex-1">
            {condition.field ?? ''}
          </span>
          {operatorLabel && (
            <span className="text-[11px] text-foreground-muted shrink-0">{operatorLabel}</span>
          )}
        </button>
        {!isFirst && (
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="px-3 py-2 text-foreground-muted hover:text-error transition-colors"
            data-testid={`remove-condition-${index}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 px-3 pb-3 pt-1">
          <ExpressionInput
            label="Field"
            value={(condition.field as string) ?? ''}
            onChange={(v) => onUpdate(index, 'field', v)}
            placeholder="{{context.steps.NodeName.output.field}}"
            triggers={triggers}
            previousSteps={previousSteps}
          />

          <Select
            label="Operator"
            options={OPERATOR_OPTIONS}
            value={condition.operator ?? ''}
            onChange={(val) => onUpdate(index, 'operator', val)}
            placeholder="Select operator"
          />

          <ExpressionInput
            label="Value"
            value={String(condition.value ?? '')}
            onChange={(v) => onUpdate(index, 'value', v)}
            placeholder="Compare value or {{expression}}"
            triggers={triggers}
            previousSteps={previousSteps}
          />
        </div>
      )}
    </div>
  );
}

export function ConditionNodeConfig({ nodeId, config, onUpdate }: NodeConfigProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const conditions = (config.conditions as Condition[]) ?? [
    { id: 'if', label: 'If', operator: 'equals' },
  ];
  const [expandedOnAdd, setExpandedOnAdd] = useState<number | null>(null);

  const updateCondition = useCallback(
    (index: number, field: string, value: unknown) => {
      const updated = conditions.map((c, i) => (i === index ? { ...c, [field]: value } : c));
      onUpdate({ ...config, conditions: updated });
    },
    [config, conditions, onUpdate],
  );

  const addCondition = useCallback(() => {
    // Derive next index from the highest existing numeric suffix to avoid
    // duplicate IDs after deletions (e.g. delete if_2 then add → was if_3 again).
    let maxIndex = 0;
    for (const c of conditions) {
      const match = /^if_(\d+)$/.exec(c.id);
      if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
    }
    const newIndex = maxIndex + 1;
    const updated = [...conditions, { id: `if_${newIndex}`, label: 'Else If', operator: 'equals' }];
    setExpandedOnAdd(updated.length - 1);
    onUpdate({ ...config, conditions: updated });
  }, [config, conditions, onUpdate]);

  const removeCondition = useCallback(
    (index: number) => {
      if (index === 0) return; // Cannot remove the first "If"
      const updated = conditions.filter((_, i) => i !== index);
      onUpdate({ ...config, conditions: updated });
    },
    [config, conditions, onUpdate],
  );

  return (
    <div className="space-y-3" data-testid="condition-config">
      <div className="space-y-2">
        {conditions.map((condition, index) => (
          <ConditionCard
            key={condition.id}
            condition={condition}
            index={index}
            initialExpanded={index === expandedOnAdd || (index === 0 && expandedOnAdd === null)}
            triggers={triggers}
            previousSteps={previousSteps}
            onUpdate={updateCondition}
            onRemove={removeCondition}
          />
        ))}
      </div>

      {/* Implicit Else */}
      <div className="p-3 rounded-lg border border-dashed border-default bg-background-subtle/50">
        <span className="text-sm text-foreground-muted">Else (default path)</span>
      </div>

      <button
        type="button"
        onClick={addCondition}
        data-testid="add-condition-btn"
        className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors"
      >
        <Plus className="w-4 h-4" />
        Add Else If
      </button>
    </div>
  );
}
