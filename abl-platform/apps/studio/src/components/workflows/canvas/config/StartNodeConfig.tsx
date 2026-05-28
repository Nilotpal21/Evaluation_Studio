'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Play,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { VAR_NAME_REGEX } from '../constants/workflow';
import { useNodeExpressionContext } from './NodeExpressionContext';
interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

interface InputVariable {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  /** Optional default value used to pre-fill the Run dialog. Stored as a
      string regardless of declared type; the Run dialog coerces it on submit
      so the workflow executor receives the correct JS type. */
  defaultValue?: string;
}

const TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'json', label: 'JSON' },
];

interface VariableCardProps {
  variable: InputVariable;
  index: number;
  initialExpanded: boolean;
  nameError?: string;
  nameRef?: RefObject<HTMLInputElement | null>;
  onUpdate: (index: number, field: keyof InputVariable, value: unknown) => void;
  onRemove: (index: number) => void;
}

function VariableCard({
  variable,
  index,
  initialExpanded,
  nameError,
  nameRef,
  onUpdate,
  onRemove,
}: VariableCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  useEffect(() => {
    if (nameError) setExpanded(true);
  }, [nameError]);
  const typeLabel = TYPE_OPTIONS.find((t) => t.value === variable.type)?.label ?? variable.type;

  return (
    <div className="rounded-lg border border-default bg-background-subtle">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-2 px-2 py-2 text-left"
          data-testid={`input-var-toggle-${index}`}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-foreground-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-foreground-muted" />
          )}
          <span className="text-sm text-foreground truncate">
            {variable.name || 'variable_name'}
          </span>
          <span className="text-xs text-foreground-muted">{typeLabel}</span>
          {variable.required && (
            <span className="text-error ml-0.5" aria-label="required">
              *
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="px-3 py-2 text-foreground-muted hover:text-error transition-colors"
          data-testid={`remove-input-var-${index}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 px-3 pb-3 pt-1">
          <Input
            ref={nameRef}
            label="Variable Name"
            value={variable.name}
            onChange={(e) => onUpdate(index, 'name', e.target.value)}
            onBlur={(e) => onUpdate(index, 'name', e.target.value.trim())}
            placeholder="variable_name"
            error={nameError}
          />
          <Select
            label="Datatype"
            options={TYPE_OPTIONS}
            value={variable.type}
            onChange={(val) => onUpdate(index, 'type', val)}
          />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={variable.required}
              onChange={(e) => onUpdate(index, 'required', e.target.checked)}
              className="rounded border-default"
            />
            Required
          </label>
          <Input
            label="Description"
            value={variable.description ?? ''}
            onChange={(e) => onUpdate(index, 'description', e.target.value)}
            onBlur={(e) => onUpdate(index, 'description', e.target.value.trim())}
            placeholder="Description (Optional)"
          />
          <Input
            label="Default Value"
            value={variable.defaultValue ?? ''}
            onChange={(e) => onUpdate(index, 'defaultValue', e.target.value)}
            placeholder={
              variable.type === 'boolean'
                ? 'true or false'
                : variable.type === 'json'
                  ? '{"key": "value"}'
                  : variable.type === 'number'
                    ? '0'
                    : 'Default (Optional)'
            }
          />
        </div>
      )}
    </div>
  );
}

function AppTriggersSection() {
  const { triggers, onTestTrigger } = useNodeExpressionContext();
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Only show connector triggers (not the synthetic '__input_vars' entry)
  const connectorTriggers = triggers.filter((t) => t.id !== '__input_vars');
  if (connectorTriggers.length === 0) return null;

  const handleTest = async (triggerId: string) => {
    if (!onTestTrigger) return;
    setTesting((s) => ({ ...s, [triggerId]: true }));
    setErrors((s) => ({ ...s, [triggerId]: '' }));
    try {
      await onTestTrigger(triggerId);
    } catch (err) {
      setErrors((s) => ({
        ...s,
        [triggerId]: err instanceof Error ? err.message : 'Test failed',
      }));
    } finally {
      setTesting((s) => ({ ...s, [triggerId]: false }));
    }
  };

  return (
    <div className="space-y-3" data-testid="app-triggers-section">
      <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
        App Triggers
      </h4>
      <div className="space-y-2">
        {connectorTriggers.map((trigger) => {
          const hasPayload = Object.keys(trigger.payload ?? {}).length > 0;
          const isLoading = testing[trigger.id];
          const error = errors[trigger.id];
          return (
            <div
              key={trigger.id}
              className="flex items-center justify-between rounded-lg border border-default bg-background-subtle px-3 py-2 gap-2"
              data-testid={`trigger-card-${trigger.id}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {hasPayload ? (
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-foreground-muted shrink-0" />
                )}
                <span className="text-sm text-foreground truncate">{trigger.label}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {error && (
                  <span className="text-xs text-error truncate max-w-[100px]">{error}</span>
                )}
                {onTestTrigger && (
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() => void handleTest(trigger.id)}
                    data-testid={`test-trigger-${trigger.id}`}
                    className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
                  >
                    <Play className="w-3 h-3" />
                    {isLoading ? 'Testing…' : 'Test'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function StartNodeConfig({ config, onUpdate }: NodeConfigProps) {
  const inputVariables = (config.inputVariables as InputVariable[]) ?? [];
  const [expandedOnAdd, setExpandedOnAdd] = useState<number | null>(null);
  const pendingFocus = useRef(false);
  const lastNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pendingFocus.current && lastNameRef.current) {
      lastNameRef.current.focus();
      pendingFocus.current = false;
    }
  });

  const nameErrors = useMemo<Record<number, string>>(() => {
    const errors: Record<number, string> = {};
    const nameCounts = new Map<string, number>();
    for (const v of inputVariables) {
      const key = v.name.trim();
      if (!key) continue;
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    inputVariables.forEach((v, i) => {
      const trimmed = v.name.trim();
      if (!trimmed) {
        errors[i] = 'Variable name is required';
        return;
      }
      if (!VAR_NAME_REGEX.test(trimmed)) {
        errors[i] = 'Use letters, digits, and underscores only (must start with a letter or _)';
        return;
      }
      if ((nameCounts.get(trimmed) ?? 0) > 1) {
        errors[i] = 'Duplicate variable name';
      }
    });
    return errors;
  }, [inputVariables]);

  const updateVar = useCallback(
    (index: number, field: keyof InputVariable, value: unknown) => {
      const updated = inputVariables.map((v, i) => (i === index ? { ...v, [field]: value } : v));
      onUpdate({ ...config, inputVariables: updated });
    },
    [config, inputVariables, onUpdate],
  );

  const addVar = useCallback(() => {
    const updated = [...inputVariables, { name: '', type: 'string', required: true }];
    pendingFocus.current = true;
    setExpandedOnAdd(updated.length - 1);
    onUpdate({ ...config, inputVariables: updated });
  }, [config, inputVariables, onUpdate]);

  const removeVar = useCallback(
    (index: number) => {
      const updated = inputVariables.filter((_, i) => i !== index);
      onUpdate({ ...config, inputVariables: updated });
    },
    [config, inputVariables, onUpdate],
  );

  return (
    <div className="space-y-6" data-testid="start-config">
      <AppTriggersSection />

      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          Input Variables
        </h4>

        <div className="space-y-2">
          {inputVariables.map((variable, index) => (
            <VariableCard
              key={index}
              variable={variable}
              index={index}
              initialExpanded={index === expandedOnAdd}
              nameError={nameErrors[index]}
              nameRef={index === inputVariables.length - 1 ? lastNameRef : undefined}
              onUpdate={updateVar}
              onRemove={removeVar}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addVar}
          data-testid="add-input-var-btn"
          className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add input variable
        </button>
      </div>
    </div>
  );
}
