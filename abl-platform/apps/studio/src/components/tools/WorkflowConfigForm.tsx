/**
 * WorkflowConfigForm Component
 *
 * Interactive configuration form for workflow tool type:
 * - Searchable workflow picker (all non-archived workflows shown)
 * - Version picker (separate dropdown) — defaults to the active version and
 *   lets the user pick any published version
 * - Webhook trigger picker — filtered to triggers pinned to the selected
 *   version (or unpinned/global webhook triggers on this workflow).
 *   If no webhook triggers exist, shows an inline "Create webhook trigger"
 *   action that creates a default sync webhook trigger and auto-selects it.
 * - Mode selector (sync/async) pre-filled from trigger
 * - Readonly preview of input parameters (derived from the selected version's
 *   start-node inputVariables — not the container's "live" definition)
 * - Timeout input (sync mode only)
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Workflow, PlusCircle } from 'lucide-react';
import { Select } from '../ui/Select';
import { Input } from '../ui/Input';
import { InfoCard } from '../ui/InfoCard';
import { useProjectStore } from '../../store/project-store';
import { compareSemverDescLocal } from '../../lib/semver-compare';
import {
  listWorkflows,
  listWorkflowTriggers,
  createWorkflowTrigger,
  listVersions,
  getVersion,
} from '../../api/workflows';
import type {
  WorkflowSummary,
  WorkflowTrigger,
  WorkflowVersionSummary,
  WorkflowVersionDetail,
} from '../../api/workflows';
import type { WorkflowConfig, ParameterDefinition, ParamType } from './shared-types';

export type { WorkflowConfig } from './shared-types';

interface WorkflowConfigFormProps {
  config: WorkflowConfig;
  onChange: (config: WorkflowConfig) => void;
  readOnly?: boolean;
  /**
   * When true, the form persists the concrete version it auto-selects while
   * loading the chosen workflow. Used by the create dialog so the saved
   * binding matches the version-specific triggers and params shown in the UI.
   */
  persistAutoSelectedVersion?: boolean;
}

/** Input variable definition from workflow start node config */
interface InputVariable {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  /** StartNodeConfigSchema calls this `defaultValue`, but older docs may use `default` */
  defaultValue?: unknown;
  default?: unknown;
}

/**
 * Sentinel value for the "Pin to current active at bind time" option in the
 * version picker. Not a real version ID — when selected, the form resolves
 * the current highest-semver active version and persists THAT specific semver.
 */
const SNAP_ACTIVE_SENTINEL = '__snap_active__';
const CONFIG_RUNTIME_NUMERIC_TEMPLATE = /^\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;

