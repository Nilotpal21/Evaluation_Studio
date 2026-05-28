'use client';

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { ExpressionInput } from './ExpressionInput';
import { useNodeExpressionContext } from './NodeExpressionContext';

interface NodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

/**
 * Typed output entry for the enriched outputMapping shape. Declaring a type
 * per field lets Studio derive `workflow.outputSchema` at save time without
 * a second authoring surface.
 */
interface TypedOutputEntry {
  expression: string;
  type: string;
  description?: string;
}

/**
 * On-disk shape. Legacy workflows saved the value as a bare expression
 * string; new saves use the typed-object form. Both are accepted by the
 * workflow-engine converter (see `EndNodeConfigSchema`).
 */
type RawEntry =
  | string
  | {
      expression?: string;
      type?: string;
      description?: string;
    };

const TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'json', label: 'JSON' },
];

function normalize(entry: RawEntry): TypedOutputEntry {
  if (typeof entry === 'string') {
    return { expression: entry, type: 'json' };
  }
  return {
    expression: entry.expression ?? '',
    type: entry.type || 'json',
    description: entry.description,
  };
}

interface OutputMappingEditorProps {
  rawMapping: Record<string, RawEntry>;
  onChange: (next: Record<string, TypedOutputEntry>) => void;
  title?: string;
  description?: ReactNode;
  testId?: string;
  variant?: 'cards' | 'rows';
  addLabel?: string;
}

interface OutputMappingRowProps {
  name: string;
  entry: TypedOutputEntry;
  index: number;
  onUpdateName: (oldName: string, newName: string) => void;
  onUpdateField: (name: string, field: keyof TypedOutputEntry, value: string) => void;
  onRemove: (name: string) => void;
}

