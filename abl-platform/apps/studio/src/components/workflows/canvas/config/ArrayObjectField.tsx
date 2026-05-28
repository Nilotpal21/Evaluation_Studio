'use client';

import { useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Toggle } from '../../../ui/Toggle';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArraySubProp {
  name: string;
  displayName: string;
  description?: string;
  type: string;
  required?: boolean;
  defaultValue?: unknown;
  options?:
    | Array<{ label: string; value: string | number }>
    | { options: Array<{ label: string; value: string | number }> };
}

interface ArrayObjectFieldProps {
  propName: string;
  displayName: string;
  description?: string;
  subProps: ArraySubProp[];
  value: string;
  onChange: (v: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseRows(value: string): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function defaultRow(subProps: ArraySubProp[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const sp of subProps) {
    if (sp.defaultValue !== undefined) {
      row[sp.name] = sp.defaultValue;
    } else if (sp.type === 'boolean') {
      row[sp.name] = false;
    } else if (sp.type === 'number') {
      row[sp.name] = '';
    } else {
      // pick first static option value if available, otherwise empty string
      const opts = resolveOptions(sp.options);
      row[sp.name] = opts.length > 0 ? opts[0].value : '';
    }
  }
  return row;
}

function resolveOptions(
  raw: ArraySubProp['options'],
): Array<{ label: string; value: string | number }> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray((raw as { options?: unknown[] }).options)) {
    return (raw as { options: Array<{ label: string; value: string | number }> }).options;
  }
  return [];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ArrayObjectField({
  displayName,
  description,
  subProps,
  value,
  onChange,
}: ArrayObjectFieldProps) {
  const rows = parseRows(value);

  const commit = useCallback(
    (newRows: Record<string, unknown>[]) => {
      onChange(JSON.stringify(newRows));
    },
    [onChange],
  );

  const addRow = useCallback(() => {
    commit([...rows, defaultRow(subProps)]);
  }, [rows, subProps, commit]);

  const removeRow = useCallback(
    (index: number) => {
      commit(rows.filter((_, i) => i !== index));
    },
    [rows, commit],
  );

  const updateCell = useCallback(
    (rowIndex: number, fieldName: string, cellValue: unknown) => {
      const updated = rows.map((row, i) =>
        i === rowIndex ? { ...row, [fieldName]: cellValue } : row,
      );
      commit(updated);
    },
    [rows, commit],
  );

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
        {displayName}
      </label>
      {description && <p className="text-xs text-subtle">{description}</p>}

      <div className="space-y-2">
        {rows.map((row, rowIdx) => (
          <div
            key={rowIdx}
            className={clsx(
              'rounded-md border border-default bg-background-subtle p-3 space-y-2',
              'relative',
            )}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-subtle font-medium">Row {rowIdx + 1}</span>
              <button
                type="button"
                onClick={() => removeRow(rowIdx)}
                className="p-0.5 rounded text-subtle hover:text-error transition-colors"
                aria-label="Remove row"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {subProps.map((sp) => (
              <SubFieldCell
                key={sp.name}
                subProp={sp}
                value={row[sp.name]}
                onChange={(v) => updateCell(rowIdx, sp.name, v)}
              />
            ))}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className={clsx(
          'flex items-center gap-1.5 text-xs text-accent hover:text-accent/80',
          'transition-colors py-1',
        )}
      >
        <Plus className="w-3.5 h-3.5" />
        Add row
      </button>
    </div>
  );
}

// ─── SubFieldCell ─────────────────────────────────────────────────────────────

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_.\-]+$/;
const IDENTIFIER_HINT = 'Letters, numbers, _ . - only (no spaces)';

function SubFieldCell({
  subProp,
  value,
  onChange,
}: {
  subProp: ArraySubProp;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const strVal = value === undefined || value === null ? '' : String(value);
  const isNameField = subProp.name === 'name' || subProp.name === 'propName';
  const hasInvalidChars = isNameField && strVal.length > 0 && !IDENTIFIER_PATTERN.test(strVal);

  return (
    <div className="space-y-1">
      <label className="text-xs text-foreground-muted">
        {subProp.displayName}
        {subProp.required && <span className="text-error ml-0.5">*</span>}
      </label>
      <SubFieldInput
        subProp={subProp}
        strVal={strVal}
        boolVal={value === true}
        onChange={onChange}
        isNameField={isNameField}
      />
      {hasInvalidChars && <p className="text-xs text-warning">{IDENTIFIER_HINT}</p>}
      {isNameField && !hasInvalidChars && <p className="text-xs text-subtle">{IDENTIFIER_HINT}</p>}
    </div>
  );
}

function SubFieldInput({
  subProp,
  strVal,
  boolVal,
  onChange,
  isNameField,
}: {
  subProp: ArraySubProp;
  strVal: string;
  boolVal: boolean;
  onChange: (v: unknown) => void;
  isNameField?: boolean;
}) {
  const options = resolveOptions(subProp.options);

  switch (subProp.type) {
    case 'boolean':
      return <Toggle checked={boolVal} onChange={(checked) => onChange(checked)} />;

    case 'number':
      return (
        <Input
          type="number"
          value={strVal}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder={subProp.description ?? subProp.displayName.toLowerCase()}
        />
      );

    case 'dropdown':
    case 'static_dropdown':
      if (options.length > 0) {
        return (
          <Select
            options={options.map((o) => ({ value: String(o.value), label: o.label }))}
            value={strVal}
            onChange={(v) => onChange(v)}
            placeholder={`Select ${subProp.displayName.toLowerCase()}`}
          />
        );
      }
      return (
        <Input
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={subProp.description ?? subProp.displayName.toLowerCase()}
        />
      );

    case 'string':
    default: {
      const invalid = isNameField && strVal.length > 0 && !IDENTIFIER_PATTERN.test(strVal);
      return (
        <Input
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={subProp.description ?? subProp.displayName.toLowerCase()}
          className={invalid ? 'border-warning' : undefined}
        />
      );
    }
  }
}