export function WorkflowConfigForm({
  config,
  onChange,
  readOnly,
  persistAutoSelectedVersion = false,
}: WorkflowConfigFormProps) {
  const t = useTranslations('tools.config.workflow');
  const { currentProject } = useProjectStore();
  const projectId = currentProject?.id;

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);

  // Versions for the selected workflow (fetched on workflow change).
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  // UI selection state used to filter triggers and fetch the selected
  // version's start-node inputs. Create flows can optionally persist the
  // auto-selected version into `config.workflowVersion`.
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const allowAutoPersistRef = useRef(persistAutoSelectedVersion);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Selected version detail (contains the `definition.nodes` we read
  // `start.inputVariables` from — these drive the tool parameters).
  const [versionDetail, setVersionDetail] = useState<WorkflowVersionDetail | null>(null);
  const [loadingVersionDetail, setLoadingVersionDetail] = useState(false);

  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [loadingTriggers, setLoadingTriggers] = useState(false);
  const [creatingTrigger, setCreatingTrigger] = useState(false);
  const [createTriggerError, setCreateTriggerError] = useState<string | null>(null);

  // Fetch all workflows on mount (ref guards against StrictMode double-fetch).
  // All workflows are shown regardless of whether they have webhook triggers —
  // trigger creation is offered inline when none exist.
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (!projectId || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoadingWorkflows(true);

    listWorkflows(projectId)
      .then(setWorkflows)
      .catch(() => setWorkflows([]))
      .finally(() => setLoadingWorkflows(false));
  }, [projectId]);

  // When workflow changes: fetch its versions + trigger registrations in
  // parallel. Default the version picker to the active version (falling back
  // to most-recently-published, then first-known) so the form is usable
  // without a manual pick.
  useEffect(() => {
    if (!projectId || !config.workflowId) {
      setVersions([]);
      setSelectedVersionId('');
      setTriggers([]);
      return;
    }
    let cancelled = false;
    setLoadingVersions(true);
    setLoadingTriggers(true);

    Promise.all([
      listVersions(projectId, config.workflowId),
      listWorkflowTriggers(projectId, config.workflowId),
    ])
      .then(([vs, trs]) => {
        if (cancelled) return;
        // Only expose ACTIVE versions as binding targets. Per the versioning
        // spec (see docs/specs/workflow-versioning.hld.md), the draft
        // (`version === 'draft'`) is ALWAYS active — it's the working copy.
        // Older draft docs may have `state` missing (schema has no default),
        // so we special-case draft to guarantee it appears.
        const activeVersions = vs.filter((v) => v.version === 'draft' || v.state === 'active');
        setVersions(activeVersions);
        setTriggers(trs);
        const pinnedVersion = config.workflowVersion
          ? activeVersions.find((v) => v.version === config.workflowVersion)
          : undefined;
        const currentSelection = selectedVersionId
          ? activeVersions.find((v) => v.id === selectedVersionId)
          : undefined;
        const defaultVersion =
          activeVersions.find((v) => v.version !== 'draft') ?? activeVersions[0];
        const nextSelectedVersion = pinnedVersion ?? currentSelection ?? defaultVersion;

        setSelectedVersionId(nextSelectedVersion?.id ?? '');

        if (
          persistAutoSelectedVersion &&
          allowAutoPersistRef.current &&
          !config.workflowVersion &&
          defaultVersion
        ) {
          allowAutoPersistRef.current = false;
          onChangeRef.current({
            ...config,
            workflowVersion: defaultVersion.version,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setVersions([]);
        setTriggers([]);
        setSelectedVersionId('');
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingVersions(false);
          setLoadingTriggers(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, config.workflowId, config.workflowVersion, persistAutoSelectedVersion]);

  // Fetch version detail when version selection changes. The start-node
  // `inputVariables` live on the version's definition, not on the container,
  // so we MUST re-fetch when the user picks a different version.
  useEffect(() => {
    if (!projectId || !config.workflowId || !selectedVersionId) {
      setVersionDetail(null);
      setLoadingVersionDetail(false);
      return;
    }
    const version = versions.find((v) => v.id === selectedVersionId);
    if (!version) {
      setVersionDetail(null);
      setLoadingVersionDetail(false);
      return;
    }

    let cancelled = false;
    setLoadingVersionDetail(true);
    getVersion(projectId, config.workflowId, version.version)
      .then((detail) => {
        if (!cancelled) setVersionDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setVersionDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingVersionDetail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, config.workflowId, selectedVersionId, versions]);

  // Filter triggers to webhooks that apply to the selected version — either
  // pinned via `workflowVersionId` or unpinned/global (apply to all versions).
  const webhookTriggers = useMemo(
    () =>
      triggers.filter(
        (tr) =>
          tr.triggerType === 'webhook' &&
          tr.status !== 'deleted' &&
          (!tr.workflowVersionId || tr.workflowVersionId === selectedVersionId),
      ),
    [triggers, selectedVersionId],
  );

  // Extract input variables from the SELECTED version's start node.
  // (1) Per-trigger override on the webhook trigger config takes priority.
  // (2) Otherwise, use the selected version's start node `inputVariables`.
  const inputVariables = useMemo<InputVariable[]>(() => {
    const trigger = webhookTriggers.find((tr) => tr.id === config.triggerId);
    const triggerConfig = trigger?.config as { inputVariables?: InputVariable[] } | undefined;
    if (triggerConfig?.inputVariables && triggerConfig.inputVariables.length > 0) {
      return triggerConfig.inputVariables;
    }

    if (!versionDetail) return [];
    const startNode = versionDetail.definition?.nodes?.find((n) => n.nodeType === 'start');
    const startConfig = startNode?.config as { inputVariables?: InputVariable[] } | undefined;
    if (startConfig?.inputVariables && startConfig.inputVariables.length > 0) {
      return startConfig.inputVariables;
    }

    return [];
  }, [versionDetail, webhookTriggers, config.triggerId]);

  // Sync derived `parameters` onto the config so the create dialog can
  // forward them to the backend. Mapping: StartNodeConfigSchema types → ParamType
  //   'string'|'number'|'boolean' → same; 'json' → 'object'
  // Description is required by the backend schema (min 1) but optional on
  // StartNodeConfigSchema.inputVariables — fall back to a synthesized label.
  const derivedParameters = useMemo<ParameterDefinition[]>(() => {
    return inputVariables.map((v) => {
      const paramType: ParamType = v.type === 'json' ? 'object' : (v.type as ParamType);
      const rawDefault = v.defaultValue ?? v.default;
      return {
        name: v.name,
        type: paramType,
        description:
          v.description && v.description.trim().length > 0
            ? v.description
            : `Workflow input '${v.name}'`,
        required: v.required,
        ...(rawDefault !== undefined ? { defaultValue: String(rawDefault) } : {}),
      };
    });
  }, [inputVariables]);

  const lastSyncedParamsRef = useRef<string>('');
  useEffect(() => {
    const serialized = JSON.stringify(derivedParameters);
    if (serialized === lastSyncedParamsRef.current) return;
    lastSyncedParamsRef.current = serialized;
    onChange({ ...config, parameters: derivedParameters });
    // Intentionally omit `config`/`onChange` from deps — only sync when the
    // derived params actually change. Including `config` causes an infinite
    // loop because we set back onto it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedParameters]);

  // Workflow options (version no longer appears in the label — it's a
  // separate dropdown now).
  const workflowOptions = useMemo(
    () => [
      { value: '', label: t('pickWorkflow_placeholder') },
      ...workflows.map((w) => ({ value: w.id, label: w.name })),
    ],
    [workflows, t],
  );

  /**
   * The current highest-semver active published version (excluding draft).
   * Powers the "Pin to current active at bind time" option's label and
   * the snap-resolution when that option is selected.
   *
   * Matches runtime/engine default-resolution semantics — see
   * workflow-version-service.ts `resolveDefaultVersion()`.
   */
  const highestActivePublished = useMemo<WorkflowVersionSummary | null>(() => {
    const published = versions.filter((v) => v.state === 'active' && v.version !== 'draft');
    if (published.length === 0) return null;
    published.sort((a, b) => compareSemverDescLocal(a.version, b.version));
    return published[0] ?? null;
  }, [versions]);

  // Version options — only active versions reach here (filtered upstream).
  // Draft versions are labeled "Draft" explicitly; published versions already
  // carry a `v` prefix in their stored name (e.g. `v1.0.0`) so we render the
  // raw `version` string.
  //
  // The "snap to current active" option is added as a synthetic entry between
  // the auto-resolve placeholder and the specific-version entries. It resolves
  // the CURRENT highest-semver active; once the binding is saved, the selected
  // semver is frozen — unlike auto-resolve, bound agents do NOT pick up newer
  // versions automatically. Omitted when no active published version exists
  // (e.g. draft-only workflow).
  const versionOptions = useMemo(() => {
    const options = [{ value: '', label: t('pickVersion_placeholder') }];
    if (highestActivePublished) {
      options.push({
        value: SNAP_ACTIVE_SENTINEL,
        label: t('version_snap_active_label', { version: highestActivePublished.version }),
      });
    }
    options.push(
      ...versions.map((v) => ({
        value: v.id,
        label: v.version === 'draft' ? t('version_draft_label') : v.version,
      })),
    );
    return options;
  }, [versions, t, highestActivePublished]);

  // Trigger options
  const triggerOptions = useMemo(
    () => [
      { value: '', label: t('pickTrigger_placeholder') },
      ...webhookTriggers.map((tr) => ({
        value: tr.id,
        label: `${tr.triggerType} — ${tr.id.slice(0, 8)}`,
      })),
    ],
    [webhookTriggers, t],
  );

  const modeOptions = useMemo(
    () => [
      { value: 'sync', label: t('mode_sync') },
      { value: 'async', label: t('mode_async') },
    ],
    [t],
  );

  const handleWorkflowChange = useCallback(
    (workflowId: string) => {
      allowAutoPersistRef.current = persistAutoSelectedVersion;
      // Reset version, trigger, and mode when workflow changes
      setSelectedVersionId('');
      onChange({
        ...config,
        workflowId,
        workflowVersion: undefined,
        triggerId: '',
        mode: 'sync',
        timeoutMs: undefined,
      });
    },
    [config, onChange, persistAutoSelectedVersion],
  );

  const handleVersionChange = useCallback(
    (pickerValue: string) => {
      // Three cases:
      //   1. Empty → auto-resolve at every call (omit workflowVersion from DSL)
      //   2. __snap_active__ → freeze the CURRENT highest-semver active. Persist
      //      that specific semver so the binding won't silently upgrade when a
      //      new version publishes. UI state tracks the resolved version ID so
      //      the parameters preview can fetch it.
      //   3. Specific version ID → pin to that version's semver forever.
      allowAutoPersistRef.current = false;
      let workflowVersion: string | undefined;
      let resolvedVersionId = pickerValue;

      if (pickerValue === SNAP_ACTIVE_SENTINEL) {
        // No-op if no active published version exists (should be blocked by
        // the disabled option, but belt-and-suspenders).
        if (!highestActivePublished) return;
        workflowVersion = highestActivePublished.version;
        resolvedVersionId = highestActivePublished.id;
      } else if (pickerValue !== '') {
        const selectedVersion = versions.find((v) => v.id === pickerValue);
        workflowVersion = selectedVersion?.version;
      }

      setSelectedVersionId(resolvedVersionId);

      // Clear trigger since it may be pinned to a different version
      onChange({
        ...config,
        triggerId: '',
        mode: 'sync',
        timeoutMs: undefined,
        workflowVersion,
      });
    },
    [config, onChange, versions, highestActivePublished],
  );

  const handleTriggerChange = useCallback(
    (triggerId: string) => {
      // Pre-fill mode from trigger config if available
      const trigger = webhookTriggers.find((tr) => tr.id === triggerId);
      const triggerConfig = trigger?.config as { mode?: 'sync' | 'async' } | undefined;
      const mode = triggerConfig?.mode ?? config.mode ?? 'sync';
      onChange({ ...config, triggerId, mode });
    },
    [config, onChange, webhookTriggers],
  );

  const handleModeChange = useCallback(
    (mode: string) => {
      const nextMode = mode as 'sync' | 'async';
      onChange({
        ...config,
        mode: nextMode,
        // Clear timeout when switching to async
        timeoutMs: nextMode === 'async' ? undefined : config.timeoutMs,
      });
    },
    [config, onChange],
  );

  const handleTimeoutChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.trim();
      if (!raw) {
        onChange({ ...config, timeoutMs: undefined });
        return;
      }

      if (CONFIG_RUNTIME_NUMERIC_TEMPLATE.test(raw)) {
        onChange({ ...config, timeoutMs: raw as NonNullable<WorkflowConfig['timeoutMs']> });
        return;
      }

      const num = parseInt(raw, 10);
      onChange({ ...config, timeoutMs: Number.isNaN(num) ? undefined : num });
    },
    [config, onChange],
  );

  const handleCreateWebhookTrigger = useCallback(async () => {
    if (!projectId || !config.workflowId) return;
    setCreatingTrigger(true);
    setCreateTriggerError(null);
    try {
      await createWorkflowTrigger(projectId, {
        workflowId: config.workflowId,
        triggerType: 'webhook',
        config: {},
        webhookMode: 'sync',
      });
      // Re-fetch triggers and auto-select the newly created one.
      const refreshed = await listWorkflowTriggers(projectId, config.workflowId);
      setTriggers(refreshed);
      const newTrigger = refreshed
        .filter(
          (tr) =>
            tr.triggerType === 'webhook' &&
            tr.status !== 'deleted' &&
            (!tr.workflowVersionId || tr.workflowVersionId === selectedVersionId),
        )
        .at(-1);
      if (newTrigger) {
        const triggerConfig = newTrigger.config as { mode?: 'sync' | 'async' } | undefined;
        const mode = triggerConfig?.mode ?? 'sync';
        onChange({ ...config, triggerId: newTrigger.id, mode });
      }
    } catch {
      setCreateTriggerError(t('createWebhookTriggerError'));
    } finally {
      setCreatingTrigger(false);
    }
  }, [projectId, config, selectedVersionId, onChange, t]);

  if (loadingWorkflows) {
    return (
      <div className="rounded-lg border border-default bg-background-subtle p-4">
        <div className="flex items-center gap-2">
          <Workflow className="w-4 h-4 text-muted animate-pulse" />
          <span className="text-sm text-muted">{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (workflows.length === 0) {
    return <InfoCard variant="warning" message={t('noActiveWorkflows')} size="sm" />;
  }

  const showVersionLoading = Boolean(config.workflowId) && loadingVersions;
  const showNoVersions = Boolean(config.workflowId) && !loadingVersions && versions.length === 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Workflow className="w-4 h-4 text-muted" />
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
      </div>
      <p className="text-xs text-muted">{t('description')}</p>

      {/* Workflow Picker */}
      <Select
        label={t('pickWorkflow')}
        options={workflowOptions}
        value={config.workflowId ?? ''}
        onChange={handleWorkflowChange}
        disabled={readOnly}
        id="workflow-picker"
        testid="workflow-picker-select"
      />

      {/* Version Picker — shown when a workflow is selected */}
      {config.workflowId && (
        <>
          {showVersionLoading ? (
            <p className="text-xs text-muted">{t('pickVersion_loading')}</p>
          ) : showNoVersions ? (
            <InfoCard variant="warning" message={t('pickVersion_empty')} size="sm" />
          ) : (
            <>
              <Select
                label={t('pickVersion')}
                options={versionOptions}
                value={selectedVersionId}
                onChange={handleVersionChange}
                disabled={readOnly}
                id="version-picker"
                testid="version-picker-select"
              />
              {/* Explanatory hint — clarifies auto-resolve vs snap-at-bind vs pin */}
              <p className="text-xs text-muted -mt-2" data-testid="workflow-version-hint">
                {config.workflowVersion
                  ? t('version_hint_pin', { version: config.workflowVersion })
                  : t('version_hint_auto')}
              </p>
            </>
          )}
        </>
      )}

      {/* Trigger Picker — shown when a version is selected */}
      {config.workflowId && selectedVersionId && !loadingTriggers && !loadingVersionDetail && (
        <>
          {webhookTriggers.length === 0 ? (
            <div data-testid="no-webhook-triggers-empty-state" className="space-y-2">
              <InfoCard variant="warning" message={t('noWebhookTriggers')} size="sm" />
              {!readOnly && (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={handleCreateWebhookTrigger}
                    disabled={creatingTrigger}
                    data-testid="create-webhook-trigger-btn"
                    className="flex items-center gap-1.5 text-sm text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed w-fit"
                  >
                    <PlusCircle className="w-4 h-4" />
                    {creatingTrigger ? t('creatingWebhookTrigger') : t('createWebhookTrigger')}
                  </button>
                  {createTriggerError && <p className="text-xs text-error">{createTriggerError}</p>}
                </div>
              )}
            </div>
          ) : (
            <Select
              label={t('pickTrigger')}
              options={triggerOptions}
              value={config.triggerId ?? ''}
              onChange={handleTriggerChange}
              disabled={readOnly}
              id="trigger-picker"
              testid="trigger-picker-select"
            />
          )}
        </>
      )}

      {/* Mode Selector — shown when a trigger is selected */}
      {config.triggerId && (
        <Select
          label={t('mode')}
          options={modeOptions}
          value={config.mode ?? 'sync'}
          onChange={handleModeChange}
          disabled={readOnly}
          id="mode-selector"
          testid="mode-selector"
        />
      )}

      {/* Timeout — only for sync mode */}
      {config.triggerId && config.mode === 'sync' && (
        <div>
          <Input
            label={t('timeout')}
            type="text"
            inputMode="numeric"
            value={config.timeoutMs ?? ''}
            onChange={handleTimeoutChange}
            placeholder="30000 or {{config.WORKFLOW_TIMEOUT_MS}}"
            disabled={readOnly}
          />
          <p className="text-xs text-muted mt-1">{t('timeoutHint')}</p>
        </div>
      )}

      {/* Input Parameters Preview */}
      {config.triggerId && inputVariables.length > 0 && (
        <div data-testid="input-variables-preview">
          <label className="block text-sm font-medium text-foreground mb-2">
            {t('paramsPreview')}
          </label>
          <div className="rounded-lg border border-default bg-background-subtle p-3 space-y-1.5">
            {inputVariables.map((v) => (
              <div key={v.name} className="flex items-center justify-between text-xs">
                <span className="font-mono text-foreground">
                  {v.name}
                  {v.required && <span className="text-error ml-0.5">*</span>}
                </span>
                <span className="text-muted">{v.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {config.triggerId && inputVariables.length === 0 && (
        <p className="text-xs text-muted italic">{t('noParams')}</p>
      )}
    </div>
  );
}

/** Client-side validation for workflow config — returns field-level errors */
export function validateWorkflowConfig(config: WorkflowConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!config.workflowId) errors.workflowId = 'Workflow is required';
  if (!config.triggerId) errors.triggerId = 'Trigger is required';
  if (config.mode === 'sync' && config.timeoutMs !== undefined) {
    if (typeof config.timeoutMs === 'string') {
      if (!CONFIG_RUNTIME_NUMERIC_TEMPLATE.test(config.timeoutMs)) {
        errors.timeoutMs = 'Timeout must be a number or {{config.KEY}}';
      }
      return errors;
    }

    if (config.timeoutMs < 1000 || config.timeoutMs > 600000) {
      errors.timeoutMs = 'Timeout must be between 1000 and 600000 ms';
    }
  }
  return errors;
}