function OutputMappingRow({
  name,
  entry,
  index,
  onUpdateName,
  onUpdateField,
  onRemove,
}: OutputMappingRowProps) {
  const [expanded, setExpanded] = useState(!name || !entry.expression);
  const typeLabel = TYPE_OPTIONS.find((type) => type.value === entry.type)?.label ?? entry.type;

  return (
    <div className="rounded-lg border border-default bg-background-subtle">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex flex-1 items-center gap-2 px-2 py-2 text-left"
          data-testid={`output-field-toggle-${index}`}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-foreground-muted transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
          <span className="truncate text-sm text-foreground">{name || 'output_field'}</span>
          <span className="text-xs text-foreground-muted">{typeLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => onRemove(name)}
          className="px-3 py-2 text-foreground-muted transition-colors hover:text-error"
          aria-label="Remove output field"
          data-testid={`remove-output-field-${index}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {expanded ? (
        <div className="space-y-2 px-3 pb-3 pt-1">
          <Input
            label="Output Field"
            value={name}
            onChange={(event) => onUpdateName(name, event.target.value)}
            onBlur={(event) => onUpdateName(name, event.target.value.trim())}
            placeholder="field_name"
          />
          <Select
            label="Datatype"
            options={TYPE_OPTIONS}
            value={entry.type}
            onChange={(value) => onUpdateField(name, 'type', value)}
          />
          <Input
            label="Expression"
            value={entry.expression}
            onChange={(event) => onUpdateField(name, 'expression', event.target.value)}
            placeholder="{{context.steps.NodeName.output}}"
          />
          <Input
            label="Description"
            value={entry.description ?? ''}
            onChange={(event) => onUpdateField(name, 'description', event.target.value)}
            onBlur={(event) => onUpdateField(name, 'description', event.target.value.trim())}
            placeholder="Description (Optional)"
          />
        </div>
      ) : null}
    </div>
  );
}

export function OutputMappingEditor({
  rawMapping,
  onChange,
  title = 'Output Mapping',
  description,
  testId = 'output-mapping-config',
  variant = 'cards',
  addLabel = 'Add output mapping',
}: OutputMappingEditorProps) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const entries = Object.entries(rawMapping);

  const writeMapping = useCallback(
    (next: Record<string, TypedOutputEntry>) => {
      onChange(next);
    },
    [onChange],
  );

  const updateName = useCallback(
    (oldName: string, newName: string) => {
      const next: Record<string, TypedOutputEntry> = {};
      for (const [k, v] of Object.entries(rawMapping)) {
        const normalized = normalize(v);
        if (k === oldName) {
          next[newName] = normalized;
        } else {
          next[k] = normalized;
        }
      }
      writeMapping(next);
    },
    [rawMapping, writeMapping],
  );

  const updateField = useCallback(
    (name: string, field: keyof TypedOutputEntry, value: string) => {
      const next: Record<string, TypedOutputEntry> = {};
      for (const [k, v] of Object.entries(rawMapping)) {
        next[k] = { ...normalize(v), ...(k === name ? { [field]: value } : {}) };
      }
      writeMapping(next);
    },
    [rawMapping, writeMapping],
  );

  const addEntry = useCallback(() => {
    const next: Record<string, TypedOutputEntry> = {};
    for (const [k, v] of Object.entries(rawMapping)) {
      next[k] = normalize(v);
    }
    const blankNameAvailable = !Object.prototype.hasOwnProperty.call(next, '');
    next[blankNameAvailable ? '' : `output${entries.length + 1}`] = {
      expression: '',
      type: 'json',
    };
    writeMapping(next);
  }, [entries.length, rawMapping, writeMapping]);

  const removeEntry = useCallback(
    (name: string) => {
      const next: Record<string, TypedOutputEntry> = {};
      for (const [k, v] of Object.entries(rawMapping)) {
        if (k !== name) next[k] = normalize(v);
      }
      writeMapping(next);
    },
    [rawMapping, writeMapping],
  );

  return (
    <div className="space-y-4" data-testid={testId}>
      {title ? (
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {title}
        </h4>
      ) : null}
      {description ? <div className="text-xs text-foreground-muted">{description}</div> : null}

      {entries.map(([name, raw], index) => {
        const entry = normalize(raw);
        if (variant === 'rows') {
          return (
            <OutputMappingRow
              key={index}
              name={name}
              entry={entry}
              index={index}
              onUpdateName={updateName}
              onUpdateField={updateField}
              onRemove={removeEntry}
            />
          );
        }

        return (
          <div
            key={index}
            className="space-y-2 p-2 rounded-lg border border-default bg-background-subtle"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Input
                  label="Output field"
                  value={name}
                  onChange={(e) => updateName(name, e.target.value)}
                  placeholder="field_name"
                />
              </div>
              <div className="w-32">
                <Select
                  label="Type"
                  options={TYPE_OPTIONS}
                  value={entry.type}
                  onChange={(val) => updateField(name, 'type', val)}
                />
              </div>
              <button
                type="button"
                onClick={() => removeEntry(name)}
                className="mt-6 p-1 text-foreground-muted hover:text-error transition-colors"
                aria-label="Remove output mapping"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <ExpressionInput
              label="Expression"
              value={entry.expression}
              onChange={(v) => updateField(name, 'expression', v)}
              placeholder="{{context.steps.NodeName.output}}"
              triggers={triggers}
              previousSteps={previousSteps}
            />
            <Input
              label="Description"
              value={entry.description ?? ''}
              onChange={(e) => updateField(name, 'description', e.target.value)}
              placeholder="Optional description"
            />
          </div>
        );
      })}

      <button
        type="button"
        onClick={addEntry}
        className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors"
      >
        <Plus className="w-4 h-4" />
        {addLabel}
      </button>
    </div>
  );
}

export function EndNodeConfig({ config, onUpdate }: NodeConfigProps) {
  const rawMapping = (config.outputMapping as Record<string, RawEntry>) ?? {};

  const writeMapping = useCallback(
    (next: Record<string, TypedOutputEntry>) => {
      onUpdate({ ...config, outputMapping: next });
    },
    [config, onUpdate],
  );

  return (
    <OutputMappingEditor
      rawMapping={rawMapping}
      onChange={writeMapping}
      title="Output Mapping"
      description={
        <>
          Declares the shape this workflow emits. Type + description drive the derived{' '}
          <code>outputSchema</code> used by curl examples and OpenAPI exports.
        </>
      }
      testId="end-config"
    />
  );
}
