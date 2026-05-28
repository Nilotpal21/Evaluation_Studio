/**
 * DynamicPropertiesField Component
 *
 * Renders an Activepieces `Property.DynamicProperties` prop by fetching the
 * field map from the workflow-engine at edit time. The resolver is called with
 * refresher values so dependent field sets (e.g. Jira issue fields change when
 * project or issue type changes) update correctly.
 *
 * Sub-field values are stored in the flat params map as dot-notation keys:
 *   `${propName}.${subFieldName}` → e.g. `issueFields.summary`
 *
 * Fetch triggers:
 *   - Initial mount (once connection + all non-empty refreshers are present)
 *   - Any refresher value change
 *
 * Expression support:
 *   - string / long_text / json: ExpressionInput inline (same as top-level)
 *   - number / boolean / date: {⋮} toggle between native control and expression input
 *   - dropdown / array: static only
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Braces } from 'lucide-react';
import { clsx } from 'clsx';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Toggle } from '../../../ui/Toggle';
import { ExpressionInput } from './ExpressionInput';
import type { TriggerOption } from '../hooks/useWorkflowExpressionContext';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { sanitizeError } from '../../../../lib/sanitize-error';
import { ArrayObjectField } from './ArrayObjectField';

// ─── Types ──────────────────────────────────────────────────────────────

interface DynamicSubField {
  name: string;
  displayName: string;
  type: string;
  required?: boolean;
  description?: string;
  options?: Array<{ label: string; value: string | number }>;
  /** Sub-field schema for ARRAY dynamic sub-fields (e.g. Claude extract-structured-data simple mode) */
  properties?: DynamicSubField[];
}

type DynamicPropertiesState = Record<string, DynamicSubField>;

interface DynamicPropertiesFieldProps {
  projectId: string;
  connectorName: string;
  /** Action or trigger name — used in the endpoint path */
  actionName: string;
  connectionId: string;
  propName: string;
  displayName: string;
  refreshers: string[];
  /** Full flat params map — sub-field values live at `${propName}.${subFieldName}` */
  params: Record<string, string>;
  onParamChange: (name: string, value: string) => void;
  /** When true, resolves field map via the trigger endpoint instead of the action endpoint */
  isTrigger?: boolean;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
}

// ─── Component ──────────────────────────────────────────────────────────

export function DynamicPropertiesField({
  projectId,
  connectorName,
  actionName,
  connectionId,
  propName,
  displayName,
  refreshers,
  params,
  onParamChange,
  isTrigger = false,
  triggers,
  previousSteps,
}: DynamicPropertiesFieldProps) {
  const [fields, setFields] = useState<DynamicPropertiesState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const onParamChangeRef = useRef(onParamChange);
  onParamChangeRef.current = onParamChange;

  const refresherKey = useMemo(
    () => refreshers.map((r) => `${r}=${params[r] ?? ''}`).join('|'),
    [refreshers, params],
  );

  useEffect(() => {
    if (!projectId || !connectionId) {
      setFields(null);
      return;
    }

    const propsValue: Record<string, unknown> = {};
    for (const r of refreshers) {
      if (params[r] !== undefined && params[r] !== '') {
        propsValue[r] = params[r];
      }
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const entitySegment = isTrigger ? `triggers/${actionName}` : `actions/${actionName}`;
    apiFetch(
      `/api/projects/${projectId}/connectors/${connectorName}/${entitySegment}/props/${propName}/dynamic-fields`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, propsValue }),
      },
    )
      .then((res) => handleResponse<{ success: boolean; data: DynamicPropertiesState }>(res))
      .then((result) => {
        if (!cancelled) {
          const newFieldNames = new Set(Object.keys(result.data ?? {}));
          const prefix = `${propName}.`;
          for (const paramKey of Object.keys(paramsRef.current)) {
            if (paramKey.startsWith(prefix)) {
              const subField = paramKey.slice(prefix.length);
              if (!newFieldNames.has(subField)) {
                onParamChangeRef.current(paramKey, '');
              }
            }
          }
          setFields(result.data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFields(null);
          setError(sanitizeError(err, `Failed to load ${displayName.toLowerCase()} fields`));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // refresherKey encodes refresher values; other deps are stable config
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, connectorName, actionName, connectionId, propName, refresherKey, isTrigger]);

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-subtle">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading fields...
      </div>
    );
  }

  if (error) {
    return <p className="text-xs text-error">{error}</p>;
  }

  if (!fields || Object.keys(fields).length === 0) {
    return (
      <p className="text-xs text-subtle py-1">
        {refreshers.length > 0
          ? 'Fill the fields above to load available inputs.'
          : 'No fields available.'}
      </p>
    );
  }

  return (
    <div className="space-y-3 pl-2 border-l-2 border-border-subtle">
      {Object.values(fields).map((subField) => {
        const key = `${propName}.${subField.name}`;
        const subValue = params[key] ?? '';
        return (
          <SubFieldControl
            key={subField.name}
            subField={subField}
            value={subValue}
            onChange={(v) => onParamChange(key, v)}
            triggers={triggers}
            previousSteps={previousSteps}
          />
        );
      })}
    </div>
  );
}

