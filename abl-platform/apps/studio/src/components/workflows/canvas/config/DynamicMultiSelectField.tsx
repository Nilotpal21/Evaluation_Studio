'use client';

/**
 * DynamicMultiSelectField
 *
 * Fetches options from the workflow-engine (same as DynamicDropdownField) but
 * renders a checkbox list for multi-selection. Selected values are stored as
 * a JSON-stringified array so they round-trip cleanly with ChipInput's format.
 *
 * Used for Activepieces `Property.MultiSelectDropdown` props that declare a
 * runtime `options` resolver (i.e. have `refreshers`). Static multi-selects
 * (no refreshers) continue to use ChipInput.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { sanitizeError } from '../../../../lib/sanitize-error';

interface DropdownOption {
  label: string;
  value: string | number;
}

interface DropdownState {
  disabled: boolean;
  placeholder?: string;
  options: DropdownOption[];
}

interface DynamicMultiSelectFieldProps {
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
  isTrigger?: boolean;
}

/** Parse the stored JSON-array string into a Set of selected values */
function parseSelected(raw: string): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
  } catch {
    // fall through — treat raw as a single comma-separated or lone value
    if (raw.includes(',')) {
      return new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    return new Set([raw]);
  }
  return new Set();
}

export function DynamicMultiSelectField({
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
}: DynamicMultiSelectFieldProps) {
  const [state, setState] = useState<DropdownState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresherKey = useMemo(
    () => refreshers.map((r) => `${r}=${params[r] ?? ''}`).join('|'),
    [refreshers, params],
  );

  useEffect(() => {
    if (!projectId || !connectionId) {
      setState(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, connectorName, actionName, connectionId, propName, refresherKey, isTrigger]);

  const selected = useMemo(() => parseSelected(value), [value]);

  const toggle = (optValue: string) => {
    const next = new Set(selected);
    if (next.has(optValue)) {
      next.delete(optValue);
    } else {
      next.add(optValue);
    }
    onChange(JSON.stringify(Array.from(next)));
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-subtle">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading options...
      </div>
    );
  }

  if (error) {
    return <p className="text-xs text-error">{error}</p>;
  }

  if (state?.disabled) {
    return (
      <p className="text-xs text-subtle italic">
        {state.placeholder ?? `Fill the fields above to load ${displayName.toLowerCase()}`}
      </p>
    );
  }

  const options = state?.options ?? [];
  if (options.length === 0 && state !== null) {
    return (
      <p className="text-xs text-subtle italic">
        {state?.placeholder ?? `No options available for ${displayName.toLowerCase()}`}
      </p>
    );
  }

  if (options.length === 0) {
    return null;
  }

  return (
    <div
      className={clsx(
        'rounded-lg border border-default bg-background-subtle',
        'max-h-48 overflow-y-auto divide-y divide-border-subtle',
      )}
    >
      {options.map((opt) => {
        const optValue = String(opt.value);
        const isSelected = selected.has(optValue);
        return (
          <button
            key={optValue}
            type="button"
            onClick={() => toggle(optValue)}
            className={clsx(
              'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors',
              'hover:bg-background-muted',
              isSelected && 'bg-accent/5',
            )}
          >
            <span
              className={clsx(
                'w-4 h-4 shrink-0 rounded border flex items-center justify-center',
                isSelected
                  ? 'bg-accent border-accent text-accent-foreground'
                  : 'border-default bg-background',
              )}
            >
              {isSelected && <Check className="w-3 h-3" />}
            </span>
            <span
              className={clsx(
                'flex-1 truncate',
                isSelected ? 'text-foreground font-medium' : 'text-foreground-muted',
              )}
            >
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
