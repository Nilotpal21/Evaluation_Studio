'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Plus, Trash2, ExternalLink, Search, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Textarea } from '../../../ui/Textarea';
import { ExpressionInput } from './ExpressionInput';
import { useNavigationStore } from '../../../../store/navigation-store';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { apiFetch, handleResponse } from '../../../../lib/api-client';
import { useNodeExpressionContext } from './NodeExpressionContext';
import { IntegrationNodeConfig } from './IntegrationNodeConfig';
import { parseDslProperties, parseSignatureLine } from '@agent-platform/shared/tools';

interface ToolParamSchema {
  name: string;
  required: boolean;
}

type ToolNodeExecutionMode = 'sync' | 'async_continue' | 'async_wait';
type ToolNodeCallbackLocation = 'body' | 'query' | 'header';

interface ToolNodeCallbackConfig {
  enabled: boolean;
  location: ToolNodeCallbackLocation;
  callbackUrlKey: string;
  callbackSecretKey: string;
}

const DEFAULT_HTTP_CALLBACK_URL_KEY = 'callbackUrl';
const DEFAULT_HTTP_CALLBACK_SECRET_KEY = 'callbackSecret';
const DEFAULT_HTTP_CALLBACK_CONFIG: ToolNodeCallbackConfig = {
  enabled: true,
  location: 'body',
  callbackUrlKey: DEFAULT_HTTP_CALLBACK_URL_KEY,
  callbackSecretKey: DEFAULT_HTTP_CALLBACK_SECRET_KEY,
};

function parseToolParamSchema(dslContent: string | undefined): ToolParamSchema[] {
  if (!dslContent) return [];
  try {
    const { parameters } = parseSignatureLine(dslContent);
    return parameters.map((p) => ({ name: p.name, required: p.required }));
  } catch {
    return [];
  }
}

function parseWorkflowToolMode(dslContent: string | undefined): 'sync' | 'async' | null {
  if (!dslContent) return null;
  try {
    const mode = parseDslProperties(dslContent).mode;
    return mode === 'sync' || mode === 'async' ? mode : null;
  } catch {
    return null;
  }
}

// Only required schema params are auto-prefilled. Optional params stay hidden
// behind the "Optional Parameters" dialog so the user controls which ones
// appear in the node panel. Existing user entries (required, optional, custom)
// are always preserved — including optional keys previously toggled on.
function mergeParamsWithSchema(
  existing: Record<string, string>,
  schema: ToolParamSchema[],
): Record<string, string> {
  const merged: Record<string, string> = { ...existing };
  for (const p of schema) {
    if (p.required && !(p.name in merged)) merged[p.name] = '';
  }
  return merged;
}

interface GenericNodeConfigProps {
  nodeType: string;
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}

const DELAY_UNIT_OPTIONS = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
];

const DELAY_MIN_SECONDS = 5;
const DELAY_MAX_SECONDS = 86400; // 24 hours
const UNIT_TO_SECONDS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

function toSeconds(duration: number, unit: string): number {
  return duration * (UNIT_TO_SECONDS[unit] ?? 1);
}

const STUB_NODE_TYPES = ['browser', 'doc_search', 'doc_intelligence'];

