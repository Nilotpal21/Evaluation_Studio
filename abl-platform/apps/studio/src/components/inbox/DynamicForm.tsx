'use client';

/**
 * DynamicForm Component
 *
 * Renders form fields from HumanTaskFieldDef[] definitions.
 * Supports text, number, boolean, select, textarea, and date field types.
 */

import { useState, useCallback } from 'react';
import clsx from 'clsx';
import { Toggle } from '../ui/Toggle';
import type { HumanTaskFieldDef, HumanTaskFieldValidation } from '../../api/human-tasks';

interface DynamicFormProps {
  fields: HumanTaskFieldDef[];
  onSubmit: (values: Record<string, unknown>) => void;
  submitting?: boolean;
  submitLabel?: string;
}

const inputClasses = clsx(
  'w-full px-3 py-2 text-sm rounded-lg border border-default',
  'bg-background-muted text-foreground placeholder:text-muted',
  'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
);

const MAX_PATTERN_INPUT_LENGTH = 1000;
const MAX_USER_REGEX_PATTERN_LENGTH = 500;

const NESTED_QUANTIFIER_PATTERNS = [
  /\([^)]*[+*]\)[+*{]/,
  /\([^)]*[+*]\)\?/,
  /\(([^|)]+)\|(\1)\)[+*]/,
];

function canEvaluateClientPattern(pattern: string, value: string): boolean {
  if (!pattern || pattern.length > MAX_USER_REGEX_PATTERN_LENGTH) {
    return false;
  }

  if (value.length > MAX_PATTERN_INPUT_LENGTH) {
    return false;
  }

  return !NESTED_QUANTIFIER_PATTERNS.some((candidate) => candidate.test(pattern));
}

function matchesClientPattern(pattern: string, value: string): boolean | null {
  if (!canEvaluateClientPattern(pattern, value)) {
    return null;
  }

  try {
    return new RegExp(pattern).test(value);
  } catch {
    return null;
  }
}

export function DynamicForm({
  fields,
  onSubmit,
  submitting,
  submitLabel = 'Submit',
}: DynamicFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.defaultValue !== undefined) {
        initial[f.name] = f.defaultValue;
      } else if (f.type === 'boolean') {
        initial[f.name] = false;
      } else {
        initial[f.name] = '';
      }
    }
    return initial;
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    const newErrors: Record<string, string> = {};
    for (const f of fields) {
      const val = values[f.name];

      // Required check
      if (f.required && (val === '' || val == null)) {
        newErrors[f.name] = `${f.label} is required`;
        continue;
      }

      // Skip further validation if empty and not required
      if (val === '' || val == null) continue;

      const v: HumanTaskFieldValidation | undefined = f.validation;
      if (!v) continue;

      // String-length validation (text, textarea)
      if (typeof val === 'string') {
        if (v.minLength !== undefined && val.length < v.minLength) {
          newErrors[f.name] = `${f.label} must be at least ${v.minLength} characters`;
          continue;
        }
        if (v.maxLength !== undefined && val.length > v.maxLength) {
          newErrors[f.name] = `${f.label} must be at most ${v.maxLength} characters`;
          continue;
        }
        if (v.pattern) {
          const patternMatches = matchesClientPattern(v.pattern, val);
          if (patternMatches === false) {
            newErrors[f.name] = `${f.label} does not match the required format`;
            continue;
          }
        }
      }

      // Numeric range validation
      if (typeof val === 'number') {
        if (v.min !== undefined && val < v.min) {
          newErrors[f.name] = `${f.label} must be at least ${v.min}`;
          continue;
        }
        if (v.max !== undefined && val > v.max) {
          newErrors[f.name] = `${f.label} must be at most ${v.max}`;
          continue;
        }
      }
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    onSubmit(values);
  }, [fields, values, onSubmit]);

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const validation = field.validation;

        return (
          <div key={field.name} className="space-y-1.5">
            <label className="text-xs font-medium text-muted">
              {field.label}
              {field.required && <span className="text-error ml-0.5">*</span>}
            </label>

            {field.type === 'text' && (
              <input
                type="text"
                value={(values[field.name] as string) ?? ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                className={inputClasses}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                maxLength={validation?.maxLength}
              />
            )}

            {field.type === 'number' && (
              <input
                type="number"
                value={(values[field.name] as number) ?? ''}
                onChange={(e) => handleChange(field.name, e.target.valueAsNumber || '')}
                className={inputClasses}
                placeholder="0"
                min={validation?.min}
                max={validation?.max}
              />
            )}

            {field.type === 'boolean' && (
              <Toggle
                checked={Boolean(values[field.name])}
                onChange={(checked) => handleChange(field.name, checked)}
                label={field.label}
              />
            )}

            {field.type === 'select' && (
              <select
                value={(values[field.name] as string) ?? ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                className={inputClasses}
              >
                <option value="">Select...</option>
                {(field.options ?? []).map((opt) => {
                  const value = typeof opt === 'string' ? opt : opt.value;
                  const label = typeof opt === 'string' ? opt : opt.label;
                  return (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  );
                })}
              </select>
            )}

            {field.type === 'textarea' && (
              <textarea
                value={(values[field.name] as string) ?? ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                rows={3}
                className={clsx(inputClasses, 'resize-none')}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                maxLength={validation?.maxLength}
              />
            )}

            {field.type === 'date' && (
              <input
                type="date"
                value={(values[field.name] as string) ?? ''}
                onChange={(e) => handleChange(field.name, e.target.value)}
                className={inputClasses}
              />
            )}

            {errors[field.name] && <p className="text-xs text-error">{errors[field.name]}</p>}
          </div>
        );
      })}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className={clsx(
          'w-full px-4 py-2 text-sm font-medium rounded-lg transition-default',
          'bg-accent text-accent-foreground hover:bg-accent/90',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        {submitting ? 'Submitting...' : submitLabel}
      </button>
    </div>
  );
}
