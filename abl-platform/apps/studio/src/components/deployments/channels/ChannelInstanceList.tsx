/**
 * ChannelInstanceList -- Level 2 of channel navigation.
 *
 * DataTable of instances for a specific channel type, with create and delete actions.
 * Fetches instances from the correct backend API based on channel category,
 * normalizes them into unified ChannelInstance records, and renders a sortable table.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { fetchChannels, deleteChannel } from '../../../api/channels';
import { fetchConnections, deleteConnection } from '../../../api/channel-connections';
import {
  fetchSubscriptions,
  deleteSubscription as deleteWebhookSubscription,
} from '../../../api/http-async-channels';
import {
  resolveChannelDeleteAction,
  resolveChannelDeleteOutcome,
} from '../../../lib/channel-delete-behavior';
import { sanitizeError } from '../../../lib/sanitize-error';

import { DataTable, type Column } from '../../ui/DataTable';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ConfirmDialog } from '../../ui/ConfirmDialog';

import { getChannelDef } from './channel-registry';
import {
  normalizeSDKChannel,
  normalizeConnection,
  normalizeSubscription,
} from './channel-normalizer';
import { CreateInstanceDialog } from './CreateInstanceDialog';
import type { ChannelTypeId, ChannelInstance, InstanceStatus } from './types';
import { WORKING_COPY_LABEL } from './channel-utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChannelInstanceListProps {
  projectId: string;
  channelType: ChannelTypeId;
  onBack: () => void;
  onSelectInstance: (instanceId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// timeAgo is now defined inside the component to use i18n translations.

/** Map ChannelTypeId to the SDK channelType string used by the backend. */
const SDK_TYPE_MAP: Partial<Record<ChannelTypeId, string[]>> = {
  sdk_web: ['web'],
  sdk_api: ['api'],
  sdk_mobile: ['mobile_ios', 'mobile_android'],
};

const STATUS_BADGE_VARIANT: Record<InstanceStatus, BadgeVariant> = {
  active: 'success',
  inactive: 'default',
  paused: 'warning',
  error: 'error',
};

// STATUS_LABEL is now defined inside the component to use i18n translations.