function DelayConfig({
  config,
  onUpdate,
}: {
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  // `duration` can legitimately be '' mid-edit (user cleared the field
  // before typing a new value). We intentionally do NOT snap that back to a
  // default — doing so caused the "can't backspace, it keeps resetting"
  // bug where every edit instantly refilled 30.
  const rawDuration = config.duration as number | string | undefined;
  const duration = rawDuration ?? DELAY_MIN_SECONDS;
  const unit = (config.unit as string) ?? 'seconds';
  useEffect(() => {
    if (config.unit !== 'days') return;
    const numeric = typeof config.duration === 'number' ? config.duration : Number(config.duration);
    if (!Number.isFinite(numeric)) return;
    const inHours = Math.min(numeric * 24, DELAY_MAX_SECONDS / 3600);
    onUpdate({ ...config, unit: 'hours', duration: inHours });
  }, []);

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  const numericDuration = typeof duration === 'number' ? duration : Number(duration);
  const isEmpty = duration === '' || Number.isNaN(numericDuration);
  const totalSeconds = toSeconds(numericDuration, unit);
  const error = isEmpty
    ? 'Duration is required'
    : numericDuration <= 0
      ? 'Duration must be a positive number'
      : totalSeconds < DELAY_MIN_SECONDS
        ? `Minimum delay is ${DELAY_MIN_SECONDS} seconds`
        : totalSeconds > DELAY_MAX_SECONDS
          ? 'Maximum delay is 24 hours (86,400 seconds)'
          : undefined;

  return (
    <div className="space-y-4">
      <Input
        label="Duration"
        type="number"
        min={1}
        value={duration}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            // Keep the field empty while the user is editing. Commit a
            // numeric fallback onBlur so we never save an empty string.
            update('duration', '');
            return;
          }
          const parsed = parseInt(raw, 10);
          if (!Number.isNaN(parsed)) update('duration', parsed);
        }}
        onBlur={() => {
          if (isEmpty || numericDuration <= 0) {
            update('duration', DELAY_MIN_SECONDS);
          }
        }}
        error={error}
      />
      <Select
        label="Unit"
        options={DELAY_UNIT_OPTIONS}
        value={unit}
        onChange={(val) => update('unit', val)}
      />
      <p className="text-xs text-subtle">Allowed range: {DELAY_MIN_SECONDS} seconds to 24 hours.</p>
    </div>
  );
}

