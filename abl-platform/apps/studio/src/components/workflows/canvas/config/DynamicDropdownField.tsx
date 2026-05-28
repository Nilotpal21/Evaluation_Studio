/**
 * DynamicDropdownField Component
 *
 * Renders an Activepieces `Property.Dropdown` by fetching options from the
 * workflow-engine at edit time. The resolver is called with the current
 * refresher values (other props declared in `refreshers`) so dependent
 * dropdowns (e.g. Sheet depends on Spreadsheet) update correctly.
 *
 * Fetch triggers:
 *   - Initial mount (once connection + all non-empty refreshers are present)
 *   - Any refresher value change (debounced via useEffect deps)
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { sanitizeError } from '../../../../lib/sanitize-error';

// ─── Types ──────────────────────────────────────────────────────────────

interface DropdownOption {
  label: string;
  value: string | number;
}

interface DropdownState {
  disabled: boolean;
  placeholder?: string;
  options: DropdownOption[];
}

interface DynamicDropdownFieldProps {
  projectId: string;
  connectorName: string;
  actionName: string;
  connectionId: string;
  propName: string;
  displayName: string;
  refreshers: string[];
  params: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
  /** When true, resolves options via the trigger endpoint instead of the action endpoint */
  isTrigger?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────

export function DynamicDropdownField({
  projectId,
  connectorName,
  actionName,
  connectionId,
  propName,
  displayName,
  refreshers,
  params,
  value,
  onChange,
  isTrigger = false,
}: DynamicDropdownFieldProps) {
  const [state, setState] = useState<DropdownState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable key for useEffect deps — changes when any refresher value changes.
  // Note: refresher array identity is not stable across renders, so serialize.
  const refresherKey = useMemo(
    () => refreshers.map((r) => `${r}=${params[r] ?? ''}`).join('|'),
    [refreshers, params],
  );

  useEffect(() => {
    if (!projectId || !connectionId) {
      setState(null);
      return;
    }

    // Build propsValue from refresher names. Only send refresher props —
    // the AP options fn spreads them onto its first argument alongside auth.
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
      `/api/projects/${projectId}/connectors/${connectorName}/${entitySegment}/props/${propName}/options`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, propsValue }),
      },
    )
      .then((res) => handleResponse<{ success: boolean; data: DropdownState }>(res))
      .then((result) => {
        if (!cancelled) setState(result.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setState(null);
          setError(sanitizeError(err, 'Failed to load options'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // refresherKey encodes the refresher values; other deps are stable config
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, connectorName, actionName, connectionId, propName, refresherKey, isTrigger]);

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-subtle">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading options...
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-error">{error}</p>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${displayName.toLowerCase()}`}
        />
      </div>
    );
  }

  // Resolver disabled (usually: a required refresher isn't filled yet).
  if (state?.disabled) {
    return (
      <Select
        options={[]}
        value={undefined}
        onChange={onChange}
        placeholder={
          state.placeholder ?? `Fill the fields above to load ${displayName.toLowerCase()}`
        }
      />
    );
  }

  const options = state?.options ?? [];
  if (options.length === 0) {
    // No options returned — fall back to text input so the user is not stuck.
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={state?.placeholder ?? `Enter ${displayName.toLowerCase()}`}
      />
    );
  }

  return (
    <Select
      options={options.map((o) => ({
        value:
          o.value !== null && typeof o.value === 'object'
            ? JSON.stringify(o.value)
            : String(o.value),
        label: o.label,
      }))}
      value={value}
      onChange={onChange}
      placeholder={state?.placeholder ?? `Select ${displayName.toLowerCase()}`}
    />
  );
}
