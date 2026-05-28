/**
 * IntegrationNodeConfig Component
 *
 * Orchestrator for integration node configuration:
 * 1. Integration + action selection via IntegrationPickerModal
 * 2. Auth profile picker filtered to selected connector (ABLP-913: replaces
 *    legacy connection picker; the IR field stays `connectionId` for now and
 *    semantically holds an auth-profile id)
 * 3. Dynamic form from action's ConnectorProperty[] schema
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plug, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../../../store/navigation-store';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { useNodeExpressionContext } from './NodeExpressionContext';
import { sanitizeError } from '../../../../lib/sanitize-error';
import { AuthProfilePicker } from '../../../auth-profiles/AuthProfilePicker';
import { ConnectorLogo } from '../../../connections/ConnectorLogo';
import {
  IntegrationPickerModal,
  type CatalogConnector,
  type ActionWithProps,
} from './IntegrationPickerModal';
import { DynamicActionForm } from './DynamicActionForm';

// ─── Types ──────────────────────────────────────────────────────────────

interface IntegrationNodeConfigProps {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

// ─── Component ──────────────────────────────────────────────────────────

export function IntegrationNodeConfig({ nodeId, config, onUpdate }: IntegrationNodeConfigProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const { triggers, previousSteps } = useNodeExpressionContext();

  // ── Config values ──
  const connectorId = (config.connectorId as string) ?? '';
  const actionName = (config.actionName as string) ?? '';
  // ABLP-913: `connectionId` IR field now stores an auth-profile id. The field
  // name is preserved to avoid migrating persisted workflow JSON; rename is a
  // follow-up cleanup commit.
  const authProfileId = (config.connectionId as string) ?? '';
  const params = (config.params as Record<string, string>) ?? {};
  const paramModes = (config.paramModes as Record<string, 'static' | 'expression'>) ?? {};

  // ── Local state ──
  const [pickerOpen, setPickerOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogConnector[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [actionProps, setActionProps] = useState<ActionWithProps['props']>([]);
  const [propsLoading, setPropsLoading] = useState(false);
  const [propsError, setPropsError] = useState<string | null>(null);

  // ── Fetch connector catalog ──
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setCatalogLoading(true);

    apiFetch(`/api/projects/${projectId}/connectors`)
      .then((res) => handleResponse<{ success: boolean; data: CatalogConnector[] }>(res))
      .then((result) => {
        if (!cancelled) setCatalog(result.data ?? []);
      })
      .catch((err) => {
        if (!cancelled) setCatalogError(sanitizeError(err, 'Failed to load integrations'));
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // ── Fetch action props when connector+action are selected ──
  useEffect(() => {
    if (!projectId || !connectorId || !actionName) {
      setActionProps([]);
      return;
    }

    let cancelled = false;
    setPropsLoading(true);
    setPropsError(null);

    apiFetch(`/api/projects/${projectId}/connectors/${connectorId}/actions`)
      .then((res) => handleResponse<{ success: boolean; data: ActionWithProps[] }>(res))
      .then((result) => {
        if (cancelled) return;
        const action = (result.data ?? []).find((a) => a.name === actionName);
        const fetchedProps = action?.props ?? [];
        setActionProps(fetchedProps);

        // Auto-populate default values for props that have defaultValue set
        // but aren't already in params. Without this, required props with defaults
        // (e.g. body_type: 'plain_text') are missing from config.params unless
        // the user explicitly interacts with the control.
        const defaults: Record<string, string> = {};
        for (const prop of fetchedProps) {
          if (prop.defaultValue !== undefined && prop.defaultValue !== null && !params[prop.name]) {
            defaults[prop.name] = String(prop.defaultValue);
          }
        }
        if (Object.keys(defaults).length > 0) {
          onUpdate({
            ...config,
            params: { ...params, ...defaults },
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setActionProps([]);
          setPropsError(sanitizeError(err, 'Failed to load action inputs'));
        }
      })
      .finally(() => {
        if (!cancelled) setPropsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, connectorId, actionName]);

  // ── Handlers ──
  const handleSelectIntegration = useCallback(
    (selectedConnector: string, selectedAction: string) => {
      // Reset params/modes when changing integration+action. If the connector
      // or action actually changed, also drop any captured `sampleOutput` —
      // it belongs to the PREVIOUS action's response shape, so leaving it on
      // the node would mislead downstream expression suggestions (offering
      // old fields under the new action's output). The Explorer will re-show
      // the "Test action" row until the user re-tests with the new action.
      const sampleChanged = selectedConnector !== connectorId || selectedAction !== actionName;
      // For auth.type='none' connectors (e.g. docling) auto-bind the system
      // placeholder auth-profile id. There's nothing for the user to select
      // and the workflow-engine expects a connectionId on the step.
      const catalogEntry = catalog.find((c) => c.name === selectedConnector);
      const isNoAuth = catalogEntry?.authType === 'none';
      const next: Record<string, unknown> = {
        ...config,
        connectorId: selectedConnector,
        actionName: selectedAction,
        connectionId: isNoAuth ? `system-${selectedConnector}-none` : '',
        params: {},
        paramModes: {},
      };
      if (sampleChanged) delete next.sampleOutput;
      onUpdate(next);
    },
    [config, connectorId, actionName, catalog, onUpdate],
  );

  const handleAuthProfileChange = useCallback(
    (value: string | null) => {
      onUpdate({ ...config, connectionId: value ?? '' });
    },
    [config, onUpdate],
  );

  const handleParamChange = useCallback(
    (name: string, value: string) => {
      onUpdate({
        ...config,
        params: { ...params, [name]: value },
      });
    },
    [config, params, onUpdate],
  );

  const handleModeChange = useCallback(
    (name: string, mode: 'static' | 'expression') => {
      onUpdate({
        ...config,
        paramModes: { ...paramModes, [name]: mode },
      });
    },
    [config, paramModes, onUpdate],
  );

  // ── Find display names from catalog ──
  const selectedConnector = catalog.find((c) => c.name === connectorId);
  const selectedAction = selectedConnector?.actions.find((a) => a.name === actionName);
  // Hide the Auth Profile picker entirely for connectors that don't need
  // user credentials (e.g. docling — auth.type='none'). The placeholder
  // connectionId is set in handleSelectIntegration and kept in sync below.
  const requiresAuthProfile = selectedConnector?.authType !== 'none';

  // Backfill the synthetic placeholder for nodes saved before this UI knew
  // about auth.type='none', so the workflow-engine still receives a binding.
  useEffect(() => {
    if (!selectedConnector || requiresAuthProfile) return;
    const expected = `system-${selectedConnector.name}-none`;
    if (authProfileId !== expected) {
      onUpdate({ ...config, connectionId: expected });
    }
  }, [selectedConnector, requiresAuthProfile, authProfileId, config, onUpdate]);

  const authProfilesUrl = projectId
    ? `/projects/${projectId}/settings/auth-profiles?connector=${encodeURIComponent(connectorId)}`
    : '';

  return (
    <div className="space-y-4" data-testid="integration-node-config">
      {/* 1. Integration + Action Selection */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
          Integration & Action
        </label>

        {connectorId && actionName && selectedConnector ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className={clsx(
              'w-full flex items-center gap-3 p-3 rounded-lg border border-default',
              'hover:border-border-focus hover:bg-background-muted',
              'transition-default text-left',
            )}
            data-testid="integration-selection-button"
          >
            <ConnectorLogo name={selectedConnector.name} className="w-8 h-8" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {selectedConnector.displayName}
              </p>
              <p className="text-xs text-subtle truncate">
                {selectedAction?.displayName ?? actionName}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-subtle shrink-0" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={catalogLoading}
            className={clsx(
              'w-full flex items-center justify-center gap-2 py-3 rounded-lg',
              'border border-dashed border-default',
              'text-sm text-foreground-muted',
              'hover:border-border-focus hover:bg-background-muted hover:text-foreground',
              'transition-default',
              catalogLoading && 'opacity-50 cursor-not-allowed',
            )}
            data-testid="integration-select-button"
          >
            {catalogLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plug className="w-4 h-4" />
            )}
            {catalogLoading ? 'Loading integrations...' : 'Select Integration & Action'}
          </button>
        )}

        {catalogError && <p className="text-xs text-error">{catalogError}</p>}
      </div>

      {/* Picker Modal */}
      <IntegrationPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        catalog={catalog}
        onSelect={handleSelectIntegration}
        initialConnectorId={connectorId || undefined}
      />

      {/* 2. Auth Profile picker — only shown when the connector requires
           per-user credentials. auth.type='none' connectors (e.g. docling)
           are auto-bound to a synthetic system-<connector>-none placeholder. */}
      {connectorId && projectId && requiresAuthProfile && (
        <div className="space-y-1" data-testid="integration-node-auth-profile">
          <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
            Auth Profile
          </label>
          <AuthProfilePicker
            projectId={projectId}
            value={authProfileId || null}
            onChange={handleAuthProfileChange}
            connectorName={connectorId}
            strictConnectorMatch
            placeholder="Select auth profile"
          />
          <button
            type="button"
            onClick={() => navigate(authProfilesUrl)}
            className="inline-flex items-center gap-1 text-xs text-subtle hover:text-foreground transition-colors mt-1"
            data-testid="manage-auth-profiles-link"
          >
            <ExternalLink className="w-3 h-3" />
            Manage auth profiles
          </button>
        </div>
      )}

      {/* 3. Dynamic Action Form — only shown when action is selected */}
      {connectorId && actionName && (
        <>
          {propsError && <p className="text-xs text-error">{propsError}</p>}
          {propsLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-subtle">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading action inputs...
            </div>
          ) : (
            <DynamicActionForm
              props={actionProps}
              params={params}
              paramModes={paramModes}
              onParamChange={handleParamChange}
              onModeChange={handleModeChange}
              triggers={triggers}
              previousSteps={previousSteps}
              projectId={projectId ?? undefined}
              connectorName={connectorId || undefined}
              actionName={actionName || undefined}
              connectionId={authProfileId || undefined}
            />
          )}
        </>
      )}
    </div>
  );
}
