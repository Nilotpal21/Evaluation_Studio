/**
 * ConnectorsPage Component
 *
 * Workspace-level admin page for managing Connectors & Channels.
 * Two tabs: Channel Connections (cards per type) and SDK Channels (DataTable).
 *
 * Enhanced with:
 * - Add Connection dialog with type-specific credential fields
 * - Add/Edit SDK Channel dialogs
 * - Webhook URL display and masked credentials
 * - Status indicators with icons
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Plug,
  Code,
  Plus,
  Loader2,
  Trash2,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  Pencil,
  Copy,
  Eye,
  EyeOff,
  Link,
} from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Tabs } from '../ui/Tabs';
import { EmptyState } from '../ui/EmptyState';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { toast } from 'sonner';
import {
  useChannelConnections,
  useSDKChannels,
  type ChannelConnection,
  type SDKChannel,
  type CreateChannelConnectionInput,
  type CreateSDKChannelInput,
} from '../../hooks/useConnectors';
import {
  resolveChannelDeleteAction,
  resolveChannelDeleteOutcome,
} from '../../lib/channel-delete-behavior';
import { useProjectStore } from '../../store/project-store';
import { buildSDKChannelInput } from './sdk-channel-dialog-utils';

// =============================================================================
// CONSTANTS
// =============================================================================

const CHANNEL_TYPES = [
  { id: 'slack', label: 'Slack' },
  { id: 'teams', label: 'Microsoft Teams' },
  { id: 'email', label: 'Email' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'voice', label: 'Voice' },
] as const;

const CHANNEL_TYPE_FIELDS: Record<
  string,
  { key: string; label: string; placeholder: string; secret?: boolean }[]
> = {
  slack: [
    { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...', secret: true },
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      placeholder: 'Enter signing secret',
      secret: true,
    },
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/...' },
  ],
  teams: [
    { key: 'appId', label: 'App ID', placeholder: 'Enter Teams App ID' },
    { key: 'appPassword', label: 'App Password', placeholder: 'Enter app password', secret: true },
    { key: 'tenantId', label: 'Teams Tenant ID', placeholder: 'Enter Azure AD tenant ID' },
  ],
  email: [
    { key: 'smtpHost', label: 'SMTP Host', placeholder: 'smtp.example.com' },
    { key: 'smtpPort', label: 'SMTP Port', placeholder: '587' },
    { key: 'username', label: 'Username', placeholder: 'user@example.com' },
    { key: 'password', label: 'Password', placeholder: 'Enter password', secret: true },
  ],
  whatsapp: [
    { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'Enter phone number ID' },
    { key: 'accessToken', label: 'Access Token', placeholder: 'Enter access token', secret: true },
    { key: 'verifyToken', label: 'Verify Token', placeholder: 'Enter verify token', secret: true },
  ],
  voice: [
    { key: 'provider', label: 'Provider', placeholder: 'e.g. twilio, vonage' },
    { key: 'accountSid', label: 'Account SID', placeholder: 'Enter account SID' },
    { key: 'authToken', label: 'Auth Token', placeholder: 'Enter auth token', secret: true },
    { key: 'phoneNumber', label: 'Phone Number', placeholder: '+1234567890' },
  ],
};

const SDK_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;

// =============================================================================
// Helpers
// =============================================================================

function maskValue(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
}

function copyToClipboard(text: string, successMessage: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(successMessage),
    () => toast.error('Failed to copy'),
  );
}

// =============================================================================
// Add Connection Dialog
// =============================================================================

function AddConnectionDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateChannelConnectionInput) => Promise<void>;
}) {
  const t = useTranslations('admin');
  const [selectedType, setSelectedType] = useState<string>('slack');
  const [name, setName] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  const fields = CHANNEL_TYPE_FIELDS[selectedType] ?? [];

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t('connectors.add_connection_name_required'));
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        type: selectedType,
        config: configValues,
      });
      toast.success(t('connectors.connection_created'));
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectors.connection_create_failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setName('');
    setSelectedType('slack');
    setConfigValues({});
    setShowSecrets({});
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('connectors.add_connection_title')}
      description={t('connectors.add_connection_description')}
      maxWidth="lg"
    >
      <div className="space-y-4">
        {/* Connection name */}
        <Input
          label={t('connectors.add_connection_name_label')}
          placeholder={t('connectors.add_connection_name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {/* Channel type selector */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-foreground">
            {t('connectors.add_connection_type_label')}
          </label>
          <div className="grid grid-cols-5 gap-2">
            {CHANNEL_TYPES.map((ct) => (
              <button
                key={ct.id}
                onClick={() => {
                  setSelectedType(ct.id);
                  setConfigValues({});
                  setShowSecrets({});
                }}
                className={`px-3 py-2 text-xs font-medium rounded-lg border transition-default text-center ${
                  selectedType === ct.id
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-default bg-background-subtle text-muted hover:text-foreground hover:bg-background-muted'
                }`}
              >
                {ct.label}
              </button>
            ))}
          </div>
        </div>

        {/* Type-specific fields */}
        {fields.length > 0 && (
          <div className="space-y-3 pt-2">
            <h4 className="text-xs font-medium text-muted uppercase tracking-wider">
              {t('connectors.add_connection_credentials')}
            </h4>
            {fields.map((field) => (
              <div key={field.key} className="relative">
                <Input
                  label={field.label}
                  placeholder={field.placeholder}
                  type={field.secret && !showSecrets[field.key] ? 'password' : 'text'}
                  value={configValues[field.key] ?? ''}
                  onChange={(e) =>
                    setConfigValues((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                />
                {field.secret && (
                  <button
                    type="button"
                    onClick={() =>
                      setShowSecrets((prev) => ({
                        ...prev,
                        [field.key]: !prev[field.key],
                      }))
                    }
                    className="absolute right-2 top-8 p-1 text-muted hover:text-foreground transition-default"
                  >
                    {showSecrets[field.key] ? (
                      <EyeOff className="w-3.5 h-3.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {t('connectors.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={!name.trim()}
            icon={<Plus className="w-4 h-4" />}
          >
            {t('connectors.add_connection_submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Add/Edit SDK Channel Dialog
// =============================================================================

function SDKChannelDialog({
  open,
  onClose,
  onSubmit,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateSDKChannelInput) => Promise<void>;
  initial?: SDKChannel | null;
}) {
  const t = useTranslations('admin');
  const projects = useProjectStore((s) => s.projects);
  const [name, setName] = useState(initial?.name ?? '');
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [environment, setEnvironment] = useState<string | null>(
    initial?.environment ?? (initial ? null : 'dev'),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [rateLimitRpm, setRateLimitRpm] = useState(
    initial?.rateLimitRpm ? String(initial.rateLimitRpm) : '',
  );
  const [allowedOrigins, setAllowedOrigins] = useState(initial?.allowedOrigins?.join(', ') ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEditing = !!initial;

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t('connectors.sdk_channel_name_required'));
      return;
    }
    if (!projectId) {
      toast.error(t('connectors.sdk_channel_project_required'));
      return;
    }
    setIsSubmitting(true);
    try {
      const input: CreateSDKChannelInput = buildSDKChannelInput({
        name,
        projectId,
        environment,
        initialEnvironment: initial?.environment ?? null,
        enabled,
        rateLimitRpm,
        allowedOrigins,
        isEditing,
      });
      await onSubmit(input);
      toast.success(isEditing ? t('connectors.channel_updated') : t('connectors.channel_created'));
      handleClose();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : isEditing
            ? t('connectors.channel_update_failed')
            : t('connectors.channel_create_failed'),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!initial) {
      setName('');
      setProjectId('');
      setEnvironment('dev');
      setEnabled(true);
      setRateLimitRpm('');
      setAllowedOrigins('');
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={isEditing ? t('connectors.edit_channel_title') : t('connectors.add_channel_title')}
      description={
        isEditing
          ? t('connectors.edit_channel_description')
          : t('connectors.add_channel_description')
      }
    >
      <div className="space-y-4">
        <Input
          label={t('connectors.sdk_channel_name_label')}
          placeholder={t('connectors.sdk_channel_name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {/* Project selector */}
        <Select
          label={t('connectors.sdk_channel_project_label')}
          placeholder={t('connectors.sdk_channel_project_placeholder')}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          value={projectId}
          onChange={setProjectId}
          disabled={isEditing}
        />

        {/* Environment selector */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-foreground">
            {t('connectors.sdk_channel_environment_label')}
          </label>
          <div className="flex gap-2">
            {SDK_ENVIRONMENTS.map((env) => (
              <button
                key={env}
                onClick={() => setEnvironment(env)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-default ${
                  environment === env
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-default bg-background-subtle text-muted hover:text-foreground hover:bg-background-muted'
                }`}
              >
                {env}
              </button>
            ))}
          </div>
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">
            {t('connectors.sdk_channel_enabled_label')}
          </label>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <Input
          label={t('connectors.sdk_channel_rate_limit_label')}
          placeholder={t('connectors.sdk_channel_rate_limit_placeholder')}
          type="number"
          value={rateLimitRpm}
          onChange={(e) => setRateLimitRpm(e.target.value)}
        />

        <Input
          label={t('connectors.sdk_channel_origins_label')}
          placeholder={t('connectors.sdk_channel_origins_placeholder')}
          value={allowedOrigins}
          onChange={(e) => setAllowedOrigins(e.target.value)}
        />

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {t('connectors.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={!name.trim() || !projectId}
          >
            {isEditing ? t('connectors.save_changes') : t('connectors.add_channel_submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Channel Connections Tab
// =============================================================================

function ChannelConnectionsTab() {
  const t = useTranslations('admin');
  const { connections, isLoading, mutate, createConnection, deleteConnection } =
    useChannelConnections();

  const [deleteTarget, setDeleteTarget] = useState<ChannelConnection | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const deleteOutcome = resolveChannelDeleteOutcome({
        source: 'channel_connection',
        status: deleteTarget.status,
        outcome: (await deleteConnection(deleteTarget.id)).outcome,
      });
      toast.success(
        deleteOutcome === 'deactivated'
          ? t('connectors.connection_deactivated')
          : t('connectors.connection_deleted'),
      );
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectors.connection_delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <Wifi className="w-4 h-4 text-success" />;
      case 'error':
        return <AlertTriangle className="w-4 h-4 text-error" />;
      default:
        return <WifiOff className="w-4 h-4 text-muted" />;
    }
  };

  const statusVariant = (status: string): 'success' | 'error' | 'default' => {
    switch (status) {
      case 'active':
        return 'success';
      case 'error':
        return 'error';
      default:
        return 'default';
    }
  };

  // Group connections by type
  const grouped = connections.reduce(
    (acc, conn) => {
      const type = conn.type || 'other';
      if (!acc[type]) acc[type] = [];
      acc[type].push(conn);
      return acc;
    },
    {} as Record<string, ChannelConnection[]>,
  );
  const deleteTargetAction = deleteTarget
    ? resolveChannelDeleteAction({
        source: 'channel_connection',
        status: deleteTarget.status,
      })
    : 'delete';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted">
            {t('connectors.connection_count', {
              count: connections.length,
            })}
          </p>
          <button
            onClick={() => mutate()}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <Button
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => setShowAddDialog(true)}
        >
          {t('connectors.add_connection_button')}
        </Button>
      </div>

      {connections.length === 0 ? (
        <EmptyState
          icon={<Plug className="w-6 h-6" />}
          title={t('connectors.connections_empty_title')}
          description={t('connectors.connections_empty_description')}
        />
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([type, conns]) => (
            <div key={type}>
              <h4 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
                {type} ({conns.length})
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {conns.map((conn) => {
                  const deleteAction = resolveChannelDeleteAction({
                    source: 'channel_connection',
                    status: conn.status,
                  });

                  return (
                    <div
                      key={conn.id}
                      className="flex flex-col gap-3 p-4 rounded-lg bg-background-elevated border border-default"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
                          {statusIcon(conn.status)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground truncate">
                              {conn.name}
                            </p>
                            <Badge variant={statusVariant(conn.status)} dot>
                              {conn.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted mt-0.5">
                            {conn.lastActiveAt
                              ? t('connectors.last_active', {
                                  date: new Date(conn.lastActiveAt).toLocaleDateString(),
                                })
                              : t('connectors.created_on', {
                                  date: new Date(conn.createdAt).toLocaleDateString(),
                                })}
                          </p>
                        </div>
                        <button
                          onClick={() => setDeleteTarget(conn)}
                          className="p-1.5 text-muted hover:text-error rounded transition-default shrink-0"
                          title={
                            deleteAction === 'deactivate'
                              ? t('connectors.deactivate_confirm')
                              : t('connectors.delete_confirm')
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Masked credentials and webhook URL */}
                      {conn.config && Object.keys(conn.config).length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1 border-t border-default">
                          {Object.entries(conn.config).map(([key, value]) => {
                            if (typeof value !== 'string' || !value) return null;
                            const isUrl =
                              key.toLowerCase().includes('url') ||
                              key.toLowerCase().includes('webhook');
                            return (
                              <div key={key} className="flex items-center gap-1.5 text-xs">
                                {isUrl ? <Link className="w-3 h-3 text-muted shrink-0" /> : null}
                                <span className="text-muted">{key}:</span>
                                <code className="bg-background-muted px-1 py-0.5 rounded font-mono text-foreground">
                                  {isUrl ? value : maskValue(value)}
                                </code>
                                <button
                                  onClick={() =>
                                    copyToClipboard(value, t('connectors.copied_to_clipboard'))
                                  }
                                  className="p-0.5 text-muted hover:text-foreground transition-default"
                                  title="Copy"
                                >
                                  <Copy className="w-3 h-3" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Connection Dialog */}
      <AddConnectionDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSubmit={createConnection}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t(
          deleteTargetAction === 'deactivate'
            ? 'connectors.deactivate_connection_title'
            : 'connectors.delete_connection_title',
        )}
        description={t(
          deleteTargetAction === 'deactivate'
            ? 'connectors.deactivate_connection_description'
            : 'connectors.delete_connection_description',
          { name: deleteTarget?.name ?? '' },
        )}
        confirmLabel={t(
          deleteTargetAction === 'deactivate'
            ? 'connectors.deactivate_confirm'
            : 'connectors.delete_confirm',
        )}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}

// =============================================================================
// SDK Channels Tab
// =============================================================================

function SDKChannelsTab() {
  const t = useTranslations('admin');
  const { channels, isLoading, mutate, createChannel, updateChannel, deleteChannel } =
    useSDKChannels();

  const [deleteTarget, setDeleteTarget] = useState<SDKChannel | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editTarget, setEditTarget] = useState<SDKChannel | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteChannel(deleteTarget.id);
      toast.success(t('connectors.channel_deleted'));
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('connectors.channel_delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCreateOrUpdate = async (input: CreateSDKChannelInput) => {
    if (editTarget) {
      await updateChannel(editTarget.id, {
        name: input.name,
        environment: input.environment,
        enabled: input.enabled,
        rateLimitRpm: input.rateLimitRpm,
        allowedOrigins: input.allowedOrigins,
      });
    } else {
      await createChannel(input);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted">
            {t('connectors.channel_count', {
              count: channels.length,
            })}
          </p>
          <button
            onClick={() => mutate()}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <Button
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => setShowAddDialog(true)}
        >
          {t('connectors.add_channel_button')}
        </Button>
      </div>

      {channels.length === 0 ? (
        <EmptyState
          icon={<Code className="w-6 h-6" />}
          title={t('connectors.channels_empty_title')}
          description={t('connectors.channels_empty_description')}
        />
      ) : (
        <div className="rounded-xl border border-default overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-background-muted border-b border-default">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('connectors.col_name')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('connectors.col_environment')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('connectors.col_api_key')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('connectors.col_rate_limit')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('connectors.col_status')}
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted uppercase tracking-wider">
                  {t('connectors.col_actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {channels.map((ch) => (
                <tr key={ch.id} className="hover:bg-background-muted transition-default">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{ch.name}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="info">{ch.environment}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded text-foreground font-mono">
                        {ch.apiKey ?? 'N/A'}
                      </code>
                      <button
                        onClick={() => {
                          if (!ch.apiKey) {
                            return;
                          }
                          copyToClipboard(ch.apiKey, t('connectors.copied_to_clipboard'));
                        }}
                        className="p-0.5 text-muted hover:text-foreground transition-default disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Copy API Key Prefix"
                        disabled={!ch.apiKey}
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted text-xs">
                    {ch.rateLimitRpm ? `${ch.rateLimitRpm} RPM` : t('connectors.unlimited')}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={ch.enabled ? 'success' : 'default'} dot>
                      {ch.enabled ? t('connectors.enabled') : t('connectors.disabled')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setEditTarget(ch)}
                        className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(ch)}
                        className="p-1.5 text-muted hover:text-error rounded transition-default"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add SDK Channel Dialog */}
      <SDKChannelDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSubmit={handleCreateOrUpdate}
      />

      {/* Edit SDK Channel Dialog */}
      {editTarget && (
        <SDKChannelDialog
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          onSubmit={handleCreateOrUpdate}
          initial={editTarget}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('connectors.delete_channel_title')}
        description={t('connectors.delete_channel_description', {
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('connectors.delete_confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export function ConnectorsPage() {
  const t = useTranslations('admin');
  const [activeTab, setActiveTab] = useState('connections');

  const tabs = [
    {
      id: 'connections',
      label: t('connectors.tabs.connections'),
      icon: <Plug className="w-4 h-4" />,
    },
    {
      id: 'sdk-channels',
      label: t('connectors.tabs.sdk_channels'),
      icon: <Code className="w-4 h-4" />,
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <PageHeader title={t('connectors.title')} description={t('connectors.description')} />

        <div className="mt-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            layoutId="connectors-tabs"
          />
        </div>

        <div className="mt-6">
          {activeTab === 'connections' && <ChannelConnectionsTab />}
          {activeTab === 'sdk-channels' && <SDKChannelsTab />}
        </div>
      </div>
    </div>
  );
}
