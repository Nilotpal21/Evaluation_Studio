'use client';

/**
 * AppTriggerPicker
 *
 * Guided flow for selecting an external app trigger:
 *   Step 1 — Browse searchable app catalog grid
 *   Step 2 — Select a trigger event for the chosen app
 *   Step 3 — Pick an auth profile (ABLP-913: replaces legacy connection picker;
 *            the IR field stays `connectionId` for now and semantically holds
 *            an auth-profile id)
 *
 * Emits { connectorName, triggerName, connectionId } for the parent form.
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { Search, ArrowLeft, Loader2, Plug } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch, handleResponse } from '../../../lib/api-client';
import { Badge } from '../../ui/Badge';
import { DynamicActionForm } from '../canvas/config/DynamicActionForm';
import { ConnectorLogo } from '../../connections/ConnectorLogo';
import { useAuthProfiles } from '../../../hooks/useAuthProfiles';
import { AuthProfilePicker } from '../../auth-profiles/AuthProfilePicker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TriggerProp {
  name: string;
  displayName: string;
  description?: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: string | number }>;
  refreshers?: string[];
}

interface TriggerSummary {
  name: string;
  displayName: string;
  description: string;
  strategy: string;
  props?: TriggerProp[];
}

interface ConnectorSummary {
  name: string;
  displayName: string;
  version: string;
  description: string;
  auth: { type: string };
  triggers: TriggerSummary[];
}

interface ConnectorListResponse {
  success: boolean;
  data: ConnectorSummary[];
}

export interface AppTriggerSelection {
  connectorName: string;
  triggerName: string;
  /** Auth-profile id (IR field name preserved for backward-compat). */
  connectionId: string;
  /** Optional trigger parameters configured by the user. */
  triggerParams?: Record<string, string>;
  /** Per-param mode (static vs expression) for the trigger params form. */
  triggerParamModes?: Record<string, 'static' | 'expression'>;
}