const MAX_IDENTIFIER_LENGTH = 20;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChannelInstanceList({
  projectId,
  channelType,
  onBack,
  onSelectInstance,
}: ChannelInstanceListProps) {
  const t = useTranslations('channels.instance_list');
  const def = getChannelDef(channelType);

  const STATUS_LABEL: Record<InstanceStatus, string> = {
    active: t('status_active'),
    inactive: t('status_inactive'),
    paused: t('status_paused'),
    error: t('status_error'),
  };

  function timeAgo(date: string | null): string {
    if (!date) return t('time_never');
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('time_just_now');
    if (mins < 60) return t('time_minutes_ago', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('time_hours_ago', { count: hours });
    const days = Math.floor(hours / 24);
    return t('time_days_ago', { count: days });
  }

  const [instances, setInstances] = useState<ChannelInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChannelInstance | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  // ── Fetch instances ─────────────────────────────────────────────────────

  const loadInstances = useCallback(async () => {
    setLoading(true);
    try {
      let normalized: ChannelInstance[] = [];

      switch (def.category) {
        case 'sdk': {
          const result = await fetchChannels(projectId);
          const allowedTypes = SDK_TYPE_MAP[channelType] ?? [];
          normalized = result.channels
            .filter((ch) => allowedTypes.includes(ch.channelType))
            .map(normalizeSDKChannel);
          break;
        }
        case 'messaging': {
          // The backend expects the raw channel type string (e.g. 'msteams')
          const result = await fetchConnections(projectId, channelType);
          normalized = result.connections.map(normalizeConnection);
          break;
        }
        case 'webhook': {
          const result = await fetchSubscriptions(projectId);
          normalized = result.subscriptions.map(normalizeSubscription);
          break;
        }
        case 'voice':
        case 'protocol': {
          // Voice and protocol channels use the channel-connections backend
          const connResult = await fetchConnections(projectId, channelType);
          normalized = connResult.connections.map(normalizeConnection);
          break;
        }
      }

      // Sort by updatedAt descending (most recent first)
      normalized.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setInstances(normalized);
    } catch (err) {
      console.error(`[ChannelInstanceList] Failed to load ${channelType} instances:`, err);
      toast.error(sanitizeError(err, t('load_failed', { name: def.name })));
    } finally {
      setLoading(false);
    }
  }, [projectId, channelType, def.category, def.name]);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  // ── Delete handler ──────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      let deleteOutcome = resolveChannelDeleteOutcome({
        source: deleteTarget._source,
        status: deleteTarget.status,
      });

      switch (deleteTarget._source) {
        case 'sdk_channel':
          await deleteChannel(projectId, deleteTarget._sourceId);
          break;
        case 'channel_connection':
          deleteOutcome = (await deleteConnection(projectId, deleteTarget._sourceId)).outcome;
          break;
        case 'webhook_subscription':
          await deleteWebhookSubscription(deleteTarget._sourceId);
          break;
      }
      toast.success(
        deleteOutcome === 'deactivated' ? t('deactivate_success') : t('delete_success'),
      );
      setDeleteTarget(null);
      await loadInstances();
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Table columns ───────────────────────────────────────────────────────

  const columns: Column<ChannelInstance>[] = [
    {
      key: 'name',
      label: t('column_name'),
      sortable: true,
      sortValue: (row) => row.displayName.toLowerCase(),
      render: (row) => (
        <span className="text-sm font-medium text-foreground truncate">{row.displayName}</span>
      ),
    },
    {
      key: 'status',
      label: t('column_status'),
      render: (row) => (
        <Badge variant={STATUS_BADGE_VARIANT[row.status]} dot>
          {STATUS_LABEL[row.status]}
        </Badge>
      ),
      width: 'w-28',
    },
    {
      key: 'environment',
      label: t('column_environment'),
      render: (row) =>
        row.environment ? (
          <Badge variant="accent">{row.environment}</Badge>
        ) : !row.deploymentId ? (
          <span className="text-xs text-muted">{WORKING_COPY_LABEL}</span>
        ) : (
          <span className="text-xs text-muted">&mdash;</span>
        ),
      width: 'w-32',
    },
    {
      key: 'identifier',
      label: t('column_identifier'),
      render: (row) =>
        row.externalIdentifier ? (
          <span className="text-xs text-muted font-mono truncate" title={row.externalIdentifier}>
            {row.externalIdentifier.length > MAX_IDENTIFIER_LENGTH
              ? `${row.externalIdentifier.slice(0, MAX_IDENTIFIER_LENGTH)}...`
              : row.externalIdentifier}
          </span>
        ) : (
          <span className="text-xs text-muted">&mdash;</span>
        ),
      width: 'w-40',
    },
    {
      key: 'updated',
      label: t('column_updated'),
      sortable: true,
      sortValue: (row) => new Date(row.updatedAt).getTime(),
      render: (row) => <span className="text-xs text-muted">{timeAgo(row.updatedAt)}</span>,
      width: 'w-28',
    },
    {
      key: 'actions',
      label: '',
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 className="w-4 h-4" />}
          onClick={(e) => {
            e.stopPropagation();
            setDeleteTarget(row);
          }}
          aria-label={
            resolveChannelDeleteAction({ source: row._source, status: row.status }) === 'deactivate'
              ? t('deactivate')
              : t('delete')
          }
        />
      ),
      width: 'w-12',
    },
  ];

  // ── Render ──────────────────────────────────────────────────────────────

  const deleteAction = deleteTarget
    ? resolveChannelDeleteAction({
        source: deleteTarget._source,
        status: deleteTarget.status,
      })
    : 'delete';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-1.5 text-muted hover:text-foreground rounded-lg hover:bg-background-muted transition-default"
          aria-label={t('back')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-accent">{def.icon}</span>
            <h3 className="text-sm font-semibold text-foreground">{def.name}</h3>
          </div>
          <p className="text-xs text-muted mt-0.5">{def.description}</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => setShowCreate(true)}
        >
          {t('new')}
        </Button>
      </div>

      {/* Setup guide (collapsible) */}
      {def.setupInstructions && (
        <details
          open={setupOpen}
          onToggle={(e) => setSetupOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="text-xs font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none">
            {t('setup_instructions')}
          </summary>
          <div className="mt-2 p-3 rounded-lg bg-background-subtle border border-default text-sm text-muted">
            {def.setupInstructions}
          </div>
        </details>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      ) : instances.length === 0 ? (
        <EmptyState
          icon={<span className="scale-150">{def.icon}</span>}
          title={t('no_connections_title', { name: def.name })}
          description={t('no_connections_description', { name: def.name })}
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowCreate(true)}
            >
              {t('create_connection')}
            </Button>
          }
        />
      ) : (
        <DataTable<ChannelInstance>
          columns={columns}
          data={instances}
          keyExtractor={(row) => row.id}
          onRowClick={(row) => onSelectInstance(row.id)}
        />
      )}

      {/* Create dialog */}
      <CreateInstanceDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        projectId={projectId}
        channelType={channelType}
        onCreated={loadInstances}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t(deleteAction === 'deactivate' ? 'deactivate_dialog_title' : 'delete_dialog_title')}
        description={t(
          deleteAction === 'deactivate'
            ? 'deactivate_dialog_description'
            : 'delete_dialog_description',
          { name: deleteTarget?.displayName ?? '' },
        )}
        confirmLabel={t(deleteAction === 'deactivate' ? 'deactivate_confirm' : 'delete_confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}
