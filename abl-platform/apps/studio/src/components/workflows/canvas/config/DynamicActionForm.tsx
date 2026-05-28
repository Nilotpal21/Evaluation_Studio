/**
 * DynamicActionForm Component
 *
 * Renders a form dynamically from ConnectorProperty[] (action props).
 *
 * Expression support strategy:
 * - String-like fields (string, dynamic_dropdown, file, json): inline {{expression}} in text input
 * - Non-string fields (number, boolean, dropdown, date, array): {⋮} toggle to switch
 *   between native control and expression text input
 * - Array fields: chip/tag input in static mode
 */

'use client';

import { useState, useCallback } from 'react';
import { Braces, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Toggle } from '../../../ui/Toggle';
import { ExpressionInput } from './ExpressionInput';
import { DynamicDropdownField } from './DynamicDropdownField';
import { DynamicMultiSelectField } from './DynamicMultiSelectField';
import { DynamicPropertiesField } from './DynamicPropertiesField';
import { ArrayObjectField } from './ArrayObjectField';
import type { TriggerOption } from '../hooks/useWorkflowExpressionContext';

// ─── Types ──────────────────────────────────────────────────────────────

interface ConnectorProperty {
  name: string;
  displayName: string;
  description?: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: string | number }>;
  /**
   * Names of other props this dropdown depends on. When any refresher value
   * changes, the options resolver is re-fetched. Present on Activepieces
   * `Property.Dropdown` fields that compute their options at runtime.
   */
  refreshers?: string[];
  /**
   * Sub-field schema for `array` props declared with `Property.Array({ properties: {...} })`.
   * When present, render `ArrayObjectField` instead of the flat `ChipInput`.
   */
  properties?: ConnectorProperty[];
}

