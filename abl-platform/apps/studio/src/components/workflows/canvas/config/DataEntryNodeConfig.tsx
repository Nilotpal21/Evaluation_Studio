'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Textarea } from '../../../ui/Textarea';
import { ExpressionInput } from './ExpressionInput';
import { UserAssigneePicker } from './UserAssigneePicker';
import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

interface SelectOption {
  label: string;
  value: string;
}

interface FieldDef {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[] | SelectOption[];
  optionsExpression?: string;
}

const FIELD_TYPE_OPTIONS = [
  { value: 'select', label: 'Select' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'number', label: 'Number' },
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Textarea' },
];

const TIMEOUT_UNIT_OPTIONS = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
];

// ─── Select Options Sub-Editor ─────────────────────────────────────────

interface SelectOptionsEditorProps {
  field: FieldDef;
  index: number;
  onUpdateField: (index: number, key: keyof FieldDef, value: unknown) => void;
  onBatchUpdateField: (index: number, updates: Partial<FieldDef>) => void;
}

function SelectOptionsEditor({
  field,
  index,
  onUpdateField,
  onBatchUpdateField,
}: SelectOptionsEditorProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const isDynamic = !!field.optionsExpression;
  const rawOptions = field.options ?? [];
  // Normalise legacy string[] to SelectOption[]
  const staticOptions: SelectOption[] = rawOptions.map((opt) =>
    typeof opt === 'string' ? { label: opt, value: opt } : opt,
  );

  const pendingOptionFocus = useRef(false);
  const lastOptionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingOptionFocus.current && lastOptionRef.current) {
      lastOptionRef.current.focus();
      pendingOptionFocus.current = false;
    }
  });

  const toggleSource = useCallback(
    (dynamic: boolean) => {
      if (dynamic) {
        onBatchUpdateField(index, {
          optionsExpression: '{{context.steps.StepName.output.items}}',
          options: undefined,
        });
      } else {
        onBatchUpdateField(index, {
          optionsExpression: undefined,
          options: [],
        });
      }
    },
    [index, onBatchUpdateField],
  );

  return (
    <div className="space-y-2 pt-1 border-t border-default/50 mt-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-foreground">Select Options</label>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-foreground-muted">
            <input
              type="radio"
              name={`optionsSource-${index}`}
              checked={!isDynamic}
              onChange={() => toggleSource(false)}
              className="text-foreground"
            />
            Static
          </label>
          <label className="flex items-center gap-1 text-[11px] text-foreground-muted">
            <input
              type="radio"
              name={`optionsSource-${index}`}
              checked={isDynamic}
              onChange={() => toggleSource(true)}
              className="text-foreground"
            />
            Dynamic
          </label>
        </div>
      </div>

      {isDynamic ? (
        <ExpressionInput
          label="Context Expression"
          value={field.optionsExpression ?? ''}
          onChange={(v) => onUpdateField(index, 'optionsExpression', v)}
          placeholder="{{context.steps.API0001.output.options}}"
          triggers={triggers}
          previousSteps={previousSteps}
        />
      ) : (
        <div className="space-y-1">
          {staticOptions.map((opt, optIdx) => (
            <div key={optIdx} className="flex items-center gap-1.5">
              <input
                ref={optIdx === staticOptions.length - 1 ? lastOptionRef : undefined}
                className="flex-1 text-xs px-2 py-1 rounded border border-default bg-background text-foreground outline-none focus:ring-1 focus:ring-accent"
                value={opt.label}
                onChange={(e) => {
                  const updated = [...staticOptions];
                  updated[optIdx] = { ...updated[optIdx], label: e.target.value };
                  onUpdateField(index, 'options', updated);
                }}
                placeholder="Label"
                data-testid={`field-option-label-${index}-${optIdx}`}
              />
              <input
                className="flex-1 text-xs px-2 py-1 rounded border border-default bg-background text-foreground outline-none focus:ring-1 focus:ring-accent"
                value={opt.value}
                onChange={(e) => {
                  const updated = [...staticOptions];
                  updated[optIdx] = { ...updated[optIdx], value: e.target.value };
                  onUpdateField(index, 'options', updated);
                }}
                placeholder="Value"
                data-testid={`field-option-value-${index}-${optIdx}`}
              />
              <button
                type="button"
                onClick={() => {
                  onUpdateField(
                    index,
                    'options',
                    staticOptions.filter((_, i) => i !== optIdx),
                  );
                }}
                className="p-0.5 text-foreground-muted hover:text-error transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              pendingOptionFocus.current = true;
              onUpdateField(index, 'options', [...staticOptions, { label: '', value: '' }]);
            }}
            className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors"
            data-testid={`add-option-${index}`}
          >
            <Plus className="w-2.5 h-2.5" />
            Add option
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Field Card (collapsible) ──────────────────────────────────────────

interface FieldCardProps {
  field: FieldDef;
  index: number;
  initialExpanded: boolean;
  fieldNameRef?: RefObject<HTMLInputElement | null>;
  onUpdate: (index: number, key: keyof FieldDef, value: unknown) => void;
  onBatchUpdate: (index: number, updates: Partial<FieldDef>) => void;
  onRemove: (index: number) => void;
}

function FieldCard({
  field,
  index,
  initialExpanded,
  fieldNameRef,
  onUpdate,
  onBatchUpdate,
  onRemove,
}: FieldCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const typeLabel = FIELD_TYPE_OPTIONS.find((t) => t.value === field.type)?.label ?? field.type;

  return (
    <div
      className="rounded-lg border border-default bg-background-subtle"
      data-testid={`field-row-${index}`}
    >
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-2 px-2 py-2 text-left min-w-0"
          data-testid={`field-toggle-${index}`}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
          )}
          <span className="text-sm text-foreground truncate">{field.name || 'field_name'}</span>
          <span className="text-xs text-foreground-muted shrink-0">{typeLabel}</span>
          {field.required && (
            <span className="text-error ml-0.5 shrink-0" aria-label="required">
              *
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="px-3 py-2 text-foreground-muted hover:text-error transition-colors"
          data-testid={`remove-field-${index}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 px-3 pb-3 pt-1">
          <Input
            ref={fieldNameRef}
            label="Field Name"
            value={field.name}
            onChange={(e) => onUpdate(index, 'name', e.target.value)}
            placeholder="e.g. customer_name"
            data-testid={`field-name-${index}`}
          />
          <Select
            label="Type"
            options={FIELD_TYPE_OPTIONS}
            value={field.type}
            onChange={(val) => onUpdate(index, 'type', val)}
          />
          <Input
            label="Label"
            value={field.label ?? ''}
            onChange={(e) => onUpdate(index, 'label', e.target.value)}
            placeholder="Display label"
          />
          <label className="flex items-center gap-1.5 text-xs text-foreground">
            <input
              type="checkbox"
              checked={field.required ?? false}
              onChange={(e) => onUpdate(index, 'required', e.target.checked)}
              className="rounded border-default"
            />
            Required
          </label>

          {field.type === 'select' && (
            <SelectOptionsEditor
              field={field}
              index={index}
              onUpdateField={onUpdate}
              onBatchUpdateField={onBatchUpdate}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────

export function DataEntryNodeConfig({ nodeId, config, onUpdate }: NodeConfigProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const pendingFieldFocus = useRef(false);
  const lastFieldNameRef = useRef<HTMLInputElement>(null);
  const [expandedOnAdd, setExpandedOnAdd] = useState<number | null>(null);

  useEffect(() => {
    if (pendingFieldFocus.current && lastFieldNameRef.current) {
      lastFieldNameRef.current.focus();
      pendingFieldFocus.current = false;
    }
  });

  const subject = (config.subject as string) ?? '';
  const message = (config.message as string) ?? '';
  const fields = (config.fields as FieldDef[]) ?? [];
  const assignTo = (config.assignTo as string) ?? 'everyone';
  const assignees = (config.assignees as string[]) ?? [];
  const timeoutConfig = config.timeout as { duration: number; unit: string } | undefined;
  const timeoutEnabled = timeoutConfig !== undefined;
  const onTimeout = (config.onTimeout as string) ?? 'terminate';

  const update = useCallback(
    (field: string, value: unknown) => {
      onUpdate({ ...config, [field]: value });
    },
    [config, onUpdate],
  );

  const addField = useCallback(() => {
    pendingFieldFocus.current = true;
    const newFields = [...fields, { name: '', type: 'text', label: '', required: false }];
    setExpandedOnAdd(newFields.length - 1);
    update('fields', newFields);
  }, [fields, update]);

  const removeField = useCallback(
    (index: number) => {
      const newFields = fields.filter((_, i) => i !== index);
      update('fields', newFields);
    },
    [fields, update],
  );

  const updateField = useCallback(
    (index: number, key: keyof FieldDef, value: unknown) => {
      const newFields = fields.map((f, i) => (i === index ? { ...f, [key]: value } : f));
      update('fields', newFields);
    },
    [fields, update],
  );

  const batchUpdateField = useCallback(
    (index: number, updates: Partial<FieldDef>) => {
      const newFields = fields.map((f, i) => (i === index ? { ...f, ...updates } : f));
      update('fields', newFields);
    },
    [fields, update],
  );

  return (
    <div className="space-y-4" data-testid="data-entry-config">
      <ExpressionInput
        label="Subject"
        value={subject}
        onChange={(v) => update('subject', v)}
        placeholder="Enter subject"
        triggers={triggers}
        previousSteps={previousSteps}
      />

      <ExpressionInput
        label="Message"
        value={message}
        onChange={(v) => update('message', v)}
        placeholder="Enter message"
        multiline
        rows={4}
        triggers={triggers}
        previousSteps={previousSteps}
      />

      {/* Form Fields */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-foreground">Form Fields</label>
          <button
            type="button"
            onClick={addField}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
            data-testid="add-field-btn"
          >
            <Plus className="w-3 h-3" />
            Add Field
          </button>
        </div>

        {fields.length === 0 && (
          <p className="text-xs text-foreground-muted">
            No fields defined. Click "Add Field" to create form fields.
          </p>
        )}

        {fields.map((field, index) => (
          <FieldCard
            key={index}
            field={field}
            index={index}
            initialExpanded={index === expandedOnAdd}
            fieldNameRef={index === fields.length - 1 ? lastFieldNameRef : undefined}
            onUpdate={updateField}
            onBatchUpdate={batchUpdateField}
            onRemove={removeField}
          />
        ))}
      </div>

      {/* Assign To */}
      <div className="space-y-1.5" data-testid="config-assign-to">
        <label className="block text-sm font-medium text-foreground">Assign To</label>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="dataEntryAssignTo"
              value="everyone"
              checked={assignTo === 'everyone'}
              onChange={() => update('assignTo', 'everyone')}
              className="text-foreground"
            />
            Everyone
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="dataEntryAssignTo"
              value="specific"
              checked={assignTo === 'specific'}
              onChange={() => update('assignTo', 'specific')}
              className="text-foreground"
            />
            Specific people
          </label>
        </div>
      </div>

      {assignTo === 'specific' && (
        <div data-testid="config-assignees">
          <UserAssigneePicker value={assignees} onChange={(ids) => update('assignees', ids)} />
        </div>
      )}

      {/* Timeout */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={timeoutEnabled}
            onChange={(e) => {
              if (e.target.checked) {
                update('timeout', { duration: 60, unit: 'minutes' });
              } else {
                const next = { ...config };
                delete next.timeout;
                onUpdate(next);
              }
            }}
            className="rounded border-default"
          />
          Enable timeout
        </label>

        {timeoutEnabled && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label="Duration"
                type="number"
                min={1}
                value={timeoutConfig.duration}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsed = parseInt(raw, 10);
                  update('timeout', {
                    ...timeoutConfig,
                    duration: raw === '' || isNaN(parsed) ? ('' as unknown as number) : parsed,
                  });
                }}
                onBlur={() => {
                  if (!timeoutConfig.duration || timeoutConfig.duration < 1) {
                    update('timeout', { ...timeoutConfig, duration: 1 });
                  }
                }}
              />
            </div>
            <div className="flex-1">
              <Select
                label="Unit"
                options={TIMEOUT_UNIT_OPTIONS}
                value={timeoutConfig.unit}
                onChange={(val) => update('timeout', { ...timeoutConfig, unit: val })}
              />
            </div>
          </div>
        )}

        {timeoutEnabled && (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-foreground">On Timeout</label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="dataEntryOnTimeout"
                value="terminate"
                checked={onTimeout === 'terminate'}
                onChange={() => update('onTimeout', 'terminate')}
                className="text-foreground"
              />
              Terminate workflow
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="dataEntryOnTimeout"
                value="skip"
                checked={onTimeout === 'skip'}
                onChange={() => update('onTimeout', 'skip')}
                className="text-foreground"
              />
              Skip this step
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