interface AppTriggerPickerProps {
  projectId: string;
  value: AppTriggerSelection;
  onChange: (selection: AppTriggerSelection) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AppTriggerPicker({ projectId, value, onChange }: AppTriggerPickerProps) {
  const [search, setSearch] = useState('');

  // Fetch connectors that have triggers
  const { data: connectorsData, isLoading: loadingConnectors } = useSWR<ConnectorListResponse>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/connectors` : null,
    async (url: string) => {
      const res = await apiFetch(url);
      return handleResponse<ConnectorListResponse>(res);
    },
  );

  const connectors = useMemo(() => {
    const all = connectorsData?.data ?? [];
    // Only show connectors with at least one trigger
    return all.filter((c) => c.triggers.length > 0);
  }, [connectorsData]);

  // Filter by search term
  const filtered = useMemo(() => {
    if (!search.trim()) return connectors;
    const q = search.toLowerCase();
    return connectors.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [connectors, search]);

  // Selected connector details
  const selectedConnector = connectors.find((c) => c.name === value.connectorName);
  const selectedTrigger = selectedConnector?.triggers.find((t) => t.name === value.triggerName);

  // Trigger params schema for Step 4 (DynamicActionForm)
  const triggerProps = useMemo(() => selectedTrigger?.props ?? [], [selectedTrigger]);

  // Fetch auth profiles for the selected connector (used for auto-select-when-one)
  const { profiles: authProfiles } = useAuthProfiles(value.connectorName ? projectId : null, {
    connector: value.connectorName || undefined,
    status: 'active',
    limit: 100,
  });

  // Auto-select profile when there's exactly one match.
  // Use a ref to track the connector+trigger pair we've already auto-selected for,
  // preventing re-triggering when onChange updates value.
  const autoSelectedRef = useRef('');
  useEffect(() => {
    const selectionKey = `${value.connectorName}:${value.triggerName}`;
    if (
      value.connectorName &&
      value.triggerName &&
      !value.connectionId &&
      authProfiles.length === 1 &&
      autoSelectedRef.current !== selectionKey
    ) {
      autoSelectedRef.current = selectionKey;
      onChange({ ...value, connectionId: authProfiles[0].id });
    }
  }, [authProfiles, value, onChange]);

  // ---- Step 1: App catalog ----
  if (!value.connectorName) {
    return (
      <div className="space-y-3" data-testid="app-trigger-step-catalog">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps…"
            className={clsx(
              'w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-default',
              'bg-background-muted text-foreground placeholder:text-muted',
              'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
            )}
          />
        </div>

        {/* Loading */}
        {loadingConnectors && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        )}

        {/* App grid */}
        {!loadingConnectors && filtered.length === 0 && (
          <div className="text-center py-6">
            <Plug className="w-6 h-6 text-muted mx-auto mb-2" />
            <p className="text-xs text-muted">
              {search ? 'No apps match your search' : 'No apps with triggers available'}
            </p>
          </div>
        )}

        {!loadingConnectors && filtered.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {filtered.map((connector) => (
              <button
                key={connector.name}
                data-testid={`app-card-${connector.name}`}
                onClick={() =>
                  onChange({ connectorName: connector.name, triggerName: '', connectionId: '' })
                }
                className={clsx(
                  'flex items-center gap-2.5 rounded-xl border border-default',
                  'bg-background-elevated p-3 shadow-sm text-left',
                  'hover:border-accent/50 hover:bg-accent/5 transition-default',
                  'cursor-pointer',
                )}
              >
                <ConnectorLogo name={connector.name} className="w-8 h-8" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">
                    {connector.displayName}
                  </p>
                  <p className="text-xs text-muted">
                    {connector.triggers.length} trigger{connector.triggers.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- Step 2: Event selector ----
  if (!value.triggerName) {
    return (
      <div className="space-y-3" data-testid="app-trigger-step-event">
        {/* Back to catalog */}
        <button
          onClick={() => onChange({ connectorName: '', triggerName: '', connectionId: '' })}
          className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground transition-default"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to apps
        </button>

        {/* Selected app header */}
        <div className="flex items-center gap-2">
          <ConnectorLogo name={value.connectorName} className="w-8 h-8" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {selectedConnector?.displayName ?? value.connectorName}
            </p>
            <p className="text-xs text-muted">Select a trigger event</p>
          </div>
        </div>

        {/* Trigger events list */}
        <div className="space-y-1.5">
          {selectedConnector?.triggers.map((trigger) => (
            <button
              key={trigger.name}
              data-testid={`app-trigger-event-${trigger.name}`}
              onClick={() => onChange({ ...value, triggerName: trigger.name, connectionId: '' })}
              className={clsx(
                'w-full flex items-center gap-3 rounded-lg border border-default',
                'bg-background-muted p-3 text-left',
                'hover:border-accent/50 hover:bg-accent/5 transition-default',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{trigger.displayName}</p>
                {trigger.description && (
                  <p className="text-xs text-muted mt-0.5">{trigger.description}</p>
                )}
              </div>
              <Badge variant="default">{trigger.strategy}</Badge>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- Step 3: Auth profile picker ----
  return (
    <div className="space-y-3" data-testid="app-trigger-step-auth-profile">
      {/* Back to events */}
      <button
        onClick={() => onChange({ ...value, triggerName: '', connectionId: '' })}
        className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground transition-default"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to events
      </button>

      {/* Selected app + event summary */}
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-accent/5 border border-accent/20">
        <ConnectorLogo name={value.connectorName} className="w-7 h-7" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {selectedConnector?.displayName ?? value.connectorName}
          </p>
          <p className="text-xs text-accent">{selectedTrigger?.displayName ?? value.triggerName}</p>
        </div>
      </div>

      {/* Auth profile list */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Auth Profile</label>

        <AuthProfilePicker
          projectId={projectId}
          value={value.connectionId || null}
          onChange={(profileId) => onChange({ ...value, connectionId: profileId ?? '' })}
          connectorName={value.connectorName}
          strictConnectorMatch
          placeholder="Select auth profile"
        />
      </div>

      {/* Step 4: Trigger params — shown when connection is selected and trigger has props */}
      {value.connectionId && triggerProps.length > 0 && (
        <div className="space-y-1.5" data-testid="app-trigger-step-params">
          <DynamicActionForm
            props={triggerProps}
            params={value.triggerParams ?? {}}
            paramModes={value.triggerParamModes ?? {}}
            onParamChange={(name, val) =>
              onChange({
                ...value,
                triggerParams: { ...(value.triggerParams ?? {}), [name]: val },
              })
            }
            onModeChange={(name, mode) =>
              onChange({
                ...value,
                triggerParamModes: { ...(value.triggerParamModes ?? {}), [name]: mode },
              })
            }
            triggers={[]}
            previousSteps={[]}
            projectId={projectId}
            connectorName={value.connectorName}
            actionName={value.triggerName}
            connectionId={value.connectionId}
            isTrigger={true}
          />
        </div>
      )}
    </div>
  );
}