interface DynamicActionFormProps {
  props: ConnectorProperty[];
  params: Record<string, string>;
  paramModes: Record<string, 'static' | 'expression'>;
  onParamChange: (name: string, value: string) => void;
  onModeChange: (name: string, mode: 'static' | 'expression') => void;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
  /**
   * Context for dynamic dropdown / dynamic-properties resolution. When all four
   * are set, dynamic props render via live-fetch components.
   * When absent, they gracefully degrade to text inputs.
   */
  projectId?: string;
  connectorName?: string;
  actionName?: string;
  connectionId?: string;
  /** When true, options are resolved via the trigger endpoint instead of the action endpoint */
  isTrigger?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Types that accept {{expression}} inline without a toggle */
const INLINE_EXPRESSION_TYPES = new Set(['string', 'dynamic_dropdown', 'file', 'json']);

/** Types that need a toggle to switch between native control and expression input */
const TOGGLE_EXPRESSION_TYPES = new Set([
  'number',
  'boolean',
  'dropdown',
  'multi_select_dropdown',
  'dynamic_properties',
  'date',
  'array',
]);

function isMultiline(prop: ConnectorProperty): boolean {
  const name = prop.name.toLowerCase();
  const desc = (prop.description ?? '').toLowerCase();
  return (
    prop.type === 'json' ||
    name.includes('body') ||
    name.includes('content') ||
    name.includes('message') ||
    name.includes('description') ||
    desc.includes('html') ||
    desc.includes('multiline')
  );
}

// ─── Main Component ─────────────────────────────────────────────────────

export function DynamicActionForm({
  props,
  params,
  paramModes,
  onParamChange,
  onModeChange,
  triggers,
  previousSteps,
  projectId,
  connectorName,
  actionName,
  connectionId,
  isTrigger,
}: DynamicActionFormProps) {
  if (props.length === 0) {
    return <p className="text-xs text-subtle py-2">This action has no input parameters.</p>;
  }

  return (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
        Action Inputs
      </h4>
      {props.map((prop) => (
        <DynamicField
          key={prop.name}
          prop={prop}
          value={params[prop.name] ?? ''}
          mode={paramModes[prop.name] ?? 'static'}
          onChange={(v) => onParamChange(prop.name, v)}
          onModeChange={(m) => onModeChange(prop.name, m)}
          onParamChange={onParamChange}
          triggers={triggers}
          previousSteps={previousSteps}
          params={params}
          projectId={projectId}
          connectorName={connectorName}
          actionName={actionName}
          connectionId={connectionId}
          isTrigger={isTrigger}
        />
      ))}
    </div>
  );
}

// ─── DynamicField ───────────────────────────────────────────────────────

function DynamicField({
  prop,
  value,
  mode,
  onChange,
  onModeChange,
  onParamChange,
  triggers,
  previousSteps,
  params,
  projectId,
  connectorName,
  actionName,
  connectionId,
  isTrigger,
}: {
  prop: ConnectorProperty;
  value: string;
  mode: 'static' | 'expression';
  onChange: (v: string) => void;
  onModeChange: (m: 'static' | 'expression') => void;
  onParamChange: (name: string, value: string) => void;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
  params: Record<string, string>;
  projectId?: string;
  connectorName?: string;
  actionName?: string;
  connectionId?: string;
  isTrigger?: boolean;
}) {
  const isInlineType = INLINE_EXPRESSION_TYPES.has(prop.type);
  const isToggleType = TOGGLE_EXPRESSION_TYPES.has(prop.type);
  const isExpressionMode = mode === 'expression';

  // For inline types, always render ExpressionInput (no toggle needed)
  if (isInlineType) {
    return (
      <ExpressionInput
        label={prop.displayName}
        value={value}
        onChange={onChange}
        placeholder={prop.description ?? `Enter ${prop.displayName.toLowerCase()}`}
        required={prop.required}
        multiline={isMultiline(prop)}
        description={prop.description}
        triggers={triggers}
        previousSteps={previousSteps}
      />
    );
  }

  // For toggle types, show native control or expression input
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
          {prop.displayName}
          {prop.required && <span className="text-error ml-0.5">*</span>}
        </label>
        {isToggleType && (
          <button
            type="button"
            onClick={() => onModeChange(isExpressionMode ? 'static' : 'expression')}
            className={clsx(
              'p-1 rounded text-xs flex items-center gap-1',
              'transition-colors',
              isExpressionMode ? 'text-accent bg-accent/10' : 'text-subtle hover:text-foreground',
            )}
            title={isExpressionMode ? 'Switch to static value' : 'Switch to expression'}
          >
            <Braces className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {prop.description && <p className="text-xs text-subtle">{prop.description}</p>}

      {isExpressionMode ? (
        <ExpressionInput
          value={value}
          onChange={onChange}
          placeholder={`{{expression}} for ${prop.displayName.toLowerCase()}`}
          triggers={triggers}
          previousSteps={previousSteps}
        />
      ) : (
        <NativeControl
          prop={prop}
          value={value}
          onChange={onChange}
          onParamChange={onParamChange}
          params={params}
          projectId={projectId}
          connectorName={connectorName}
          actionName={actionName}
          connectionId={connectionId}
          isTrigger={isTrigger}
          triggers={triggers}
          previousSteps={previousSteps}
        />
      )}
    </div>
  );
}

// ─── Native Controls ────────────────────────────────────────────────────

function NativeControl({
  prop,
  value,
  onChange,
  onParamChange,
  params,
  projectId,
  connectorName,
  actionName,
  connectionId,
  isTrigger,
  triggers,
  previousSteps,
}: {
  prop: ConnectorProperty;
  value: string;
  onChange: (v: string) => void;
  onParamChange: (name: string, value: string) => void;
  params: Record<string, string>;
  projectId?: string;
  connectorName?: string;
  actionName?: string;
  connectionId?: string;
  isTrigger?: boolean;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
}) {
  switch (prop.type) {
    case 'number':
      return (
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={prop.description ?? `Enter ${prop.displayName.toLowerCase()}`}
        />
      );

    case 'boolean':
      return (
        <Toggle checked={value === 'true'} onChange={(checked) => onChange(String(checked))} />
      );

    case 'dropdown': {
      // Activepieces `Property.Dropdown` props declare `refreshers` and resolve
      // options at edit time via a server-side resolver. Render the live
      // DynamicDropdownField when the surrounding context (project, connector,
      // action, connection) is available.
      const hasRefreshers = Array.isArray(prop.refreshers);
      if (hasRefreshers && projectId && connectorName && actionName && connectionId) {
        return (
          <DynamicDropdownField
            projectId={projectId}
            connectorName={connectorName}
            actionName={actionName}
            connectionId={connectionId}
            propName={prop.name}
            displayName={prop.displayName}
            refreshers={prop.refreshers ?? []}
            params={params}
            value={value}
            onChange={onChange}
            isTrigger={isTrigger}
          />
        );
      }

      // options may be an array or { options: [...] } from Activepieces adapter
      const rawOptions = prop.options ?? [];
      const dropdownOptions = Array.isArray(rawOptions)
        ? rawOptions
        : Array.isArray((rawOptions as Record<string, unknown>).options)
          ? ((rawOptions as Record<string, unknown>).options as Array<{
              label: string;
              value: string | number;
            }>)
          : [];

      // When no static options are available and no resolver context is wired,
      // fall back to a text input instead of rendering an empty Select.
      if (dropdownOptions.length === 0) {
        return (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={prop.description ?? `Enter ${prop.displayName.toLowerCase()}`}
          />
        );
      }

      return (
        <Select
          options={dropdownOptions.map((o) => ({
            value: String(o.value),
            label: o.label,
          }))}
          value={value}
          onChange={onChange}
          placeholder={`Select ${prop.displayName.toLowerCase()}`}
        />
      );
    }

    case 'date':
      return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />;

    case 'multi_select_dropdown': {
      const hasRefreshers = Array.isArray(prop.refreshers);
      if (hasRefreshers && projectId && connectorName && actionName && connectionId) {
        return (
          <DynamicMultiSelectField
            projectId={projectId}
            connectorName={connectorName}
            actionName={actionName}
            connectionId={connectionId}
            propName={prop.name}
            displayName={prop.displayName}
            refreshers={prop.refreshers ?? []}
            params={params}
            value={value}
            onChange={onChange}
            isTrigger={isTrigger}
          />
        );
      }
      return <ChipInput value={value} onChange={onChange} placeholder={prop.description} />;
    }

    case 'array':
      if (prop.properties && prop.properties.length > 0) {
        return (
          <ArrayObjectField
            propName={prop.name}
            displayName={prop.displayName}
            description={prop.description}
            subProps={prop.properties}
            value={value}
            onChange={onChange}
          />
        );
      }
      return <ChipInput value={value} onChange={onChange} placeholder={prop.description} />;

    case 'dynamic_properties': {
      if (projectId && connectorName && actionName && connectionId) {
        return (
          <DynamicPropertiesField
            projectId={projectId}
            connectorName={connectorName}
            actionName={actionName}
            connectionId={connectionId}
            propName={prop.name}
            displayName={prop.displayName}
            refreshers={prop.refreshers ?? []}
            params={params}
            onParamChange={onParamChange}
            isTrigger={isTrigger}
            triggers={triggers}
            previousSteps={previousSteps}
          />
        );
      }
      return (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={prop.description ?? `Enter ${prop.displayName.toLowerCase()}`}
        />
      );
    }

    default:
      return (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={prop.description ?? `Enter ${prop.displayName.toLowerCase()}`}
        />
      );
  }
}

// ─── ChipInput ──────────────────────────────────────────────────────────

function ChipInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState('');

  // Parse stored JSON array string, fallback to empty array
  const chips: string[] = (() => {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      // Graceful degradation: stored value may be a plain string, not JSON — treat as empty chip list
      return [];
    }
  })();

