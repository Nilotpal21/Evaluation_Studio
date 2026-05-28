/**
 * HyperParameterForm Component
 *
 * Renders dynamic parameter controls from a HyperParameter[] array.
 * Each parameter type (rangeSlider, text, dropdown, radioButton) maps to
 * the appropriate UI control with polished styling.
 */

import { useState, useRef, useCallback } from 'react';
import { Info, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';

// =============================================================================
// TYPES
// =============================================================================

interface HyperParameter {
  type: 'rangeSlider' | 'text' | 'textArea' | 'dropdown' | 'radioButton' | 'section' | 'toggle';
  name: string;
  unifiedParam: string;
  displayName: string;
  required: boolean;
  defaultValue?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  description: string;
  valueMap?: string[];
  options?: HyperParameter[];
  hyperParameters?: HyperParameter[];
  readonly?: boolean;
  placeholder?: string;
}

type HyperParameterValue = number | string | boolean;

interface HyperParameterFormProps {
  parameters: HyperParameter[];
  values: Record<string, HyperParameterValue>;
  onChange: (name: string, value: HyperParameterValue) => void;
  disabled?: boolean;
  compact?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

function getDisplayValue(value: number, param: HyperParameter): string {
  if (param.valueMap && param.valueMap.length > 0) {
    const index = Math.round(value);
    return param.valueMap[index] ?? String(value);
  }
  // Show appropriate decimal places based on step
  const step = param.step ?? 1;
  if (step < 1) {
    const decimals = String(step).split('.')[1]?.length ?? 2;
    return value.toFixed(decimals);
  }
  return String(value);
}

function getPercentage(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return ((value - min) / (max - min)) * 100;
}

function getHyperParameterValueKey(param: HyperParameter): string {
  if (param.unifiedParam === 'thinking.enabled') return 'enableThinking';
  if (param.unifiedParam === 'thinking.budget_tokens') return 'thinkingBudget';
  return param.name;
}

function readStoredHyperParameterValue(
  stored: Record<string, unknown>,
  param: HyperParameter,
): HyperParameterValue | undefined {
  const candidateKeys = [getHyperParameterValueKey(param), param.name, param.unifiedParam];
  for (const key of candidateKeys) {
    const value = stored[key];
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

export function getDefaultHyperParameterValues(
  parameters: HyperParameter[],
  stored: Record<string, unknown> = {},
): Record<string, HyperParameterValue> {
  const values: Record<string, HyperParameterValue> = {};

  const visit = (param: HyperParameter, includeDefault: boolean) => {
    const key = getHyperParameterValueKey(param);
    const storedValue = readStoredHyperParameterValue(stored, param);
    if (storedValue !== undefined) {
      values[key] = storedValue;
    } else if (includeDefault && param.defaultValue !== undefined) {
      values[key] = param.defaultValue;
    }

    for (const child of param.options ?? []) {
      visit(child, false);
    }
    for (const child of param.hyperParameters ?? []) {
      visit(child, includeDefault);
    }
  };

  for (const param of parameters) {
    visit(param, true);
  }

  return values;
}

// =============================================================================
// TOOLTIP
// =============================================================================

function ParamTooltip({ displayName, text }: { displayName: string; text: string }) {
  return (
    <Tooltip
      content={text}
      side="top"
      className="max-w-72 whitespace-normal break-words border border-default bg-background-elevated text-foreground shadow-lg leading-relaxed"
      arrowClassName="fill-background-elevated"
    >
      <button
        type="button"
        aria-label={`${displayName} description`}
        className="inline-flex cursor-help"
      >
        <Info className="w-3.5 h-3.5 text-foreground-subtle hover:text-foreground-muted transition-default" />
      </button>
    </Tooltip>
  );
}

// =============================================================================
// PARAM LABEL
// =============================================================================

function ParamLabel({
  displayName,
  required,
  description,
}: {
  displayName: string;
  required: boolean;
  description?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-medium text-foreground-muted">{displayName}</span>
      {required && <span className="text-error text-xs">*</span>}
      {description && <ParamTooltip displayName={displayName} text={description} />}
    </div>
  );
}

// =============================================================================
// RANGE SLIDER PARAMETER
// =============================================================================

function RangeSliderParam({
  param,
  value,
  onChange,
  disabled,
}: {
  param: HyperParameter;
  value: number;
  onChange: (val: number) => void;
  disabled?: boolean;
}) {
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const step = param.step ?? 1;
  const displayVal = getDisplayValue(value, param);
  const percentage = getPercentage(value, min, max);
  const numericDefault = typeof param.defaultValue === 'number' ? param.defaultValue : undefined;
  const hasDefault = numericDefault != null;
  const isDefault = hasDefault && value === numericDefault;

  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleValueClick = useCallback(() => {
    if (disabled) return;
    setEditText(displayVal);
    setIsEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [disabled, displayVal]);

  const commitEdit = useCallback(() => {
    setIsEditing(false);
    const v = parseFloat(editText);
    if (!isNaN(v)) {
      onChange(Math.min(max, Math.max(min, v)));
    }
  }, [editText, min, max, onChange]);

  const handleReset = useCallback(() => {
    if (numericDefault != null) onChange(numericDefault);
  }, [numericDefault, onChange]);

  return (
    <div className={clsx('group/slider', disabled && 'opacity-50')}>
      {/* Header: label + value */}
      <div className="flex items-center justify-between mb-2">
        <ParamLabel
          displayName={param.displayName}
          required={param.required}
          description={param.description}
        />
        <div className="flex items-center gap-1.5">
          {hasDefault && !isDefault && !disabled && (
            <button
              type="button"
              onClick={handleReset}
              className="p-0.5 rounded text-foreground-subtle hover:text-foreground-muted transition-default opacity-0 group-hover/slider:opacity-100"
              title={`Reset to ${getDisplayValue(numericDefault!, param)}`}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              className={clsx(
                'w-16 h-6 rounded-md border border-accent bg-background-subtle',
                'text-xs text-right font-mono tabular-nums text-foreground',
                'px-1.5 focus:outline-none focus:ring-1 focus:ring-border-focus',
              )}
            />
          ) : (
            <button
              type="button"
              onClick={handleValueClick}
              disabled={disabled}
              className={clsx(
                'min-w-[3rem] h-6 px-2 rounded-md',
                'bg-background-muted border border-default',
                'text-xs font-mono tabular-nums text-foreground text-right',
                'hover:border-foreground-subtle transition-default',
                disabled && 'cursor-not-allowed',
              )}
            >
              {displayVal}
            </button>
          )}
        </div>
      </div>

      {/* Slider track */}
      <div className="relative h-6 flex items-center">
        {/* Track background */}
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-background-muted" />
        {/* Filled portion */}
        <div
          className="absolute left-0 h-1.5 rounded-full bg-accent/60 transition-all duration-75"
          style={{ width: `${percentage}%` }}
        />
        {/* Default marker */}
        {hasDefault && !isDefault && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-full bg-foreground-subtle/40"
            style={{ left: `${getPercentage(numericDefault!, min, max)}%` }}
            title={`Default: ${getDisplayValue(numericDefault!, param)}`}
          />
        )}
        {/* Native range input — invisible but handles all interaction */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          disabled={disabled}
          className={clsx(
            'absolute inset-0 w-full h-full opacity-0 cursor-pointer',
            disabled && 'cursor-not-allowed',
          )}
        />
        {/* Custom thumb rendered on top */}
        <div
          className={clsx(
            'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none',
            'w-4 h-4 rounded-full',
            'bg-accent border-2 border-background shadow-md',
            'transition-transform duration-75',
            !disabled && 'group-active/slider:scale-110',
          )}
          style={{ left: `${percentage}%` }}
        />
      </div>

      {/* Min / Max labels */}
      <div className="flex items-center justify-between mt-1">
        <span className="text-xs text-foreground-subtle tabular-nums">
          {param.valueMap ? param.valueMap[0] : min}
        </span>
        <span className="text-xs text-foreground-subtle tabular-nums">
          {param.valueMap ? param.valueMap[param.valueMap.length - 1] : max}
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// TEXT PARAMETER
// =============================================================================

function TextParam({
  param,
  value,
  onChange,
  disabled,
}: {
  param: HyperParameter;
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={clsx(disabled && 'opacity-50')}>
      <div className="mb-2">
        <ParamLabel
          displayName={param.displayName}
          required={param.required}
          description={param.description}
        />
      </div>
      {param.type === 'textArea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={2}
          placeholder={param.placeholder}
          className={clsx(
            'w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm',
            'py-2 px-3 leading-relaxed resize-y',
            'placeholder:text-foreground-subtle',
            'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            'transition-default',
            disabled && 'cursor-not-allowed',
          )}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={param.placeholder}
          className={clsx(
            'w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm',
            'py-2 px-3 placeholder:text-foreground-subtle',
            'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            'transition-default',
            disabled && 'cursor-not-allowed',
          )}
        />
      )}
    </div>
  );
}

// =============================================================================
// DROPDOWN PARAMETER
// =============================================================================

function DropdownParam({
  param,
  value,
  onChange,
  disabled,
}: {
  param: HyperParameter;
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}) {
  if (!param.valueMap) return null;

  return (
    <div className={clsx(disabled && 'opacity-50')}>
      <Select
        label={param.displayName}
        options={param.valueMap.map((opt) => ({ value: opt, label: opt }))}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

// =============================================================================
// RADIO BUTTON WITH NESTED OPTIONS
// =============================================================================

function RadioGroupParam({
  param,
  values,
  onChange,
  disabled,
}: {
  param: HyperParameter;
  values: Record<string, HyperParameterValue>;
  onChange: (name: string, value: HyperParameterValue) => void;
  disabled?: boolean;
}) {
  if (!param.options) return null;

  return (
    <div className={clsx(disabled && 'opacity-50')}>
      <div className="mb-3">
        <ParamLabel
          displayName={param.displayName}
          required={param.required}
          description={param.description}
        />
      </div>
      <div className="space-y-4 pl-0.5">
        {param.options.map((opt) => {
          const key = getHyperParameterValueKey(opt);
          const optValue =
            typeof values[key] === 'number'
              ? (values[key] as number)
              : typeof opt.defaultValue === 'number'
                ? opt.defaultValue
                : (opt.min ?? 0);
          return (
            <RangeSliderParam
              key={opt.name}
              param={opt}
              value={optValue}
              onChange={(val) => onChange(key, val)}
              disabled={disabled}
            />
          );
        })}
      </div>
    </div>
  );
}

function ToggleParam({
  param,
  value,
  onChange,
  disabled,
}: {
  param: HyperParameter;
  value: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Toggle
      checked={value}
      onChange={onChange}
      label={param.displayName}
      description={param.description}
      disabled={disabled}
    />
  );
}

function SectionParam({
  param,
  values,
  onChange,
  disabled,
}: {
  param: HyperParameter;
  values: Record<string, HyperParameterValue>;
  onChange: (name: string, value: HyperParameterValue) => void;
  disabled?: boolean;
}) {
  const children = param.hyperParameters ?? [];
  if (children.length === 0) return null;

  return (
    <div className={clsx('rounded-lg border border-default bg-background-subtle p-3')}>
      <div className="mb-3">
        <ParamLabel
          displayName={param.displayName}
          required={param.required}
          description={param.description}
        />
      </div>
      <div className="space-y-4">
        {children.map((child) => renderHyperParameter(child, values, onChange, disabled))}
      </div>
    </div>
  );
}

function renderHyperParameter(
  param: HyperParameter,
  values: Record<string, HyperParameterValue>,
  onChange: (name: string, value: HyperParameterValue) => void,
  disabled?: boolean,
) {
  const key = getHyperParameterValueKey(param);

  if (param.type === 'rangeSlider') {
    const numValue =
      typeof values[key] === 'number'
        ? (values[key] as number)
        : typeof param.defaultValue === 'number'
          ? param.defaultValue
          : (param.min ?? 0);

    return (
      <RangeSliderParam
        key={key}
        param={param}
        value={numValue}
        onChange={(val) => onChange(key, val)}
        disabled={disabled}
      />
    );
  }

  if (param.type === 'text' || param.type === 'textArea') {
    const strValue = typeof values[key] === 'string' ? (values[key] as string) : '';

    return (
      <TextParam
        key={key}
        param={param}
        value={strValue}
        onChange={(val) => onChange(key, val)}
        disabled={disabled}
      />
    );
  }

  if (param.type === 'toggle') {
    const boolValue =
      typeof values[key] === 'boolean'
        ? (values[key] as boolean)
        : typeof param.defaultValue === 'boolean'
          ? param.defaultValue
          : false;
    return (
      <ToggleParam
        key={key}
        param={param}
        value={boolValue}
        onChange={(val) => onChange(key, val)}
        disabled={disabled}
      />
    );
  }

  if (param.type === 'section') {
    return (
      <SectionParam
        key={key}
        param={param}
        values={values}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (param.type === 'radioButton' && param.options) {
    return (
      <RadioGroupParam
        key={key}
        param={param}
        values={values}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  if (param.type === 'dropdown' && param.valueMap) {
    const strVal = String(values[key] ?? param.defaultValue ?? param.valueMap[0] ?? '');
    return (
      <DropdownParam
        key={key}
        param={param}
        value={strVal}
        onChange={(val) => onChange(key, val)}
        disabled={disabled}
      />
    );
  }

  return null;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function HyperParameterForm({
  parameters,
  values,
  onChange,
  disabled,
  compact,
}: HyperParameterFormProps) {
  if (parameters.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-foreground-subtle">
        No configurable parameters for this model.
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className={clsx('space-y-5', compact && 'space-y-4')}>
        {parameters.map((param) => {
          return renderHyperParameter(param, values, onChange, disabled);
        })}
      </div>
    </TooltipProvider>
  );
}

export type { HyperParameter, HyperParameterFormProps, HyperParameterValue };