// ─── SubFieldControl ─────────────────────────────────────────────────────

function SubFieldControl({
  subField,
  value,
  onChange,
  triggers,
  previousSteps,
}: {
  subField: DynamicSubField;
  value: string;
  onChange: (v: string) => void;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
}) {
  // Inline types: ExpressionInput handles the label itself
  if (subField.type === 'string' || subField.type === 'long_text' || subField.type === 'json') {
    return (
      <ExpressionInput
        label={subField.displayName}
        value={value}
        onChange={onChange}
        placeholder={subField.description ?? `Enter ${subField.displayName.toLowerCase()}`}
        required={subField.required}
        multiline={subField.type === 'long_text' || subField.type === 'json'}
        description={subField.description}
        triggers={triggers}
        previousSteps={previousSteps}
      />
    );
  }

  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
        {subField.displayName}
        {subField.required && <span className="text-error ml-0.5">*</span>}
      </label>
      {subField.description && <p className="text-xs text-subtle">{subField.description}</p>}
      <SubFieldInput
        subField={subField}
        value={value}
        onChange={onChange}
        triggers={triggers}
        previousSteps={previousSteps}
      />
    </div>
  );
}

// ─── SubFieldInput ────────────────────────────────────────────────────────

function SubFieldInput({
  subField,
  value,
  onChange,
  triggers,
  previousSteps,
}: {
  subField: DynamicSubField;
  value: string;
  onChange: (v: string) => void;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
}) {
  switch (subField.type) {
    case 'array':
      if (subField.properties && subField.properties.length > 0) {
        return (
          <ArrayObjectField
            propName={subField.name}
            displayName={subField.displayName}
            description={subField.description}
            subProps={subField.properties}
            value={value}
            onChange={onChange}
          />
        );
      }
      return (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={subField.description ?? `Enter ${subField.displayName.toLowerCase()}`}
        />
      );

    case 'boolean':
      return (
        <ToggleableField
          value={value}
          onChange={onChange}
          triggers={triggers}
          previousSteps={previousSteps}
        >
          <Toggle checked={value === 'true'} onChange={(checked) => onChange(String(checked))} />
        </ToggleableField>
      );

    case 'number':
      return (
        <ToggleableField
          value={value}
          onChange={onChange}
          triggers={triggers}
          previousSteps={previousSteps}
        >
          <Input
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={subField.description ?? `Enter ${subField.displayName.toLowerCase()}`}
          />
        </ToggleableField>
      );

    case 'date':
      return (
        <ToggleableField
          value={value}
          onChange={onChange}
          triggers={triggers}
          previousSteps={previousSteps}
        >
          <Input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
        </ToggleableField>
      );

    case 'dropdown':
    case 'static_dropdown': {
      const options = subField.options ?? [];
      if (options.length > 0) {
        return (
          <Select
            options={options.map((o) => ({ value: String(o.value), label: o.label }))}
            value={value}
            onChange={onChange}
            placeholder={`Select ${subField.displayName.toLowerCase()}`}
          />
        );
      }
      return (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={subField.description ?? `Enter ${subField.displayName.toLowerCase()}`}
        />
      );
    }

    default:
      return (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={subField.description ?? `Enter ${subField.displayName.toLowerCase()}`}
        />
      );
  }
}

// ─── ToggleableField ──────────────────────────────────────────────────────
// Wraps number / boolean / date sub-fields with a {⋮} toggle — same pattern
// as DynamicActionForm's TOGGLE_EXPRESSION_TYPES handling.

function ToggleableField({
  value,
  onChange,
  triggers,
  previousSteps,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  triggers: TriggerOption[];
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
  children: React.ReactNode;
}) {
  const [isExpression, setIsExpression] = useState(() => value.includes('{{'));

  return (
    <div className="flex items-center gap-1">
      <div className="flex-1">
        {isExpression ? (
          <ExpressionInput
            value={value}
            onChange={onChange}
            placeholder="{{expression}}"
            triggers={triggers}
            previousSteps={previousSteps}
          />
        ) : (
          children
        )}
      </div>
      <button
        type="button"
        onClick={() => setIsExpression((prev) => !prev)}
        className={clsx(
          'p-1 rounded flex items-center shrink-0 transition-colors',
          isExpression ? 'text-accent bg-accent/10' : 'text-subtle hover:text-foreground',
        )}
        title={isExpression ? 'Switch to static value' : 'Switch to expression'}
      >
        <Braces className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
