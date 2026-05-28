'use client';

/**
 * WorkflowTriggersTab Component
 *
 * Lists active triggers with type icons (Webhook, Cron, Manual).
 * Each trigger shows type, schedule/URL, and lifecycle actions.
 * Webhook triggers display a copyable URL.
 * Cron triggers show the expression and next run time.
 *
 * Supports inline trigger creation and lifecycle actions via the
 * workflow-engine trigger API (proxied through runtime).
 */

import { useState, useCallback, useEffect, useId, useMemo } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import {
  Plus,
  Webhook,
  Clock,
  Zap,
  Copy,
  Check,
  ToggleLeft,
  ToggleRight,
  X,
  Play,
  Trash2,
  Pencil,
  Key,
  ChevronDown,
  AppWindow,
  Radio,
  Shield,
} from 'lucide-react';
import clsx from 'clsx';
import cronstrue from 'cronstrue';
import { toast } from 'sonner';
import type {
  WorkflowDetail,
  WorkflowTrigger,
  WorkflowTriggerPayload,
} from '../../../api/workflows';
import {
  createWorkflowTrigger,
  pauseWorkflowTrigger,
  resumeWorkflowTrigger,
  fireWorkflowTrigger,
  deleteWorkflowTrigger,
  updateWorkflowTrigger,
} from '../../../api/workflows';
import { apiFetch, handleResponse } from '../../../lib/api-client';
import { sanitizeError } from '../../../lib/sanitize-error';
import { useNavigationStore } from '../../../store/navigation-store';
import { useAuthProfiles } from '../../../hooks/useAuthProfiles';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { WebhookKeyCreationModal } from '../triggers/WebhookKeyCreationModal';
import { ConnectorLogo } from '../../connections/ConnectorLogo';
import { WebhookQuickStart } from '../triggers/WebhookQuickStart';
import { SchedulePresetPicker, type PresetConfig } from '../triggers/SchedulePresetPicker';
import { AppTriggerPicker, type AppTriggerSelection } from '../triggers/AppTriggerPicker';
import { FireTriggerModal } from '../triggers/FireTriggerModal';

// =============================================================================
// CONNECTOR TRIGGER PARAMS VIEW
// =============================================================================

type ConnectorMeta = {
  name: string;
  displayName: string;
  triggers: Array<{
    name: string;
    displayName: string;
    props?: Array<{ name: string; displayName: string; description?: string }>;
  }>;
};
/** Format a raw saved param value for display — unwrap JSON objects to a readable string. */
function formatParamValue(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.values(parsed).filter(Boolean).join(' / ');
    }
    return String(parsed);
  } catch {
    return raw;
  }
}

