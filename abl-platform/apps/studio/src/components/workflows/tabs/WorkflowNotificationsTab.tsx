'use client';

/**
 * WorkflowNotificationsTab Component
 *
 * Lists notification rules for the workflow with create, edit, and delete.
 * Each rule shows event type, channel, destination target, and template preview.
 */

import { useState, useCallback } from 'react';
import {
  Plus,
  Bell,
  Mail,
  MessageSquare,
  Webhook,
  CheckCircle2,
  AlertTriangle,
  UserCheck,
  Trash2,
  Loader2,
  X,
  Pencil,
} from 'lucide-react';
import clsx from 'clsx';
import type {
  WorkflowDetail,
  WorkflowNotificationRule,
  WorkflowNotificationRulePayload,
  WorkflowNotificationEvent,
  WorkflowNotificationChannelType,
} from '../../../api/workflows';
import {
  createWorkflowNotificationRule,
  deleteWorkflowNotificationRule,
  updateWorkflowNotificationRule,
} from '../../../api/workflows';
import { sanitizeError } from '../../../lib/sanitize-error';
import { useNavigationStore } from '../../../store/navigation-store';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';

// =============================================================================
// CONSTANTS
// =============================================================================

const EVENT_TYPE_CONFIG: Record<
  WorkflowNotificationEvent,
  { label: string; variant: BadgeVariant; icon: React.ReactNode }