function AgenticAppConfig({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  const { triggers, previousSteps } = useNodeExpressionContext();
  const agentId = (config.agentId as string) ?? '';
  const deploymentEnv = (config.deploymentEnv as string) ?? '';
  const input = (config.input as string) ?? '';
  const timeout = (config.timeout as number) ?? 120;

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  return (
    <div className="space-y-4">
      <Input
        label="Agent ID"
        value={agentId}
        onChange={(e) => update('agentId', e.target.value)}
        placeholder="Agent identifier"
      />
      <Input
        label="Deployment Environment"
        value={deploymentEnv}
        onChange={(e) => update('deploymentEnv', e.target.value)}
        placeholder="e.g. production"
      />
      <ExpressionInput
        label="Input"
        value={input}
        onChange={(v) => update('input', v)}
        placeholder="{{context.trigger.payload.message}}"
        multiline
        rows={4}
        triggers={triggers}
        previousSteps={previousSteps}
      />
      <Input
        label="Timeout (seconds)"
        type="number"
        min={30}
        max={600}
        value={timeout}
        onChange={(e) => update('timeout', parseInt(e.target.value, 10) || 120)}
      />
    </div>
  );
}

function AgentNodeConfig({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  const projectId = useNavigationStore((s) => s.projectId);
  const { triggers, previousSteps } = useNodeExpressionContext();
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  // Always start with loading=true so the first paint shows a spinner —
  // never the "Create an agent" empty state with a possibly-broken link.
  // useNavigationStore.projectId can hydrate async, so the initial render
  // may see projectId=null even when a real project is being loaded.
  const [loading, setLoading] = useState<boolean>(true);

  const agentId = (config.agentId as string) ?? '';
  const input = (config.input as string) ?? '';
  const sessionId = (config.sessionId as string) ?? '';
  const timeout = (config.timeout as number) ?? 120;

  useEffect(() => {
    // Wait for projectId to hydrate — don't render the empty-state CTA yet,
    // it would carry a broken /projects/null/agents link.
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/projects/${projectId}/agents`)
      .then((res) =>
        handleResponse<{ success: boolean; agents: Array<{ id: string; name: string }> }>(res),
      )
      .then((data) => {
        if (!cancelled && data.agents) {
          setAgents(data.agents);
        }
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));
  const navigate = useNavigationStore((s) => s.navigate);

  return (
    <div className="space-y-4" data-testid="agent-node-config">
      {loading ? (
        <div className="space-y-1.5" data-testid="agent-select-loading">
          <label className="block text-sm font-medium text-foreground">Agent</label>
          <div className="flex flex-col items-center justify-center h-20 gap-2 rounded-md border border-default bg-background-subtle">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
            <span className="text-xs text-muted">Loading agents...</span>
          </div>
        </div>
      ) : agents.length === 0 ? (
        <div className="space-y-1.5" data-testid="agent-empty-state">
          <label className="block text-sm font-medium text-foreground">Agent</label>
          <p className="text-xs text-foreground-muted">No agents available in this project.</p>
          <button
            type="button"
            data-testid="agent-create-link"
            onClick={() => navigate(`/projects/${projectId}/agents`)}
            className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Create an agent
          </button>
        </div>
      ) : (
        <Select
          label="Agent"
          id="agent-select"
          options={agentOptions}
          value={agentId || undefined}
          onChange={(val) => update('agentId', val)}
          placeholder="Select Agent"
        />
      )}
      <ExpressionInput
        label="Input"
        value={input}
        onChange={(v) => update('input', v)}
        placeholder="{{context.trigger.payload.message}}"
        multiline
        rows={4}
        triggers={triggers}
        previousSteps={previousSteps}
      />
      <ExpressionInput
        label="Session ID (optional)"
        value={sessionId}
        onChange={(v) => update('sessionId', v)}
        placeholder="Leave blank for new session"
        triggers={triggers}
        previousSteps={previousSteps}
      />
      <Input
        label="Timeout (seconds)"
        type="number"
        min={30}
        max={600}
        value={timeout}
        onChange={(e) => update('timeout', parseInt(e.target.value, 10) || 120)}
      />
    </div>
  );
}

function ToolNodeConfig({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  const projectId = useNavigationStore((s) => s.projectId);
  const { triggers, previousSteps } = useNodeExpressionContext();
  const [tools, setTools] = useState<Array<{ id: string; name: string; toolType?: string }>>([]);
  // Always start with loading=true so the first paint shows a spinner —
  // never the "Create a tool" empty state with a possibly-broken link.
  // useNavigationStore.projectId can hydrate async, so the initial render
  // may see projectId=null even when a real project is being loaded.
  const [loading, setLoading] = useState<boolean>(true);
  const [paramSchema, setParamSchema] = useState<ToolParamSchema[]>([]);
  const [selectedToolType, setSelectedToolType] = useState<string | null>(null);
  const [selectedWorkflowMode, setSelectedWorkflowMode] = useState<'sync' | 'async' | null>(null);
  const [selectedHttpMethod, setSelectedHttpMethod] = useState<string | null>(null);
  const [optionalQuery, setOptionalQuery] = useState('');
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const typeaheadRef = useRef<HTMLDivElement>(null);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);

  const toolId = (config.toolId as string) ?? '';
  const params = (config.params as Record<string, string>) ?? {};
  const timeout = (config.timeout as number) ?? 30;
  const executionMode = (config.executionMode as ToolNodeExecutionMode | undefined) ?? 'sync';
  const normalizedHttpExecutionMode = executionMode === 'async_wait' ? 'async_wait' : 'sync';
  const callbackConfig = (config.callbackConfig as ToolNodeCallbackConfig | undefined) ?? {
    ...DEFAULT_HTTP_CALLBACK_CONFIG,
  };
  const entries = Object.entries(params);
  const requiredSet = new Set(paramSchema.filter((p) => p.required).map((p) => p.name));
  const schemaKeys = new Set(paramSchema.map((p) => p.name));
  const availableOptional = paramSchema.filter((p) => !p.required && !(p.name in params));
  const filteredSuggestions = optionalQuery
    ? availableOptional.filter((p) => p.name.toLowerCase().includes(optionalQuery.toLowerCase()))
    : availableOptional;

  // Hold the latest config + onUpdate so the async schema-fetch resolve below
  // doesn't clobber sibling edits made between tool-select and fetch-resolve.
  const configRef = useRef(config);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    configRef.current = config;
    onUpdateRef.current = onUpdate;
  });

  useEffect(() => {
    // Wait for projectId to hydrate — same reasoning as AgentNodeConfig.
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    const search = new URLSearchParams();
    if (workflowId) {
      search.set('currentWorkflowId', workflowId);
    }
    apiFetch(
      `/api/projects/${projectId}/tools/workflow-compatible${search.size > 0 ? `?${search.toString()}` : ''}`,
    )
      .then((res) =>
        handleResponse<{
          success: boolean;
          data: Array<{ id: string; name: string; toolType?: string }>;
        }>(res),
      )
      .then((resp) => {
        if (!cancelled && resp.data) {
          setTools(resp.data);
        }
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load the selected tool's param schema. Runs on mount (for existing nodes)
  // and whenever toolId changes. Backfills any missing required param keys so
  // the user sees them without having to click "Add parameter".
  useEffect(() => {
    if (!projectId || !toolId) {
      setParamSchema([]);
      setSelectedToolType(null);
      setSelectedWorkflowMode(null);
      setSelectedHttpMethod(null);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/projects/${projectId}/tools/${toolId}`)
      .then((res) =>
        handleResponse<{
          success: boolean;
          tool?: { dslContent?: string; toolType?: string };
        }>(res),
      )
      .then((resp) => {
        if (cancelled) return;
        const schema = parseToolParamSchema(resp.tool?.dslContent);
        const nextToolType = typeof resp.tool?.toolType === 'string' ? resp.tool.toolType : null;
        const nextWorkflowMode =
          nextToolType === 'workflow' ? parseWorkflowToolMode(resp.tool?.dslContent) : null;
        const nextHttpMethod =
          nextToolType === 'http'
            ? (parseDslProperties(resp.tool?.dslContent ?? '').method ?? 'GET').toUpperCase()
            : null;
        setParamSchema(schema);
        setSelectedToolType(nextToolType);
        setSelectedWorkflowMode(nextWorkflowMode);
        setSelectedHttpMethod(nextHttpMethod);
        const latestConfig = configRef.current;
        const current = (latestConfig.params as Record<string, string>) ?? {};
        const merged = mergeParamsWithSchema(current, schema);
        const resetExecutionMode =
          ((nextToolType === 'workflow' && nextWorkflowMode !== 'async') ||
            (nextToolType === 'http' && latestConfig.executionMode === 'async_continue') ||
            (nextToolType !== 'workflow' && nextToolType !== 'http')) &&
          latestConfig.executionMode !== 'sync';
        const existingCallbackConfig = latestConfig.callbackConfig as
          | { location?: string }
          | undefined;
        const resetCallbackLocation =
          nextHttpMethod === 'GET' && existingCallbackConfig?.location === 'body';
        const changed =
          Object.keys(merged).length !== Object.keys(current).length ||
          Object.keys(merged).some((k) => !(k in current)) ||
          resetExecutionMode ||
          resetCallbackLocation;
        if (changed) {
          const nextConfig: Record<string, unknown> = {
            ...latestConfig,
            params: merged,
          };
          if (resetExecutionMode) {
            nextConfig.executionMode = 'sync';
            delete nextConfig.callbackConfig;
            delete nextConfig.asyncHttpSuccess;
          } else if (resetCallbackLocation) {
            nextConfig.callbackConfig = { ...existingCallbackConfig, location: 'query' };
          }
          onUpdateRef.current({
            ...nextConfig,
          });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Log so silent fetch failures don't disappear — user still sees
        // the existing params UI unchanged, which is the graceful fallback.
        console.warn('Failed to load tool param schema for prefill', {
          projectId,
          toolId,
          error: err instanceof Error ? err.message : String(err),
        });
        setParamSchema([]);
        setSelectedToolType(null);
        setSelectedWorkflowMode(null);
        setSelectedHttpMethod(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, toolId]);

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  const toolOptions = tools.map((t) => ({ value: t.id, label: t.name }));
  const navigate = useNavigationStore((s) => s.navigate);

  const handleToolSelect = (val: string) => {
    const selected = tools.find((t) => t.id === val);
    setSelectedToolType(null);
    setSelectedWorkflowMode(null);
    setSelectedHttpMethod(null);
    if (selected) {
      // Reset params when switching tools so stale keys from a previous tool
      // don't leak into the new schema. The schema effect will repopulate.
      onUpdate({
        ...config,
        toolId: val,
        toolName: selected.name,
        toolType: selected.toolType ?? null,
        params: {},
        executionMode: 'sync',
        callbackConfig: undefined,
        asyncHttpSuccess: undefined,
      });
    } else {
      update('toolId', val);
    }
  };

  const updateEntry = (oldKey: string, newKey: string, newValue: string) => {
    const updated: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === oldKey) {
        updated[newKey] = newValue;
      } else {
        updated[k] = v;
      }
    }
    update('params', updated);
  };

  const addEntry = () => {
    // Generate a unique placeholder key to avoid overwriting existing entries
    let suffix = 1;
    let tempKey = `param_${suffix}`;
    while (tempKey in params) {
      suffix++;
      tempKey = `param_${suffix}`;
    }
    update('params', { ...params, [tempKey]: '' });
  };

  const removeEntry = (key: string) => {
    const updated = { ...params };
    delete updated[key];
    update('params', updated);
  };

  const updateExecutionMode = (nextMode: ToolNodeExecutionMode) => {
    const nextConfig: Record<string, unknown> = {
      ...config,
      executionMode: nextMode,
    };
    if (nextMode === 'sync') {
      delete nextConfig.callbackConfig;
      delete nextConfig.asyncHttpSuccess;
      onUpdate(nextConfig);
      return;
    }
    if (selectedToolType === 'http') {
      delete nextConfig.asyncHttpSuccess;
      if (nextMode === 'async_wait') {
        nextConfig.callbackConfig = (config.callbackConfig as
          | ToolNodeCallbackConfig
          | undefined) ?? { ...DEFAULT_HTTP_CALLBACK_CONFIG };
      } else {
        delete nextConfig.callbackConfig;
      }
    }
    if (selectedToolType !== 'http') {
      delete nextConfig.callbackConfig;
      delete nextConfig.asyncHttpSuccess;
    }
    onUpdate(nextConfig);
  };

  const toggleOptionalParam = (name: string, enabled: boolean) => {
    const updated = { ...params };
    if (enabled) {
      if (!(name in updated)) updated[name] = '';
    } else {
      delete updated[name];
    }
    update('params', updated);
  };

  useEffect(() => {
    setHighlightedIdx(0);
  }, [optionalQuery, optionalOpen]);

  useEffect(() => {
    if (!optionalOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (typeaheadRef.current && !typeaheadRef.current.contains(e.target as Node)) {
        setOptionalOpen(false);
        setOptionalQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [optionalOpen]);

  const acceptOptionalSuggestion = (name: string) => {
    toggleOptionalParam(name, true);
    setOptionalQuery('');
    setOptionalOpen(false);
  };

  const handleTypeaheadKeydown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOptionalOpen(false);
      setOptionalQuery('');
      return;
    }
    if (filteredSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.min(i + 1, filteredSuggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filteredSuggestions[highlightedIdx];
      if (pick) acceptOptionalSuggestion(pick.name);
    }
  };

  return (
    <div className="space-y-4" data-testid="tool-node-config">
      {loading ? (
        <div className="space-y-1.5" data-testid="tool-select-loading">
          <label className="block text-sm font-medium text-foreground">Tool</label>
          <div className="flex flex-col items-center justify-center h-20 gap-2 rounded-md border border-default bg-background-subtle">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
            <span className="text-xs text-muted">Loading tools...</span>
          </div>
        </div>
      ) : tools.length === 0 ? (
        <div className="space-y-1.5" data-testid="tool-empty-state">
          <label className="block text-sm font-medium text-foreground">Tool</label>
          <p className="text-xs text-foreground-muted">No tools available in this project.</p>
          <button
            type="button"
            data-testid="tool-create-link"
            onClick={() => navigate(`/projects/${projectId}/tools`)}
            className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Create a tool
          </button>
        </div>
      ) : (
        <Select
          label="Tool"
          id="tool-select"
          options={toolOptions}
          value={toolId || undefined}
          onChange={handleToolSelect}
          placeholder="Select Tool"
        />
      )}
      {/*
        Tool-dependent config (Parameters, Timeout, Execution) is hidden until
        the user picks a tool. Without `toolId`, none of these fields are
        meaningful — there's no schema to validate Parameters against, no
        timeout to apply, and no execution mode to choose. The On Failure
        section lives at the ConfigPanel level and is intentionally shown
        regardless so the user can wire failure handling up front.
      */}
      {toolId && (
        <>
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
              Parameters
            </h4>
            {entries.map(([key, value], index) => {
              const isSchemaParam = schemaKeys.has(key);
              const isRequired = requiredSet.has(key);
              return (
                <div
                  key={index}
                  className="flex items-center gap-2"
                  data-testid={`tool-param-row-${index}`}
                >
                  <div className="flex-1">
                    <Input
                      value={key}
                      onChange={(e) => updateEntry(key, e.target.value, value)}
                      placeholder="Key"
                      disabled={isSchemaParam}
                    />
                  </div>
                  <div className="flex-1">
                    <ExpressionInput
                      value={value}
                      onChange={(v) => updateEntry(key, key, v)}
                      placeholder={
                        isRequired
                          ? 'Required — value or {{expression}}'
                          : 'Value or {{expression}}'
                      }
                      triggers={triggers}
                      previousSteps={previousSteps}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeEntry(key)}
                    disabled={isRequired}
                    className="p-1 text-foreground-muted hover:text-error transition-colors disabled:opacity-30 disabled:hover:text-foreground-muted disabled:cursor-not-allowed"
                    data-testid={`tool-param-remove-${index}`}
                    title={isRequired ? 'Required parameter cannot be removed' : 'Remove'}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
            {availableOptional.length > 0 && (
              <div className="relative pt-1" ref={typeaheadRef}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
                  <input
                    type="text"
                    value={optionalQuery}
                    onFocus={() => setOptionalOpen(true)}
                    onChange={(e) => {
                      setOptionalQuery(e.target.value);
                      setOptionalOpen(true);
                    }}
                    onKeyDown={handleTypeaheadKeydown}
                    placeholder={`Add optional parameter (${availableOptional.length} available)...`}
                    className="w-full rounded-lg border border-default bg-background-subtle text-sm py-2 pl-9 pr-3 text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    data-testid="tool-optional-params-typeahead"
                  />
                </div>
                {optionalOpen && (
                  <div className="absolute z-20 mt-1 w-full rounded-xl border border-default bg-background-elevated shadow-xl max-h-48 overflow-y-auto py-1">
                    {filteredSuggestions.length > 0 ? (
                      filteredSuggestions.map((p, idx) => (
                        <button
                          key={p.name}
                          type="button"
                          onMouseEnter={() => setHighlightedIdx(idx)}
                          onClick={() => acceptOptionalSuggestion(p.name)}
                          className={clsx(
                            'w-full text-left px-3 py-1.5 text-sm transition-default',
                            idx === highlightedIdx
                              ? 'bg-background-muted text-foreground'
                              : 'text-foreground-muted hover:bg-background-muted hover:text-foreground',
                          )}
                          data-testid={`tool-optional-suggestion-${p.name}`}
                        >
                          {p.name}
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-2 text-xs text-muted">
                        No matching optional parameters
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={addEntry}
              data-testid="tool-add-param"
              className="flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add parameter
            </button>
          </div>
          <Input
            label="Timeout (seconds)"
            type="number"
            min={5}
            max={300}
            value={timeout}
            onChange={(e) => update('timeout', parseInt(e.target.value, 10) || 30)}
          />
        </>
      )}
      {selectedToolType === 'http' && (
        <>
          <Select
            label="Execution"
            value={normalizedHttpExecutionMode}
            onChange={(val) => updateExecutionMode(val as ToolNodeExecutionMode)}
            options={[
              { value: 'sync', label: 'sync' },
              { value: 'async_wait', label: 'async_wait' },
            ]}
          />
          {executionMode === 'async_wait' && (
            <>
              <Select
                label="Callback Location"
                value={callbackConfig.location}
                onChange={(val) =>
                  update('callbackConfig', {
                    ...callbackConfig,
                    location: val as ToolNodeCallbackLocation,
                  })
                }
                options={[
                  ...(selectedHttpMethod !== 'GET' ? [{ value: 'body', label: 'body' }] : []),
                  { value: 'query', label: 'query' },
                  { value: 'header', label: 'header' },
                ]}
              />
              <Input
                label="Callback URL Key"
                value={callbackConfig.callbackUrlKey}
                onChange={(e) =>
                  update('callbackConfig', {
                    ...callbackConfig,
                    callbackUrlKey: e.target.value,
                  })
                }
                onBlur={(e) => {
                  if (e.target.value.trim().length === 0) {
                    update('callbackConfig', {
                      ...callbackConfig,
                      callbackUrlKey: DEFAULT_HTTP_CALLBACK_URL_KEY,
                    });
                  }
                }}
                placeholder={`Default: ${DEFAULT_HTTP_CALLBACK_URL_KEY}`}
              />
              <Input
                label="Callback Secret Key"
                value={callbackConfig.callbackSecretKey}
                onChange={(e) =>
                  update('callbackConfig', {
                    ...callbackConfig,
                    callbackSecretKey: e.target.value,
                  })
                }
                onBlur={(e) => {
                  if (e.target.value.trim().length === 0) {
                    update('callbackConfig', {
                      ...callbackConfig,
                      callbackSecretKey: DEFAULT_HTTP_CALLBACK_SECRET_KEY,
                    });
                  }
                }}
                placeholder={`Default: ${DEFAULT_HTTP_CALLBACK_SECRET_KEY}`}
              />
              <p className="text-xs text-subtle">
                Blank keys default to <code>{DEFAULT_HTTP_CALLBACK_URL_KEY}</code> and{' '}
                <code>{DEFAULT_HTTP_CALLBACK_SECRET_KEY}</code>.
              </p>
            </>
          )}
        </>
      )}
      {selectedToolType === 'workflow' && selectedWorkflowMode === 'async' && (
        <>
          <Select
            label="Completion"
            value={executionMode === 'async_wait' ? 'async_wait' : 'async_continue'}
            onChange={(val) => updateExecutionMode(val as ToolNodeExecutionMode)}
            options={[
              { value: 'async_continue', label: 'async_continue' },
              { value: 'async_wait', label: 'async_wait' },
            ]}
          />
          <p className="text-xs text-subtle">
            Wait mode is available only for async workflow tools and suspends the parent workflow
            until the child workflow calls back with its final result.
          </p>
        </>
      )}
    </div>
  );
}

function TextToImageConfig({
  config,
  onUpdate,
}: {
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  const modelId = (config.modelId as string) ?? '';
  const prompt = (config.prompt as string) ?? '';
  const negativePrompt = (config.negativePrompt as string) ?? '';
  const numImages = (config.numImages as number) ?? 1;

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  return (
    <div className="space-y-4">
      <Input
        label="Model ID"
        value={modelId}
        onChange={(e) => update('modelId', e.target.value)}
        placeholder="e.g. dall-e-3"
      />
      <Textarea
        label="Prompt"
        value={prompt}
        onChange={(e) => update('prompt', e.target.value)}
        placeholder="A beautiful landscape..."
        rows={4}
      />
      <Textarea
        label="Negative Prompt"
        value={negativePrompt}
        onChange={(e) => update('negativePrompt', e.target.value)}
        placeholder="Optional"
        rows={2}
      />
      <Input
        label="Number of Images"
        type="number"
        min={1}
        max={4}
        value={numImages}
        onChange={(e) => update('numImages', parseInt(e.target.value, 10) || 1)}
      />
    </div>
  );
}

function AudioToTextConfig({
  config,
  onUpdate,
}: {
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  const modelId = (config.modelId as string) ?? '';
  const audioSource = (config.audioSource as string) ?? '';
  const language = (config.language as string) ?? '';
  const { triggers, previousSteps } = useNodeExpressionContext();

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  return (
    <div className="space-y-4">
      <Input
        label="Model ID"
        value={modelId}
        onChange={(e) => update('modelId', e.target.value)}
        placeholder="e.g. whisper-1"
      />
      <ExpressionInput
        label="Audio Source"
        value={audioSource}
        onChange={(v) => update('audioSource', v)}
        placeholder="{{context.trigger.payload.audioUrl}}"
        triggers={triggers}
        previousSteps={previousSteps}
      />
      <Input
        label="Language"
        value={language}
        onChange={(e) => update('language', e.target.value)}
        placeholder="e.g. en"
      />
    </div>
  );
}

function ImageToTextConfig({
  config,
  onUpdate,
}: {
  config: Record<string, unknown>;
  onUpdate: (config: Record<string, unknown>) => void;
}) {
  const modelId = (config.modelId as string) ?? '';
  const imageSource = (config.imageSource as string) ?? '';
  const prompt = (config.prompt as string) ?? '';
  const { triggers, previousSteps } = useNodeExpressionContext();

  const update = (field: string, value: unknown) => {
    onUpdate({ ...config, [field]: value });
  };

  return (
    <div className="space-y-4">
      <Input
        label="Model ID"
        value={modelId}
        onChange={(e) => update('modelId', e.target.value)}
        placeholder="e.g. gpt-4o"
      />
      <ExpressionInput
        label="Image Source"
        value={imageSource}
        onChange={(v) => update('imageSource', v)}
        placeholder="{{context.trigger.payload.imageUrl}}"
        triggers={triggers}
        previousSteps={previousSteps}
      />
      <ExpressionInput
        label="Prompt"
        value={prompt}
        onChange={(v) => update('prompt', v)}
        placeholder="Describe this image..."
        multiline
        rows={3}
        triggers={triggers}
        previousSteps={previousSteps}
      />
    </div>
  );
}

function StubConfig() {
  return (
    <div className="p-4 text-center">
      <p className="text-sm text-foreground-muted">
        This node type is not yet available. Coming soon.
      </p>
    </div>
  );
}

export function GenericNodeConfig({ nodeType, nodeId, config, onUpdate }: GenericNodeConfigProps) {
  // Wrap onUpdate in useCallback to stabilize reference for sub-components
  const handleUpdate = useCallback(
    (newConfig: Record<string, unknown>) => {
      onUpdate(newConfig);
    },
    [onUpdate],
  );

  const renderContent = () => {
    if (STUB_NODE_TYPES.includes(nodeType)) {
      return <StubConfig />;
    }

    switch (nodeType) {
      case 'delay':
        return <DelayConfig config={config} onUpdate={handleUpdate} />;
      case 'agentic_app':
        return <AgenticAppConfig nodeId={nodeId} config={config} onUpdate={handleUpdate} />;
      case 'agent':
        return <AgentNodeConfig nodeId={nodeId} config={config} onUpdate={handleUpdate} />;
      case 'tool':
        return <ToolNodeConfig nodeId={nodeId} config={config} onUpdate={handleUpdate} />;
      case 'integration':
        return <IntegrationNodeConfig nodeId={nodeId} config={config} onUpdate={handleUpdate} />;
      case 'text_to_image':
        return <TextToImageConfig config={config} onUpdate={handleUpdate} />;
      case 'audio_to_text':
        return <AudioToTextConfig config={config} onUpdate={handleUpdate} />;
      case 'image_to_text':
        return <ImageToTextConfig config={config} onUpdate={handleUpdate} />;
      default:
        return (
          <div className="p-4 text-center">
            <p className="text-sm text-foreground-muted">
              No configuration available for this node type.
            </p>
          </div>
        );
    }
  };

  return <div data-testid="generic-config">{renderContent()}</div>;
}