/** Read-only display of connector identity, auth profile, and configured params. */
function ConnectorTriggerParamsView({
  projectId,
  connectorName,
  triggerName,
  connectionId,
  triggerParams,
}: {
  projectId: string;
  connectorName: string;
  triggerName: string;
  /** Auth-profile id (IR field name kept for backward-compat). */
  connectionId: string;
  triggerParams: Record<string, string>;
}) {
  // Same SWR key as AppTriggerPicker — served from cache when the creation form was open.
  const connectorsFetcher = async (url: string) => {
    const res = await apiFetch(url);
    return handleResponse(res) as Promise<{ success: boolean; data: ConnectorMeta[] }>;
  };
  const { data: connectorsData } = useSWR(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/connectors` : null,
    connectorsFetcher,
  );

  // ABLP-913: connectionId now references an AuthProfile. Resolve via the
  // auth-profiles list (status-unfiltered so revoked/expired still render).
  const { profiles } = useAuthProfiles(connectionId ? projectId : null, {
    connector: connectorName || undefined,
    limit: 200,
  });

  const connector = useMemo(
    () => connectorsData?.data?.find((c) => c.name === connectorName),
    [connectorsData, connectorName],
  );
  const trigger = useMemo(
    () => connector?.triggers?.find((t) => t.name === triggerName),
    [connector, triggerName],
  );
  const authProfile = useMemo(
    () => profiles.find((p) => p.id === connectionId),
    [profiles, connectionId],
  );

  const paramEntries = useMemo(() => {
    if (!trigger?.props) return [];
    return trigger.props
      .filter((p) => triggerParams[p.name] !== undefined && triggerParams[p.name] !== '')
      .map((p) => ({
        label: p.displayName,
        description: p.description,
        value: triggerParams[p.name],
      }));
  }, [trigger, triggerParams]);

  return (
    <div className="space-y-4 select-none">
      {/* Connector + trigger identity */}
      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-accent/5 border border-accent/20">
        <ConnectorLogo name={connectorName} className="h-7 w-7" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {connector?.displayName ?? connectorName}
          </p>
          <p className="text-xs text-accent">{trigger?.displayName ?? triggerName}</p>
        </div>
      </div>

      {/* Auth Profile (ABLP-913: replaces legacy connection display) */}
      {(authProfile ?? connectionId) && (
        <div>
          <p className="text-xs font-medium text-muted mb-1.5">Auth Profile</p>
          <div className="flex items-center gap-3 rounded-lg border border-default bg-background-muted p-3">
            <Shield className="w-4 h-4 text-muted shrink-0" />
            <p className="text-sm font-medium text-foreground flex-1 truncate">
              {authProfile?.name ?? connectionId}
            </p>
            {authProfile?.status && (
              <Badge variant={authProfile.status === 'active' ? 'success' : 'default'}>
                {authProfile.status}
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* Configured params */}
      {paramEntries.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">Action Inputs</p>
          {paramEntries.map(({ label, description, value }) => (
            <div key={label}>
              <p className="text-xs font-medium text-foreground mb-0.5">{label}</p>
              {description && <p className="text-xs text-muted mb-1">{description}</p>}
              <div className="rounded-md border border-default bg-background-muted px-3 py-2 text-sm text-foreground">
                {formatParamValue(value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Static icon + variant metadata for trigger types. Labels come from i18n at render time. */
const TRIGGER_TYPE_META: Record<
  string,
  { icon: React.ReactNode; variant: 'info' | 'accent' | 'warning' }
> = {
  webhook: { icon: <Webhook className="w-4 h-4" />, variant: 'info' },
  cron: { icon: <Clock className="w-4 h-4" />, variant: 'accent' },
  app: { icon: <AppWindow className="w-4 h-4" />, variant: 'info' },
  // Legacy types — hidden from creation form but displayed for existing triggers
  event: { icon: <Zap className="w-4 h-4" />, variant: 'accent' },
  polling: { icon: <Radio className="w-4 h-4" />, variant: 'warning' },
  connector: { icon: <AppWindow className="w-4 h-4" />, variant: 'info' },
};

type TriggerType = 'webhook' | 'cron' | 'app';

/** Map trigger type to its i18n label key. */
function triggerTypeLabelKey(triggerType: string): string {
  switch (triggerType) {
    case 'webhook':
      return 'type_webhook';
    case 'cron':
      return 'type_cron';
    case 'app':
    case 'connector':
      return 'type_app';
    case 'event':
      return 'type_event';
    case 'polling':
      return 'type_polling';
    default:
      return 'type_generic';
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Human-readable description for a cron expression. Mirrors the preview style
 * used in `SchedulePresetPicker` (AM/PM time format) so creation and display
 * stay consistent. Fast-path map handles the preset-generated patterns,
 * cronstrue covers anything else, and on parse failure we return the raw
 * expression so callers can suppress the parenthesis-rendering.
 */
function formatCronExpression(expression: string): string {
  const patterns: Record<string, string> = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '0 * * * *': 'Every hour',
    '0 0 * * *': 'Daily at midnight',
    '0 9 * * *': 'Daily at 9:00 AM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 0 * * 1': 'Weekly on Monday at midnight',
    '0 0 1 * *': 'Monthly on the 1st at midnight',
  };
  if (patterns[expression]) return patterns[expression];
  try {
    // `verbose: true` appends recurrence qualifiers — e.g. "At 07:24 AM" becomes
    // "At 07:24 AM, every day" — so users immediately know a time-only cron
    // fires every day, not once.
    return cronstrue.toString(expression, { verbose: true });
  } catch {
    return expression;
  }
}

/**
 * Human-readable summary of a preset-based cron config. Used when the server
 * stored the preset form (e.g. `{preset:'monthly', time:'09:00', ...}`) but
 * no resolved `cronExpression` is present in the config (older records or
 * deployments without the scheduler).
 */
function formatCronPreset(config: Record<string, unknown>): string | null {
  const preset = config.preset as string | undefined;
  if (!preset) return null;
  const time = (config.time as string | undefined) ?? '09:00';
  const tz = config.timezone as string | undefined;
  const tzSuffix = tz ? ` (${tz})` : '';
  const dayOfWeekNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  switch (preset) {
    case 'daily':
      return `Daily at ${time}${tzSuffix}`;
    case 'weekly': {
      const dow = config.dayOfWeek as number | undefined;
      const dayLabel = typeof dow === 'number' ? (dayOfWeekNames[dow] ?? 'Monday') : 'Monday';
      return `Weekly on ${dayLabel} at ${time}${tzSuffix}`;
    }
    case 'monthly': {
      const dom = (config.dayOfMonth as number | undefined) ?? 1;
      const suffix = dom === 1 ? 'st' : dom === 2 ? 'nd' : dom === 3 ? 'rd' : 'th';
      return `Monthly on the ${dom}${suffix} at ${time}${tzSuffix}`;
    }
    case 'once': {
      const datetime = config.datetime as string | undefined;
      if (!datetime) return null;
      // Studio stores datetime-local values as wall-clock strings (no offset). Rendering those
      // with `new Date()` would interpret them in the viewer's local timezone, which is wrong.
      // If an explicit offset/Z is present, render as an absolute instant.
      const trimmed = datetime.trim();
      const hasOffsetSuffix = /(Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
      if (hasOffsetSuffix) {
        return `Once at ${new Date(trimmed).toLocaleString('en-US', tz ? { timeZone: tz } : undefined)}${tzSuffix}`;
      }
      return `Once at ${trimmed.replace('T', ' ')}${tzSuffix}`;
    }
    default:
      return null;
  }
}

/** Relative time — "2 hours ago", "just now", etc. */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const ISO_LOCAL_MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DDMMYYYY_COMMA_RE = /^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})$/;
const HAS_OFFSET_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

function toDatetimeLocalInZone(instantMs: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function coerceDatetimeLocal(raw: string, tz: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Already a datetime-local style string; drop seconds if present.
  if (ISO_LOCAL_MINUTE_RE.test(trimmed)) return trimmed.slice(0, 16);

  // Legacy UI bug: "DD/MM/YYYY, HH:MM" (as seen in some stored configs).
  const ddmmyyyy = DDMMYYYY_COMMA_RE.exec(trimmed);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy, hh, min] = ddmmyyyy;
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  }

  // Absolute ISO (Z/offset): convert to wall-clock in the configured timezone so
  // the datetime-local input can render and saving keeps user intent.
  if (HAS_OFFSET_SUFFIX_RE.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return toDatetimeLocalInZone(ms, tz);
  }

  return null;
}

/**
 * Normalize a trigger from the registration API response.
 *
 * NOTE on source-of-truth: There are two places trigger data lives:
 * 1. TriggerRegistration collection (canonical) -- queried by this tab via the
 *    registration API. Contains full lifecycle state (active/paused/error/deleted).
 * 2. Workflow document `triggers[]` array (denormalized summary) -- read by
 *    OverviewTab and StepsTab for quick display. Synced by TriggerEngine on
 *    register/deregister but may drift if direct DB edits occur.
 *
 * This tab uses (1) as the source of truth. The DB model stores `strategy`
 * where the UI type expects `type`, so we map accordingly. Connector triggers
 * include connectorName/triggerName/connectionId in config.
 */
function normalizeTrigger(raw: Record<string, unknown>): WorkflowTrigger {
  const triggerType = (raw.triggerType ??
    raw.type ??
    raw.strategy ??
    'webhook') as WorkflowTrigger['triggerType'];
  const rawConfig = (raw.config ?? {}) as Record<string, unknown>;
  // The engine historically stored the resolved cron expression either inside
  // `config.cronExpression` (current) or as a top-level field on the trigger
  // document (legacy, pre-ABLP cron-config fix). Normalize both shapes into
  // `config.cronExpression` so the UI can rely on a single path.
  const config: Record<string, unknown> = {
    ...rawConfig,
    cronExpression: rawConfig.cronExpression ?? rawConfig.expression ?? raw.cronExpression,
  };
  return {
    id: (raw.id ?? raw._id ?? '') as string,
    triggerType,
    config,
    status: (raw.status ?? 'active') as WorkflowTrigger['status'],
  };
}

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowTriggersTabProps {
  workflow: WorkflowDetail;
  onRefresh?: () => void;
  /** Currently viewed workflow version (e.g. 'v0.2.0', 'draft') */
  viewedVersion?: string;
  /** State of the currently viewed version */
  viewedState?: 'active' | 'inactive' | 'draft';
}

// =============================================================================
// TRIGGER CREATION FORM
// =============================================================================

interface TriggerFormProps {
  projectId: string;
  workflowId: string;
  onCreated: () => void;
  onCancel: () => void;
  onWebhookCreated?: () => void;
}

function TriggerCreationForm({
  projectId,
  workflowId,
  onCreated,
  onCancel,
  onWebhookCreated,
}: TriggerFormProps) {
  const tTriggers = useTranslations('workflows.triggers');
  const triggerTypes = useMemo<{ value: TriggerType; label: string }[]>(
    () => [
      { value: 'webhook', label: tTriggers('type_webhook') },
      { value: 'cron', label: tTriggers('type_cron') },
      { value: 'app', label: tTriggers('type_app_plural') },
    ],
    [tTriggers],
  );
  const [type, setType] = useState<TriggerType>('webhook');
  const [presetConfig, setPresetConfig] = useState<PresetConfig>({
    preset: 'daily',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    time: '09:00',
  });
  const [appSelection, setAppSelection] = useState<AppTriggerSelection>({
    connectorName: '',
    triggerName: '',
    connectionId: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [callbackAccessToken, setCallbackAccessToken] = useState('');
  const [showCallbackConfig, setShowCallbackConfig] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);

    const config: Record<string, unknown> = {};
    // Determine the API trigger type — 'app' maps to 'event' in the narrowed backend enum
    const apiType: WorkflowTriggerPayload['triggerType'] = type === 'app' ? 'event' : type;

    if (type === 'cron') {
      config.preset = presetConfig.preset;
      config.timezone = presetConfig.timezone;
      if (presetConfig.time) config.time = presetConfig.time;
      if (presetConfig.dayOfWeek !== undefined) config.dayOfWeek = presetConfig.dayOfWeek;
      if (presetConfig.dayOfMonth !== undefined) config.dayOfMonth = presetConfig.dayOfMonth;
      if (presetConfig.datetime) config.datetime = presetConfig.datetime;
      if (presetConfig.cronExpression) config.cronExpression = presetConfig.cronExpression;
    } else if (type === 'app') {
      if (!appSelection.connectorName || !appSelection.triggerName || !appSelection.connectionId) {
        setError('Please select an app, trigger event, and auth profile');
        setSaving(false);
        return;
      }
      config.connectorName = appSelection.connectorName;
      config.triggerName = appSelection.triggerName;
      config.connectionId = appSelection.connectionId;
      // Include trigger params if the user configured any
      if (appSelection.triggerParams && Object.keys(appSelection.triggerParams).length > 0) {
        config.triggerParams = appSelection.triggerParams;
      }
    } else if (type === 'webhook') {
      if (callbackUrl.trim()) {
        try {
          new URL(callbackUrl.trim());
        } catch {
          setError('Callback URL must be a valid URL (https://... or http://...)');
          setSaving(false);
          return;
        }
        config.callbackUrl = callbackUrl.trim();
        if (callbackAccessToken.trim()) {
          config.callbackAccessToken = callbackAccessToken.trim();
        }
      }
    }

    try {
      const payload: WorkflowTriggerPayload = {
        workflowId,
        triggerType: apiType,
        config,
      };
      await createWorkflowTrigger(projectId, payload);
      onCreated();
      if (type === 'webhook') {
        onWebhookCreated?.();
      }
    } catch (err) {
      setError(sanitizeError(err, 'Failed to create trigger'));
    } finally {
      setSaving(false);
    }
  }, [
    type,
    presetConfig,
    appSelection,
    projectId,
    workflowId,
    onCreated,
    callbackUrl,
    callbackAccessToken,
    onWebhookCreated,
  ]);

  return (
    <div
      className="rounded-xl border border-accent/30 bg-background-elevated p-4 shadow-sm space-y-4"
      data-testid="trigger-creation-form"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">New Trigger</h3>
        <button
          onClick={onCancel}
          className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default"
          aria-label={tTriggers('type_cancel_aria')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Type selector */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">{tTriggers('type_label')}</label>
        <div className="flex gap-2 flex-wrap">
          {triggerTypes.map((t) => (
            <button
              key={t.value}
              data-testid={`trigger-type-${t.value}`}
              onClick={() => setType(t.value)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg border transition-default',
                type === t.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default bg-background-muted text-muted hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Config fields per type */}
      {type === 'cron' && <SchedulePresetPicker value={presetConfig} onChange={setPresetConfig} />}

      {type === 'app' && (
        <AppTriggerPicker projectId={projectId} value={appSelection} onChange={setAppSelection} />
      )}

      {type === 'webhook' && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            A webhook URL will be generated automatically after creation.
          </p>

          {/* Collapsible async push config */}
          <button
            type="button"
            data-testid="trigger-async-push-toggle"
            onClick={() => setShowCallbackConfig((v) => !v)}
            className={clsx(
              'flex items-center gap-1.5 text-xs font-medium transition-default',
              showCallbackConfig ? 'text-accent' : 'text-muted hover:text-foreground',
            )}
          >
            <ChevronDown
              className={clsx(
                'w-3.5 h-3.5 transition-transform',
                showCallbackConfig && 'rotate-180',
              )}
            />
            Async Push Config (Optional)
          </button>

          {showCallbackConfig && (
            <div className="space-y-3 pl-5 border-l-2 border-accent/20">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted">Callback URL</label>
                <input
                  type="url"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  placeholder="https://your-server.com/callback"
                  aria-label="Callback URL"
                  className={clsx(
                    'w-full px-3 py-2 text-sm rounded-lg border border-default',
                    'bg-background-muted text-foreground placeholder:text-muted',
                    'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted">Access Token</label>
                <input
                  type="password"
                  value={callbackAccessToken}
                  onChange={(e) => setCallbackAccessToken(e.target.value)}
                  placeholder="Optional"
                  aria-label="Callback access token"
                  className={clsx(
                    'w-full px-3 py-2 text-sm rounded-lg border border-default',
                    'bg-background-muted text-foreground placeholder:text-muted',
                    'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
                  )}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && <p className="text-xs text-error">{error}</p>}

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={saving}
          data-testid="trigger-create-btn"
        >
          Create Trigger
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// TRIGGER CARD
// =============================================================================

interface TriggerCardProps {
  trigger: WorkflowTrigger;
  projectId: string;
  workflowId: string;
  workflowName: string;
  onChanged: () => void;
  apiKey?: {
    id: string;
    prefix: string;
    isActive: boolean;
    expiresAt: string | null;
  } | null;
  rawApiKey?: string;
  onRequestKey?: () => void;
  /** Currently viewed workflow version (e.g. 'v0.2.0', 'draft') */
  viewedVersion?: string;
  /** State of the currently viewed version */
  viewedState?: 'active' | 'inactive' | 'draft';
  /**
   * Workflow's declared inputSchema (JSON Schema). Threaded into the curl
   * snippets and Fire Now modal so both surfaces match the author's contract.
   */
  inputSchema?: Record<string, unknown> | null;
}

function TriggerCard({
  trigger,
  projectId,
  workflowId,
  workflowName,
  onChanged,
  apiKey,
  rawApiKey,
  onRequestKey,
  viewedVersion,
  viewedState,
  inputSchema,
}: TriggerCardProps) {
  const tTriggers = useTranslations('workflows.triggers');
  const meta = TRIGGER_TYPE_META[trigger.triggerType];
  const config = {
    label: tTriggers(triggerTypeLabelKey(trigger.triggerType)),
    icon: meta?.icon ?? <Zap className="w-4 h-4" />,
    variant: meta?.variant ?? ('info' as const),
  };
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [firing, setFiring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showFireModal, setShowFireModal] = useState(false);
  const [showEditConfirm, setShowEditConfirm] = useState(false);
  const [pendingEditType, setPendingEditType] = useState<'cron' | 'webhook' | 'app' | null>(null);
  const [editType, setEditType] = useState<'cron' | 'webhook' | 'app' | null>(null);
  const [savingCronEdit, setSavingCronEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cronEditError, setCronEditError] = useState<string | null>(null);
  const [savingWebhookEdit, setSavingWebhookEdit] = useState(false);
  const [webhookEditError, setWebhookEditError] = useState<string | null>(null);
  const [webhookCallbackUrl, setWebhookCallbackUrl] = useState('');
  const [webhookCallbackToken, setWebhookCallbackToken] = useState('');
  const [savingAppEdit, setSavingAppEdit] = useState(false);
  const [appEditError, setAppEditError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Stable IDs so the visible <label> text actually focuses its input on click,
  // and so the error <p> can be referenced via aria-describedby for screen readers.
  const webhookCallbackUrlId = useId();
  const webhookCallbackTokenId = useId();
  const webhookErrorId = useId();

  const webhookUrl =
    trigger.triggerType === 'webhook' ? ((trigger.config.url as string | undefined) ?? '') : '';

  const cronExpression =
    trigger.triggerType === 'cron'
      ? ((trigger.config.cronExpression as string | undefined) ?? '')
      : '';

  const nextRunAt =
    trigger.triggerType === 'cron'
      ? ((trigger.config.nextRunAt as string | undefined) ?? null)
      : null;

  const initialCronPreset = useMemo((): PresetConfig => {
    if (trigger.triggerType !== 'cron') {
      return {
        preset: 'daily',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        time: '09:00',
      };
    }

    const cfg = (trigger.config ?? {}) as Record<string, unknown>;
    const preset =
      cfg.preset === 'daily' ||
      cfg.preset === 'weekly' ||
      cfg.preset === 'monthly' ||
      cfg.preset === 'once' ||
      cfg.preset === 'cron'
        ? (cfg.preset as PresetConfig['preset'])
        : null;
    const timezone =
      typeof cfg.timezone === 'string' && cfg.timezone
        ? (cfg.timezone as string)
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const datetimeRaw = typeof cfg.datetime === 'string' ? (cfg.datetime as string) : undefined;
    const datetime =
      preset === 'once' && datetimeRaw ? coerceDatetimeLocal(datetimeRaw, timezone) : undefined;

    if (preset) {
      return {
        preset,
        timezone,
        ...(typeof cfg.time === 'string' ? { time: cfg.time as string } : {}),
        ...(typeof cfg.dayOfWeek === 'number' ? { dayOfWeek: cfg.dayOfWeek as number } : {}),
        ...(typeof cfg.dayOfMonth === 'number' ? { dayOfMonth: cfg.dayOfMonth as number } : {}),
        ...(datetime ? { datetime } : {}),
        ...(typeof cfg.cronExpression === 'string'
          ? { cronExpression: cfg.cronExpression as string }
          : {}),
      };
    }

    return {
      preset: 'cron',
      timezone,
      cronExpression: typeof cfg.cronExpression === 'string' ? (cfg.cronExpression as string) : '',
    };
  }, [trigger.config, trigger.triggerType]);

  const [cronPresetConfig, setCronPresetConfig] = useState<PresetConfig>(initialCronPreset);
  useEffect(() => {
    if (editType !== 'cron') return;
    setCronPresetConfig(initialCronPreset);
  }, [editType, initialCronPreset]);

  const handleCopy = useCallback(async () => {
    if (!webhookUrl) return;
    try {
      setError(null);
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to copy webhook URL'));
    }
  }, [webhookUrl]);

  const handleToggle = useCallback(async () => {
    setToggling(true);
    setError(null);
    try {
      if (trigger.status === 'active') {
        await pauseWorkflowTrigger(projectId, trigger.id);
        toast.success('Trigger paused');
      } else {
        await resumeWorkflowTrigger(projectId, trigger.id);
        toast.success('Trigger resumed');
      }
      onChanged();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to update trigger'));
    } finally {
      setToggling(false);
    }
  }, [onChanged, projectId, trigger.id, trigger.status]);

  // Cron triggers fire directly — scheduled runs carry no payload, so a
  // payload editor would be noise. Webhook/app triggers open the modal so the
  // user can confirm or edit the replayed payload before firing. The UI
  // tracks app/connector triggers under `triggerType: 'event'` with
  // `connectorName` in config, so the check covers all payload-carrying types.
  const supportsPayload =
    trigger.triggerType === 'webhook' ||
    trigger.triggerType === 'event' ||
    Boolean((trigger.config as Record<string, unknown> | undefined)?.connectorName);

  const handleFire = useCallback(async () => {
    // Fail fast with a clear, user-facing message instead of letting the
    // backend reject the call with a generic error — paused/deleted triggers
    // cannot be fired on demand.
    if (trigger.status !== 'active') {
      const statusLabel = trigger.status === 'deleted' ? 'deleted' : 'disabled';
      const hint = trigger.status === 'paused' ? ' Resume it to fire.' : '';
      setError(`Trigger is ${statusLabel}.${hint}`);
      return;
    }
    if (supportsPayload) {
      setError(null);
      setShowFireModal(true);
      return;
    }
    setFiring(true);
    setError(null);
    try {
      await fireWorkflowTrigger(projectId, trigger.id);
      toast.success('Trigger fired');
      onChanged();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to fire trigger'));
    } finally {
      setFiring(false);
    }
  }, [onChanged, projectId, trigger.id, trigger.status, supportsPayload]);

  const handleFireWithPayload = useCallback(
    async (payload: Record<string, unknown>) => {
      setFiring(true);
      setError(null);
      try {
        await fireWorkflowTrigger(projectId, trigger.id, payload);
        toast.success('Trigger fired');
        setShowFireModal(false);
        onChanged();
      } finally {
        setFiring(false);
      }
    },
    [onChanged, projectId, trigger.id],
  );

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkflowTrigger(projectId, trigger.id);
      setShowDeleteConfirm(false);
      toast.success('Trigger deleted');
      onChanged();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to delete trigger'));
    } finally {
      setDeleting(false);
    }
  }, [onChanged, projectId, trigger.id]);

  const isActionDisabled = toggling || firing || deleting || !projectId;

  const detailsId = `trigger-details-${trigger.id}`;
  const isWebhook = trigger.triggerType === 'webhook';
  const isCron = trigger.triggerType === 'cron';
  // Connector/app triggers are stored with connectorName in config; the
  // server may label the type as 'event', 'app', or 'connector' depending on
  // the code path that wrote it, so treat connectorName as the real signal.
  const connectorName = trigger.config.connectorName as string | undefined;
  const triggerName = trigger.config.triggerName as string | undefined;
  const eventName = trigger.config.eventName as string | undefined;
  const pollingIntervalMs = trigger.config.pollingIntervalMs as number | undefined;
  const callbackUrlConfig = trigger.config.callbackUrl as string | undefined;
  const webhookHasCallback = isWebhook && Boolean(callbackUrlConfig);

  // Note: the create-side UI uses 'app' as a local synonym for 'event' (see the
  // `apiType` mapping in `handleSave` above), but the persisted `triggerType`
  // returned by the backend is the narrowed API enum which never includes 'app'.
  // Don't add a `=== 'app'` branch here — tsc rejects it as dead, and the
  // `connectorName` guard already covers connector-backed event triggers.
  const isAppLike =
    trigger.triggerType === 'connector' ||
    trigger.triggerType === 'event' ||
    trigger.triggerType === 'polling' ||
    Boolean(connectorName);

  // Webhook and connector (app) cards are collapsible — connector cards show
  // the read-only config panel; webhook cards show the URL + quick-start panel.
  const isCollapsible = isWebhook || isAppLike;

  const canEdit = isCron || isWebhook || isAppLike;

  const initialAppSelection = useMemo((): AppTriggerSelection => {
    const cfg = (trigger.config ?? {}) as Record<string, unknown>;
    const triggerParamsRaw = cfg.triggerParams;
    const triggerParams =
      triggerParamsRaw && typeof triggerParamsRaw === 'object' && !Array.isArray(triggerParamsRaw)
        ? (triggerParamsRaw as Record<string, string>)
        : undefined;
    return {
      connectorName: typeof cfg.connectorName === 'string' ? (cfg.connectorName as string) : '',
      triggerName: typeof cfg.triggerName === 'string' ? (cfg.triggerName as string) : '',
      connectionId: typeof cfg.connectionId === 'string' ? (cfg.connectionId as string) : '',
      ...(triggerParams ? { triggerParams } : {}),
    };
  }, [trigger.config]);

  const [appSelection, setAppSelection] = useState<AppTriggerSelection>(initialAppSelection);
  useEffect(() => {
    if (editType !== 'app') return;
    setAppSelection(initialAppSelection);
  }, [editType, initialAppSelection]);

  useEffect(() => {
    if (editType !== 'webhook') return;
    setWebhookCallbackUrl(callbackUrlConfig ?? '');
    setWebhookCallbackToken('');
  }, [callbackUrlConfig, editType]);

  // Cron summary mirrors SchedulePresetPicker's preview style: render the raw
  // expression in monospace with a human-readable description in parens,
  // suppressing the parens when cronstrue fell through to the raw expression.
  // cronstrue itself has no concept of timezone — the tz lives in config —
  // so we append it to the description so users see the actual firing zone.
  const cronTimezone = isCron ? (trigger.config.timezone as string | undefined) : undefined;
  const rawCronDescription = isCron && cronExpression ? formatCronExpression(cronExpression) : null;
  const cronDescription =
    rawCronDescription && cronTimezone && rawCronDescription !== cronExpression
      ? `${rawCronDescription}, ${cronTimezone}`
      : rawCronDescription;
  const cronPresetSummary = isCron && !cronExpression ? formatCronPreset(trigger.config) : null;

  const appSummary =
    !isWebhook && !isCron
      ? connectorName && triggerName
        ? `${connectorName} · ${triggerName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`
        : (connectorName ?? eventName ?? null)
      : null;

  const hasErrors = (trigger.consecutiveErrors ?? 0) > 0;
  const isActive = trigger.status === 'active';

  // Show "App Trigger" for any connector-backed trigger regardless of how the DB stored the type.
  const badgeLabel = connectorName ? 'App Trigger' : trigger.triggerType;

  const headerContent = (
    <>
      {/* Icon with live status dot */}
      <div className="relative shrink-0">
        {connectorName ? (
          <ConnectorLogo name={connectorName} className="w-9 h-9" />
        ) : (
          <div
            className={clsx(
              'w-9 h-9 rounded-lg flex items-center justify-center',
              isActive ? 'bg-success-subtle text-success' : 'bg-background-muted text-muted',
            )}
          >
            {config.icon}
          </div>
        )}
        <span
          className={clsx(
            'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-background-elevated',
            hasErrors ? 'bg-warning' : isActive ? 'bg-success' : 'bg-muted',
          )}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground truncate">{config.label}</p>
          <Badge variant={config.variant}>{badgeLabel}</Badge>
          {hasErrors && (
            <span className="text-xs font-medium text-warning">
              ⚠ {trigger.consecutiveErrors} error{(trigger.consecutiveErrors ?? 0) > 1 ? 's' : ''}
            </span>
          )}
          {isCron && cronExpression && (
            <>
              <code
                className={clsx(
                  'text-xs font-mono px-1.5 py-0.5 rounded',
                  'bg-background-muted text-foreground border border-default',
                )}
              >
                {cronExpression}
              </code>
              {cronDescription && cronDescription !== cronExpression && (
                <span className="text-xs text-muted truncate">({cronDescription})</span>
              )}
            </>
          )}
          {isCron && !cronExpression && (
            <span className="text-xs text-muted truncate">
              {cronPresetSummary ?? 'Schedule not configured'}
            </span>
          )}
          {appSummary && <span className="text-xs text-muted truncate">{appSummary}</span>}
        </div>
        {/* Last fired — only shown when it has actually fired */}
        {trigger.lastFiredAt && (
          <p className="text-xs text-muted mt-0.5">{`Last fired ${relativeTime(trigger.lastFiredAt)}`}</p>
        )}
      </div>

      {isCollapsible && (
        <ChevronDown
          className={clsx(
            'w-4 h-4 text-muted shrink-0 ml-1 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      )}
    </>
  );

  return (
    <>
      <div
        data-testid={`trigger-card-${trigger.triggerType}`}
        className={clsx(
          'rounded-xl border bg-background-elevated shadow-sm',
          hasErrors ? 'border-warning/40' : isActive ? 'border-success/30' : 'border-default',
        )}
      >
        {/* Header row — always visible. Webhook cards toggle expansion on click;
            cron/app cards render a static div (no expansion, nothing to hide). */}
        <div className="flex items-center justify-between gap-3 p-4">
          {isCollapsible ? (
            <button
              type="button"
              onClick={() =>
                setExpanded((v) => {
                  const next = !v;
                  if (!next) {
                    setEditType(null);
                    setPendingEditType(null);
                    setShowEditConfirm(false);
                    setCronEditError(null);
                    setWebhookEditError(null);
                    setAppEditError(null);
                  }
                  return next;
                })
              }
              className={clsx(
                'flex items-center gap-3 min-w-0 flex-1 text-left rounded-md',
                '-m-1 p-1 transition-default focus-ring',
                'hover:bg-background-muted/60',
              )}
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={expanded ? 'Collapse trigger details' : 'Expand trigger details'}
              data-testid={`trigger-expand-${trigger.id}`}
            >
              {headerContent}
            </button>
          ) : (
            <div className="flex items-center gap-3 min-w-0 flex-1">{headerContent}</div>
          )}

          {/* Right: grouped lifecycle actions. All three use Button size="sm" so
              padding + icon sizes match and the row aligns vertically. */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              icon={<Play className="w-4 h-4" />}
              onClick={handleFire}
              loading={firing}
              disabled={isActionDisabled || trigger.status === 'deleted'}
            >
              Fire Now
            </Button>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Pencil className="w-4 h-4" />}
                onClick={() => {
                  if (isCron) {
                    setCronEditError(null);
                    setPendingEditType('cron');
                    setShowEditConfirm(true);
                    return;
                  }
                  if (isWebhook) {
                    setWebhookEditError(null);
                    // Webhook triggers only expose callback settings; keep the
                    // primary CTA in the expanded panel, but allow header edit
                    // for parity.
                    setPendingEditType('webhook');
                    setShowEditConfirm(true);
                    return;
                  }
                  if (isAppLike) {
                    setAppEditError(null);
                    setPendingEditType('app');
                    setShowEditConfirm(true);
                  }
                }}
                disabled={isActionDisabled || trigger.status === 'deleted'}
                aria-label="Edit trigger"
              >
                Edit
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 className="w-4 h-4" />}
              onClick={() => setShowDeleteConfirm(true)}
              loading={deleting}
              disabled={isActionDisabled}
              aria-label="Delete trigger"
              className="hover:text-error"
            />
            <Button
              variant="ghost"
              size="sm"
              icon={
                trigger.status === 'active' ? (
                  <ToggleRight className="w-5 h-5 text-success" />
                ) : (
                  <ToggleLeft className="w-5 h-5" />
                )
              }
              onClick={handleToggle}
              loading={toggling}
              disabled={isActionDisabled || trigger.status === 'deleted'}
              aria-label={trigger.status === 'active' ? 'Pause trigger' : 'Resume trigger'}
            />
          </div>
        </div>

        <ConfirmDialog
          open={showEditConfirm}
          onClose={() => {
            if (savingCronEdit || savingWebhookEdit || savingAppEdit) return;
            setShowEditConfirm(false);
            setPendingEditType(null);
          }}
          onConfirm={() => {
            if (!pendingEditType) return;
            setShowEditConfirm(false);
            setEditType(pendingEditType);
            // Inline editors for webhook/app render in the expanded panel.
            if (pendingEditType !== 'cron') setExpanded(true);
          }}
          title={
            pendingEditType === 'cron'
              ? 'Edit schedule'
              : pendingEditType === 'webhook'
                ? 'Edit callback settings'
                : 'Edit app trigger'
          }
          description={
            pendingEditType === 'cron'
              ? 'This updates the schedule. Active triggers apply changes immediately.'
              : pendingEditType === 'webhook'
                ? 'This updates callback delivery settings. For security, existing access tokens are never shown. Leave the token blank to keep the existing one.'
                : pendingEditType === 'app'
                  ? 'This may overwrite the current app trigger selection and its configured inputs/filters. Continue?'
                  : 'This will update the trigger configuration. Continue?'
          }
          confirmLabel={pendingEditType === 'webhook' ? 'Edit callback' : 'Edit'}
          variant="primary"
        />

        {isCron && editType === 'cron' && (
          <div className="px-4 pb-4">
            <div
              className="rounded-lg border border-default bg-background-muted p-4"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !savingCronEdit) {
                  e.stopPropagation();
                  setEditType(null);
                }
              }}
            >
              <p className="text-xs font-medium text-muted mb-3">Schedule</p>
              <SchedulePresetPicker value={cronPresetConfig} onChange={setCronPresetConfig} />

              {cronEditError && (
                <p className="text-xs text-error mt-3" role="alert" aria-live="polite">
                  {cronEditError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-default">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditType(null)}
                  disabled={savingCronEdit}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={savingCronEdit}
                  onClick={async () => {
                    setSavingCronEdit(true);
                    setCronEditError(null);
                    try {
                      const config: Record<string, unknown> = {
                        preset: cronPresetConfig.preset,
                        timezone: cronPresetConfig.timezone,
                      };
                      if (cronPresetConfig.time) config.time = cronPresetConfig.time;
                      if (cronPresetConfig.dayOfWeek !== undefined)
                        config.dayOfWeek = cronPresetConfig.dayOfWeek;
                      if (cronPresetConfig.dayOfMonth !== undefined)
                        config.dayOfMonth = cronPresetConfig.dayOfMonth;
                      if (cronPresetConfig.datetime) config.datetime = cronPresetConfig.datetime;
                      if (cronPresetConfig.cronExpression)
                        config.cronExpression = cronPresetConfig.cronExpression;

                      await updateWorkflowTrigger(projectId, trigger.id, { config });
                      toast.success('Trigger updated');
                      setEditType(null);
                      onChanged();
                    } catch (err) {
                      setCronEditError(sanitizeError(err, 'Failed to update trigger'));
                    } finally {
                      setSavingCronEdit(false);
                    }
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Connector trigger — read-only params panel */}
        {isAppLike && expanded && editType !== 'app' && connectorName && (
          <div className="px-4 pb-4 pt-3 border-t border-default">
            <ConnectorTriggerParamsView
              projectId={projectId}
              connectorName={connectorName}
              triggerName={triggerName ?? ''}
              connectionId={trigger.config.connectionId ? String(trigger.config.connectionId) : ''}
              triggerParams={
                trigger.config.triggerParams && typeof trigger.config.triggerParams === 'object'
                  ? (trigger.config.triggerParams as Record<string, string>)
                  : {}
              }
            />
          </div>
        )}

        {isAppLike && expanded && editType === 'app' && (
          <div className="px-4 pb-4 pt-3 border-t border-default">
            <div
              className="rounded-lg border border-default bg-background-muted p-4"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !savingAppEdit) {
                  e.stopPropagation();
                  setEditType(null);
                }
              }}
            >
              <p className="text-xs font-medium text-muted mb-3">App trigger</p>
              <AppTriggerPicker
                projectId={projectId}
                value={appSelection}
                onChange={setAppSelection}
              />
              {appEditError && (
                <p className="text-xs text-error mt-3" role="alert" aria-live="polite">
                  {appEditError}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-default">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditType(null)}
                  disabled={savingAppEdit}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={savingAppEdit}
                  onClick={async () => {
                    // Validate before flipping the loading state so the Save button
                    // doesn't briefly flash a spinner when required fields are missing.
                    if (
                      !appSelection.connectorName ||
                      !appSelection.triggerName ||
                      !appSelection.connectionId
                    ) {
                      setAppEditError('Please select an app, trigger event, and connection');
                      return;
                    }
                    setSavingAppEdit(true);
                    setAppEditError(null);
                    try {
                      const configPatch: Record<string, unknown> = {
                        connectorName: appSelection.connectorName,
                        triggerName: appSelection.triggerName,
                        connectionId: appSelection.connectionId,
                      };
                      if (appSelection.triggerParams !== undefined) {
                        configPatch.triggerParams = appSelection.triggerParams;
                      }
                      await updateWorkflowTrigger(projectId, trigger.id, { config: configPatch });
                      toast.success('Trigger updated');
                      setEditType(null);
                      setExpanded(false);
                      onChanged();
                    } catch (err) {
                      setAppEditError(sanitizeError(err, 'Failed to update trigger'));
                    } finally {
                      setSavingAppEdit(false);
                    }
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Cron secondary info — always visible when present. Next-run and
            polling interval are short enough to inline without a click. */}
        {isCron && (nextRunAt || Boolean(pollingIntervalMs)) && (
          <div className="px-4 pb-3 pl-16 space-y-0.5 -mt-1">
            {nextRunAt && (
              <p className="text-xs text-muted">
                Next run: {new Date(nextRunAt).toLocaleString('en-US')}
              </p>
            )}
            {Boolean(pollingIntervalMs) && (
              <p className="text-xs text-muted">
                Polls every {Math.round(Number(pollingIntervalMs) / 1000)}s
              </p>
            )}
          </div>
        )}

        {/* App/event secondary info — the inline summary covers connector +
            trigger name, so this row only appears when we also have a raw
            eventName alongside a connectorName. */}
        {!isWebhook && !isCron && eventName && connectorName && (
          <div className="px-4 pb-3 pl-16 -mt-1">
            <p className="text-xs text-muted">
              Listens for: <code className="font-mono">{eventName}</code>
            </p>
          </div>
        )}

        {/* Webhook expanded section — URL row, optional callback, and the
            quick-start panel. No divider between the URL/callback and the
            quick-start so the panel flows continuously. */}
        {isWebhook && expanded && (
          <div id={detailsId} className="px-4 pb-4 pt-3 border-t border-default space-y-3">
            {webhookUrl && (
              <div className="flex items-center gap-2">
                <code
                  className={clsx(
                    'flex-1 text-xs font-mono px-2 py-1 rounded-md truncate',
                    'bg-background-muted text-foreground border border-default',
                  )}
                >
                  {webhookUrl}
                </code>
                <button
                  onClick={handleCopy}
                  className={clsx(
                    'p-1.5 rounded-md transition-fast shrink-0',
                    'hover:bg-background-muted text-muted hover:text-foreground',
                  )}
                  aria-label="Copy webhook URL"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            )}

            {callbackUrlConfig && (
              <p className="text-xs text-muted">
                Callback: <code className="font-mono">{callbackUrlConfig}</code>
              </p>
            )}

            {editType !== 'webhook' && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-default bg-background-muted px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">
                    {webhookHasCallback ? 'Callback configured' : 'No callback configured'}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {webhookHasCallback
                      ? 'Update URL or rotate access token.'
                      : 'Optionally deliver execution results to your server.'}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setWebhookEditError(null);
                    setPendingEditType('webhook');
                    setShowEditConfirm(true);
                  }}
                  disabled={isActionDisabled || trigger.status === 'deleted'}
                >
                  {webhookHasCallback ? 'Edit callback' : 'Configure'}
                </Button>
              </div>
            )}

            {editType === 'webhook' && (
              <div
                className="rounded-lg border border-default bg-background-muted p-4 space-y-3"
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !savingWebhookEdit) {
                    e.stopPropagation();
                    setEditType(null);
                  }
                }}
              >
                <div className="space-y-1.5">
                  <label htmlFor={webhookCallbackUrlId} className="text-xs font-medium text-muted">
                    Callback URL
                  </label>
                  <input
                    id={webhookCallbackUrlId}
                    type="url"
                    value={webhookCallbackUrl}
                    onChange={(e) => setWebhookCallbackUrl(e.target.value)}
                    placeholder="https://your-server.com/callback"
                    disabled={savingWebhookEdit}
                    aria-describedby={webhookEditError ? webhookErrorId : undefined}
                    className={clsx(
                      'w-full px-3 py-2 text-sm rounded-lg border border-default',
                      'bg-background-elevated text-foreground placeholder:text-muted',
                      'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  />
                  <p className="text-xs text-muted">
                    Leave empty to disable callback. Existing webhook URL is not changed.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor={webhookCallbackTokenId}
                    className="text-xs font-medium text-muted"
                  >
                    Access Token
                  </label>
                  <input
                    id={webhookCallbackTokenId}
                    type="password"
                    value={webhookCallbackToken}
                    onChange={(e) => setWebhookCallbackToken(e.target.value)}
                    placeholder="Leave blank to keep existing"
                    disabled={savingWebhookEdit}
                    aria-describedby={webhookEditError ? webhookErrorId : undefined}
                    className={clsx(
                      'w-full px-3 py-2 text-sm rounded-lg border border-default',
                      'bg-background-elevated text-foreground placeholder:text-muted',
                      'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  />
                </div>

                {webhookEditError && (
                  <p
                    id={webhookErrorId}
                    className="text-xs text-error"
                    role="alert"
                    aria-live="polite"
                  >
                    {webhookEditError}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-default">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditType(null)}
                    disabled={savingWebhookEdit}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={savingWebhookEdit}
                    onClick={async () => {
                      setSavingWebhookEdit(true);
                      setWebhookEditError(null);
                      try {
                        const url = webhookCallbackUrl.trim();
                        const token = webhookCallbackToken.trim();
                        const configPatch: Record<string, unknown> = url
                          ? { callbackUrl: url }
                          : { callbackUrl: '' };
                        if (url && token) configPatch.callbackAccessToken = token;

                        await updateWorkflowTrigger(projectId, trigger.id, { config: configPatch });
                        toast.success('Trigger updated');
                        setEditType(null);
                        setExpanded(false);
                        onChanged();
                      } catch (err) {
                        setWebhookEditError(sanitizeError(err, 'Failed to update trigger'));
                      } finally {
                        setSavingWebhookEdit(false);
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}

            <WebhookQuickStart
              workflow={{ id: workflowId, name: workflowName }}
              trigger={{ id: trigger.id, config: trigger.config }}
              projectId={projectId}
              apiKey={apiKey ?? undefined}
              rawApiKey={rawApiKey}
              onRequestKey={onRequestKey}
              version={viewedVersion}
              versionState={viewedState}
              inputSchema={inputSchema}
            />
          </div>
        )}

        {/* Error — always visible so users see failures even when collapsed */}
        {error && <p className="px-4 pb-3 text-xs text-error">{error}</p>}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Trigger?"
        description="This removes the trigger from the workflow. The workflow will stop receiving events from this trigger."
        confirmLabel="Delete Trigger"
        loading={deleting}
      />

      {supportsPayload && (
        <FireTriggerModal
          open={showFireModal}
          onClose={() => setShowFireModal(false)}
          onFire={handleFireWithPayload}
          projectId={projectId}
          triggerId={trigger.id}
          triggerTypeLabel={config.label}
          inputSchema={inputSchema}
          connectorName={connectorName}
        />
      )}
    </>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowTriggersTab({
  workflow,
  onRefresh,
  viewedVersion,
  viewedState,
}: WorkflowTriggersTabProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const [showForm, setShowForm] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  // localStorage key for persisting the raw API key across navigations
  const storageKey = projectId ? `abl:sdk-key:${projectId}` : null;

  // Stores the raw key — initialized from localStorage if available
  const [createdRawKey, setCreatedRawKey] = useState<string | null>(() => {
    if (!storageKey) return null;
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  // Stores the linked API key metadata (persisted via server fetch)
  const [linkedApiKey, setLinkedApiKey] = useState<{
    id: string;
    prefix: string;
    isActive: boolean;
    expiresAt: string | null;
  } | null>(null);

  // Save raw key to localStorage whenever it changes
  const saveRawKey = useCallback(
    (rawKey: string) => {
      setCreatedRawKey(rawKey);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, rawKey);
        } catch {
          // Storage full or unavailable
        }
      }
    },
    [storageKey],
  );

  // Fetch existing SDK keys for this project on mount
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    async function fetchExistingKey() {
      try {
        const url = `/api/keys?projectId=${encodeURIComponent(projectId!)}`;
        const response = await apiFetch(url);
        const result = (await handleResponse(response)) as {
          keys?: Array<{
            id: string;
            prefix: string;
            scopes: string[];
            revokedAt: string | null;
            expiresAt: string | null;
          }>;
        };
        if (cancelled) return;
        const activeKeys = (result.keys ?? []).filter(
          (k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) > new Date()),
        );
        if (activeKeys.length > 0) {
          const key = activeKeys[0];
          setLinkedApiKey({
            id: key.id,
            prefix: key.prefix,
            isActive: true,
            expiresAt: key.expiresAt,
          });
        }
      } catch {
        // Non-critical — user can still create a key manually
      }
    }

    void fetchExistingKey();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch trigger registrations from the engine via SWR
  const {
    data: registrationsData,
    isLoading: registrationsLoading,
    mutate: refreshRegistrations,
  } = useSWR(
    projectId && workflow.id
      ? `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers?workflowId=${encodeURIComponent(workflow.id)}`
      : null,
  );

  // Normalize triggers from registrations API (maps `strategy` -> `type`)
  const triggers = (
    ((registrationsData as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>[]
      | undefined) ?? []
  ).map((t: Record<string, unknown>) => normalizeTrigger(t));

  const handleCreated = useCallback(() => {
    setShowForm(false);
    refreshRegistrations();
    onRefresh?.();
  }, [onRefresh, refreshRegistrations]);

  const handleChanged = useCallback(() => {
    refreshRegistrations();
    onRefresh?.();
  }, [onRefresh, refreshRegistrations]);

  const handleAddClick = useCallback(() => {
    setShowForm(true);
  }, []);

  const handleCancelForm = useCallback(() => {
    setShowForm(false);
  }, []);

  const handleRequestKey = useCallback(() => {
    setShowKeyModal(true);
  }, []);

  // Only show key section when the raw key is available (from localStorage
  // or just created). Without the raw key, copy buttons can't provide the
  // real key — so show "Generate API Key" instead.
  const transformedApiKey = createdRawKey
    ? {
        id: linkedApiKey?.id ?? '',
        prefix: createdRawKey.slice(0, 8),
        isActive: true as const,
        expiresAt: null,
      }
    : null;

  // Show skeleton while the initial registrations fetch is in flight — avoids
  // flashing the EmptyState before data arrives.
  if (registrationsLoading && !registrationsData && !showForm) {
    return (
      <div className="space-y-4" data-testid="triggers-loading">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-default bg-background-elevated p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <Skeleton className="w-9 h-9 rounded-lg shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-6 w-full max-w-md rounded-md" />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Skeleton className="h-8 w-20 rounded-lg" />
                  <Skeleton className="h-8 w-8 rounded-lg" />
                  <Skeleton className="h-8 w-8 rounded-lg" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (triggers.length === 0 && !showForm) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={<Zap className="w-6 h-6" />}
          title="No triggers configured"
          description="Add triggers to automatically start this workflow from webhooks, schedules, or events."
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
              onClick={handleAddClick}
              data-testid="add-trigger-btn"
            >
              Add Trigger
            </Button>
          }
        />
        {showForm && projectId && (
          <TriggerCreationForm
            projectId={projectId}
            workflowId={workflow.id}
            onCreated={handleCreated}
            onCancel={handleCancelForm}
            onWebhookCreated={undefined}
          />
        )}

        {/* Webhook Key Creation Modal */}
        {showKeyModal && projectId && (
          <WebhookKeyCreationModal
            workflowId={workflow.id}
            projectId={projectId}
            workflowName={workflow.name}
            onKeyCreated={(key) => {
              saveRawKey(key.rawKey);
              setLinkedApiKey({
                id: key.id,
                prefix: key.rawKey.slice(0, 8),
                isActive: true,
                expiresAt: null,
              });
              setShowKeyModal(false);
            }}
            onClose={() => setShowKeyModal(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Triggers ({triggers.length})</h2>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="w-4 h-4" />}
          onClick={handleAddClick}
          disabled={showForm}
        >
          Add Trigger
        </Button>
      </div>

      {/* Inline creation form */}
      {showForm && projectId && (
        <TriggerCreationForm
          projectId={projectId}
          workflowId={workflow.id}
          onCreated={handleCreated}
          onCancel={handleCancelForm}
          onWebhookCreated={undefined}
        />
      )}

      {/* Trigger list */}
      <div className="space-y-3">
        {triggers.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            projectId={projectId ?? ''}
            workflowId={workflow.id}
            workflowName={workflow.name}
            onChanged={handleChanged}
            apiKey={transformedApiKey}
            rawApiKey={createdRawKey ?? undefined}
            onRequestKey={handleRequestKey}
            viewedVersion={viewedVersion}
            viewedState={viewedState}
            inputSchema={workflow.inputSchema ?? null}
          />
        ))}
      </div>

      {/* Webhook Key Creation Modal */}
      {showKeyModal && projectId && (
        <WebhookKeyCreationModal
          workflowId={workflow.id}
          projectId={projectId}
          workflowName={workflow.name}
          onKeyCreated={(key) => {
            saveRawKey(key.rawKey);
            setLinkedApiKey({
              id: key.id,
              prefix: key.rawKey.slice(0, 8),
              isActive: true,
              expiresAt: null,
            });
            setShowKeyModal(false);
          }}
          onClose={() => setShowKeyModal(false)}
        />
      )}
    </div>
  );
}