> = {
  'workflow.started': {
    label: 'Workflow Started',
    variant: 'accent',
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  'workflow.completed': {
    label: 'Workflow Completed',
    variant: 'success',
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  'workflow.failed': {
    label: 'Workflow Failed',
    variant: 'error',
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
  },
  'workflow.cancelled': {
    label: 'Workflow Cancelled',
    variant: 'warning',
    icon: <Bell className="w-3.5 h-3.5" />,
  },
  'step.failed': {
    label: 'Step Failed',
    variant: 'error',
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
  },
  'step.waiting_approval': {
    label: 'Approval Required',
    variant: 'accent',
    icon: <UserCheck className="w-3.5 h-3.5" />,
  },
  'step.waiting_callback': {
    label: 'Waiting Callback',
    variant: 'warning',
    icon: <Bell className="w-3.5 h-3.5" />,
  },
  'step.waiting_human_task': {
    label: 'Human Task Ready',
    variant: 'accent',
    icon: <UserCheck className="w-3.5 h-3.5" />,
  },
};

const CHANNEL_CONFIG: Record<
  WorkflowNotificationChannelType,
  { label: string; icon: React.ReactNode; placeholder: string }
> = {
  email: {
    label: 'Email',
    icon: <Mail className="w-4 h-4" />,
    placeholder: 'alerts@example.com',
  },
  slack: {
    label: 'Slack',
    icon: <MessageSquare className="w-4 h-4" />,
    placeholder: '#workflow-alerts',
  },
  msteams: {
    label: 'MS Teams',
    icon: <MessageSquare className="w-4 h-4" />,
    placeholder: 'teams-webhook-url',
  },
  webhook: {
    label: 'Webhook',
    icon: <Webhook className="w-4 h-4" />,
    placeholder: 'https://example.com/webhook',
  },
  websocket: {
    label: 'WebSocket',
    icon: <Webhook className="w-4 h-4" />,
    placeholder: 'ws://example.com/notifications',
  },
};

const EVENT_TYPES: Array<{
  value: WorkflowNotificationEvent;
  label: string;
}> = Object.entries(EVENT_TYPE_CONFIG).map(([value, config]) => ({
  value: value as WorkflowNotificationEvent,
  label: config.label,
}));

const CHANNEL_TYPES: Array<{
  value: WorkflowNotificationChannelType;
  label: string;
}> = Object.entries(CHANNEL_CONFIG).map(([value, config]) => ({
  value: value as WorkflowNotificationChannelType,
  label: config.label,
}));

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowNotificationsTabProps {
  workflow: WorkflowDetail;
  onRefresh?: () => void;
}

// =============================================================================
// RULE FORM
// =============================================================================

interface NotificationRuleFormProps {
  mode: 'create' | 'edit';
  projectId: string;
  workflowId: string;
  initialRule?: WorkflowNotificationRule;
  onSaved: () => void;
  onCancel: () => void;
}

function NotificationRuleForm({
  mode,
  projectId,
  workflowId,
  initialRule,
  onSaved,
  onCancel,
}: NotificationRuleFormProps) {
  const [name, setName] = useState(initialRule?.name ?? '');
  const [events, setEvents] = useState<WorkflowNotificationEvent[]>(
    initialRule?.events ?? ['workflow.completed'],
  );
  const [channelType, setChannelType] = useState<WorkflowNotificationChannelType>(
    initialRule?.channel.type ?? 'email',
  );
  const [target, setTarget] = useState(initialRule?.channel.target ?? '');
  const [connectionId, setConnectionId] = useState(initialRule?.channel.connectionId ?? '');
  const [enabled, setEnabled] = useState(initialRule?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleEvent = useCallback((ev: WorkflowNotificationEvent) => {
    setEvents((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (events.length === 0) {
      setError('Select at least one event');
      return;
    }
    if (!target.trim()) {
      setError('Target is required');
      return;
    }

    setSaving(true);
    setError(null);

    const payload: WorkflowNotificationRulePayload = {
      name: name.trim(),
      events,
      enabled,
      channel: {
        type: channelType,
        connectionId: connectionId.trim(),
        target: target.trim(),
      },
    };

    try {
      if (mode === 'edit' && initialRule) {
        await updateWorkflowNotificationRule(projectId, workflowId, initialRule.id, payload);
      } else {
        await createWorkflowNotificationRule(projectId, workflowId, payload);
      }
      onSaved();
    } catch (err) {
      setError(
        sanitizeError(
          err,
          mode === 'edit'
            ? 'Failed to update notification rule'
            : 'Failed to create notification rule',
        ),
      );
    } finally {
      setSaving(false);
    }
  }, [
    channelType,
    connectionId,
    enabled,
    events,
    initialRule,
    mode,
    name,
    onSaved,
    projectId,
    target,
    workflowId,
  ]);

  return (
    <div className="rounded-xl border border-accent/30 bg-background-elevated p-4 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {mode === 'edit' ? 'Edit Notification Rule' : 'New Notification Rule'}
        </h3>
        <button
          onClick={onCancel}
          className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default"
          aria-label="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Rule Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alert on failure"
          aria-label="Rule name"
          className={clsx(
            'w-full px-3 py-2 text-sm rounded-lg border border-default',
            'bg-background-muted text-foreground placeholder:text-muted',
            'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
          )}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Events (select one or more)</label>
        <div className="flex gap-2 flex-wrap">
          {EVENT_TYPES.map((option) => (
            <button
              key={option.value}
              onClick={() => toggleEvent(option.value)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg border transition-default',
                events.includes(option.value)
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default bg-background-muted text-muted hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Channel</label>
        <div className="flex gap-2 flex-wrap">
          {CHANNEL_TYPES.map((option) => (
            <button
              key={option.value}
              onClick={() => setChannelType(option.value)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg border transition-default',
                channelType === option.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default bg-background-muted text-muted hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Target</label>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={CHANNEL_CONFIG[channelType].placeholder}
          aria-label="Target"
          className={clsx(
            'w-full px-3 py-2 text-sm rounded-lg border border-default',
            'bg-background-muted text-foreground placeholder:text-muted',
            'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
          )}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Auth Profile ID (optional)</label>
        <input
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          placeholder="Auth profile ID for channel authentication"
          aria-label="Auth Profile ID"
          className={clsx(
            'w-full px-3 py-2 text-sm rounded-lg border border-default',
            'bg-background-muted text-foreground placeholder:text-muted',
            'focus:outline-none focus:ring-2 focus:ring-border-focus/40',
          )}
        />
      </div>

      <label className="flex items-center gap-2 text-xs font-medium text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          aria-label="Enabled"
          className="rounded border-default"
        />
        <span>Enabled (uncheck to pause this rule without deleting it)</span>
      </label>

      {error && <p className="text-xs text-error">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
          {mode === 'edit' ? 'Save Changes' : 'Create Rule'}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// NOTIFICATION RULE CARD
// =============================================================================

interface NotificationRuleCardProps {
  rule: WorkflowNotificationRule;
  projectId: string;
  workflowId: string;
  onChanged: () => void;
}

function NotificationRuleCard({
  rule,
  projectId,
  workflowId,
  onChanged,
}: NotificationRuleCardProps) {
  const channelConfig = CHANNEL_CONFIG[rule.channel.type] ?? CHANNEL_CONFIG.webhook;
  const [isEditing, setIsEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkflowNotificationRule(projectId, workflowId, rule.id);
      onChanged();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to delete notification rule'));
    } finally {
      setDeleting(false);
    }
  }, [onChanged, projectId, rule.id, workflowId]);

  if (isEditing) {
    return (
      <NotificationRuleForm
        mode="edit"
        projectId={projectId}
        workflowId={workflowId}
        initialRule={rule}
        onSaved={() => {
          setIsEditing(false);
          onChanged();
        }}
        onCancel={() => {
          setIsEditing(false);
          setError(null);
        }}
      />
    );
  }

  return (
    <div
      className={clsx(
        'rounded-xl border border-default bg-background-elevated p-4 shadow-sm',
        'hover:border-accent/30 hover:shadow-sm transition-default',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-background-muted flex items-center justify-center shrink-0 text-muted">
            {channelConfig.icon}
          </div>

          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{rule.name}</p>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              {rule.events.map((ev) => {
                const evConfig = EVENT_TYPE_CONFIG[ev];
                return evConfig ? (
                  <Badge key={ev} variant={evConfig.variant}>
                    <span className="flex items-center gap-1">
                      {evConfig.icon}
                      {evConfig.label}
                    </span>
                  </Badge>
                ) : (
                  <Badge key={ev} variant="default">
                    {ev}
                  </Badge>
                );
              })}
              <Badge variant="default">{channelConfig.label}</Badge>
              {!rule.enabled && <Badge variant="warning">Disabled</Badge>}
            </div>

            <div className="mt-2">
              <p className="text-xs text-muted mb-1">Target</p>
              <div className="px-3 py-2 rounded-md text-xs font-mono bg-background-muted border border-default text-foreground break-all">
                {rule.channel.target}
              </div>
            </div>

            {error && <p className="mt-2 text-xs text-error">{error}</p>}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            className="p-1.5 rounded-md transition-default text-muted hover:text-foreground hover:bg-background-muted"
            aria-label="Edit notification rule"
            onClick={() => setIsEditing(true)}
            disabled={deleting}
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            className={clsx(
              'p-1.5 rounded-md transition-default',
              'text-muted hover:text-error hover:bg-error/10',
              deleting && 'opacity-50 pointer-events-none',
            )}
            aria-label="Delete notification rule"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowNotificationsTab({ workflow, onRefresh }: WorkflowNotificationsTabProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const [showForm, setShowForm] = useState(false);
  const rules = workflow.notificationRules ?? [];

  const handleChanged = useCallback(() => {
    setShowForm(false);
    onRefresh?.();
  }, [onRefresh]);

  const handleAddClick = useCallback(() => {
    setShowForm(true);
  }, []);

  const handleCancelForm = useCallback(() => {
    setShowForm(false);
  }, []);

  if (rules.length === 0 && !showForm) {
    return (
      <EmptyState
        icon={<Bell className="w-6 h-6" />}
        title="No notification rules"
        description="Add notification rules to get alerted when workflow events occur."
        action={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-4 h-4" />}
            onClick={handleAddClick}
          >
            Add Rule
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          Notification Rules ({rules.length})
        </h2>
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="w-4 h-4" />}
          onClick={handleAddClick}
          disabled={showForm}
        >
          Add Rule
        </Button>
      </div>

      {showForm && projectId && (
        <NotificationRuleForm
          mode="create"
          projectId={projectId}
          workflowId={workflow.id}
          onSaved={handleChanged}
          onCancel={handleCancelForm}
        />
      )}

      {rules.length > 0 && (
        <>
          <div className="rounded-lg border border-default bg-background-muted px-4 py-3">
            <p className="text-xs font-medium text-muted mb-2">Available Event Types</p>
            <div className="flex flex-wrap gap-1.5">
              {EVENT_TYPES.map((eventType) => (
                <Badge key={eventType.value} variant={EVENT_TYPE_CONFIG[eventType.value].variant}>
                  <span className="flex items-center gap-1">
                    {EVENT_TYPE_CONFIG[eventType.value].icon}
                    {eventType.label}
                  </span>
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {rules.map((rule) => (
              <NotificationRuleCard
                key={rule.id}
                rule={rule}
                projectId={projectId ?? ''}
                workflowId={workflow.id}
                onChanged={handleChanged}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