  const updateChips = useCallback(
    (newChips: string[]) => {
      onChange(JSON.stringify(newChips));
    },
    [onChange],
  );

  const addChip = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    const newChips = [...chips, trimmed];
    updateChips(newChips);
    setInputValue('');
  }, [inputValue, chips, updateChips]);

  const removeChip = useCallback(
    (index: number) => {
      const newChips = chips.filter((_, i) => i !== index);
      updateChips(newChips);
    },
    [chips, updateChips],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addChip();
      }
      if (e.key === 'Backspace' && !inputValue && chips.length > 0) {
        removeChip(chips.length - 1);
      }
    },
    [addChip, inputValue, chips, removeChip],
  );

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-1.5 rounded-md border border-default',
        'bg-background-subtle px-2 py-1.5 min-h-[38px]',
        'focus-within:border-border-focus focus-within:ring-1 focus-within:ring-border-focus',
        'transition-default',
      )}
    >
      {chips.map((chip, i) => (
        <span
          key={`${chip}-${i}`}
          className="inline-flex items-center gap-1 rounded-md bg-background-elevated border border-default px-2 py-0.5 text-xs text-foreground"
        >
          {chip}
          <button
            type="button"
            onClick={() => removeChip(i)}
            className="text-subtle hover:text-error transition-colors"
            aria-label={`Remove ${chip}`}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        className="flex-1 min-w-[100px] bg-transparent text-sm text-foreground placeholder:text-subtle outline-none py-0.5"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={addChip}
        placeholder={chips.length === 0 ? (placeholder ?? 'Type and press Enter') : 'Add more...'}
      />
    </div>
  );
}
