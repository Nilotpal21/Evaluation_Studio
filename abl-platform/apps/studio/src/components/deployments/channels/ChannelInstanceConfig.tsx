/**
 * ChannelInstanceConfig — Level 3 of channel navigation.
 *
 * Full-width tabbed configuration shell for a single channel instance.
 * Loads instance data from the appropriate backend API based on the
 * instanceId prefix (sdk_, conn_, sub_), normalizes it into a unified
 * ChannelInstance, and renders conditional tabs based on channel capabilities.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import { ArrowLeft, Trash2, Pause, Play, AlertTriangle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { transitions } from '../../../lib/animation';

import { fetchChannels, deleteChannel, updateChannel } from '../../../api/channels';
import {
  fetchConnection,
  deleteConnection,
  updateConnection,
} from '../../../api/channel-connections';
import {
  fetchSubscriptions,
  deleteSubscription,
  updateSubscription,
} from '../../../api/http-async-channels';
import {
  resolveChannelDeleteAction,
  resolveChannelDeleteOutcome,
} from '../../../lib/channel-delete-behavior';
import { sanitizeError } from '../../../lib/sanitize-error';

import { Tabs } from '../../ui/Tabs';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { ConfirmDialog } from '../../ui/ConfirmDialog';

import { getChannelDef } from './channel-registry';
import { STATUS_BADGE_VARIANT, STATUS_LABEL, STATUS_DOT_COLOR } from './channel-utils';
import {
  normalizeSDKChannel,
  normalizeConnection,
  normalizeSubscription,
} from './channel-normalizer';
import { OverviewTab } from './tabs/OverviewTab';
import { CredentialsTab } from './tabs/CredentialsTab';
import { ConfigurationTab } from './tabs/ConfigurationTab';
import { DeploymentTab } from './tabs/DeploymentTab';
import { TestingTab } from './tabs/TestingTab';
import { ActivityTab } from './tabs/ActivityTab';
import type { ChannelTypeId, ChannelInstance, ChannelTypeDef, InstanceSource } from './types';

// =============================================================================
// PROPS
// =============================================================================

interface ChannelInstanceConfigProps {
  projectId: string;
  channelType: ChannelTypeId;
  instanceId: string;
  onBack: () => void;
  onExpanded?: (expanded: boolean) => void;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Determine the backend source from the normalized instance ID prefix. */
function resolveSource(instanceId: string): InstanceSource | null {
  if (instanceId.startsWith('sdk_')) return 'sdk_channel';
  if (instanceId.startsWith('conn_')) return 'channel_connection';
  if (instanceId.startsWith('sub_')) return 'webhook_subscription';
  return null;
}

/** Extract the raw backend ID from the prefixed instance ID. */
function extractSourceId(instanceId: string): string {
  if (instanceId.startsWith('sdk_')) return instanceId.slice(4);
  if (instanceId.startsWith('conn_')) return instanceId.slice(5);
  if (instanceId.startsWith('sub_')) return instanceId.slice(4);
  return instanceId;
}

// =============================================================================
// TAB DEFINITIONS
// =============================================================================

interface TabDef {
  id: string;
  label: string;
  isVisible: (capabilities: ChannelTypeDef['capabilities']) => boolean;
}

// TAB_DEFINITIONS is now defined inside the component to use i18n translations.

// =============================================================================
// LOADING SKELETON
// =============================================================================

function ConfigSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header skeleton */}
      <div className="flex items-center gap-3">
        <Skeleton className="w-8 h-8 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-1 border-b border-default pb-0">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-9 w-24 rounded-t-md" />
        ))}
      </div>

      {/* Content skeleton */}
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}

// =============================================================================
// ERROR STATE
// =============================================================================

function ErrorState({
  message,
  onBack,
  title,
  backLabel,
}: {
  message: string;
  onBack: () => void;
  title: string;
  backLabel: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center animate-fade-in">
      <div className="w-14 h-14 rounded-2xl bg-error-subtle flex items-center justify-center mb-4">
        <AlertTriangle className="w-6 h-6 text-error" />
      </div>
      <h3 className="text-base font-medium text-foreground mb-1">{title}</h3>
      <p className="text-sm text-muted max-w-sm mb-6">{message}</p>
      <Button variant="secondary" size="md" onClick={onBack}>
        {backLabel}
      </Button>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ChannelInstanceConfig({
  projectId,
  channelType,
  instanceId,
  onBack,
  onExpanded,
}: ChannelInstanceConfigProps) {
  const t = useTranslations('channels.instance_config');
  const channelDef = getChannelDef(channelType);

  const TAB_DEFINITIONS: TabDef[] = useMemo(
    (): TabDef[] => [
      { id: 'overview', label: t('tab_overview'), isVisible: () => true },
      { id: 'credentials', label: t('tab_credentials'), isVisible: (c) => c.hasCredentials },
      { id: 'configuration', label: t('tab_configuration'), isVisible: () => true },
      { id: 'deployment', label: t('tab_deployment'), isVisible: () => true },
      { id: 'testing', label: t('tab_testing'), isVisible: (c) => c.supportsTest },
      { id: 'activity', label: t('tab_activity'), isVisible: (c) => c.supportsDeliveryLog },
    ],
    [t],
  );

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [instance, setInstance] = useState<ChannelInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPauseToggling, setIsPauseToggling] = useState(false);

  // ---------------------------------------------------------------------------
  // Expanded viewport signal
  // ---------------------------------------------------------------------------

  useEffect(() => {
    onExpanded?.(true);
    return () => {
      onExpanded?.(false);
    };
  }, [onExpanded]);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadInstance = useCallback(async () => {
    setLoading(true);
    setError(null);

    const source = resolveSource(instanceId);
    const sourceId = extractSourceId(instanceId);

    if (!source) {
      setError(t('error_unknown_format', { id: instanceId }));
      setLoading(false);
      return;
    }

    try {
      let normalized: ChannelInstance | null = null;

      switch (source) {
        case 'sdk_channel': {
          const result = await fetchChannels(projectId);
          const match = result.channels.find((ch) => ch.id === sourceId);
          if (match) {
            normalized = normalizeSDKChannel(match);
          }
          break;
        }

        case 'channel_connection': {
          const result = await fetchConnection(projectId, sourceId);
          normalized = normalizeConnection(result.connection);
          break;
        }

        case 'webhook_subscription': {
          const result = await fetchSubscriptions(projectId);
          const match = result.subscriptions.find((s) => s.id === sourceId);
          if (match) {
            normalized = normalizeSubscription(match);
          }
          break;
        }
      }

      if (!normalized) {
        setError(t('error_not_found_id', { id: instanceId }));
      } else {
        setInstance(normalized);
      }
    } catch (err) {
      setError(sanitizeError(err, t('error_load_failed')));
    } finally {
      setLoading(false);
    }
  }, [projectId, instanceId]);

  useEffect(() => {
    loadInstance();
  }, [loadInstance]);

  // ---------------------------------------------------------------------------
  // Visible tabs (computed from channel capabilities)
  // ---------------------------------------------------------------------------

  const visibleTabs = useMemo(() => {
    return TAB_DEFINITIONS.filter((tab) => tab.isVisible(channelDef.capabilities)).map((tab) => ({
      id: tab.id,
      label: tab.label,
    }));
  }, [channelDef.capabilities]);

  // Ensure activeTab is valid when tabs change
  useEffect(() => {
    const tabIds = visibleTabs.map((t) => t.id);
    if (!tabIds.includes(activeTab)) {
      setActiveTab(tabIds[0] || 'overview');
    }
  }, [visibleTabs, activeTab]);

  // ---------------------------------------------------------------------------
  // Refresh handler (passed to tab components)
  // ---------------------------------------------------------------------------

  const handleRefresh = useCallback(() => {
    loadInstance();
  }, [loadInstance]);

  // ---------------------------------------------------------------------------
  // Delete handler
  // ---------------------------------------------------------------------------

  const handleDelete = useCallback(async () => {
    if (!instance) return;

    setIsDeleting(true);
    try {
      let deleteOutcome = resolveChannelDeleteOutcome({
        source: instance._source,
        status: instance.status,
      });

      switch (instance._source) {
        case 'sdk_channel':
          await deleteChannel(projectId, instance._sourceId);
          break;
        case 'channel_connection':
          deleteOutcome = (await deleteConnection(projectId, instance._sourceId)).outcome;
          break;
        case 'webhook_subscription':
          await deleteSubscription(instance._sourceId);
          break;
      }
      toast.success(
        deleteOutcome === 'deactivated' ? t('deactivate_success') : t('delete_success'),
      );
      setShowDeleteConfirm(false);
      onBack();
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setIsDeleting(false);
    }
  }, [instance, projectId, onBack]);

  // ---------------------------------------------------------------------------
  // Pause/Resume handler
  // ---------------------------------------------------------------------------

  const handlePauseToggle = useCallback(async () => {
    if (!instance) return;

    setIsPauseToggling(true);
    try {
      const isPaused = instance.status === 'paused' || instance.status === 'inactive';

      switch (instance._source) {
        case 'sdk_channel': {
          await updateChannel(projectId, instance._sourceId, {
            isActive: isPaused,
          });
          break;
        }
        case 'channel_connection': {
          await updateConnection(projectId, instance._sourceId, {
            status: isPaused ? 'active' : 'inactive',
          });
          break;
        }
        case 'webhook_subscription': {
          await updateSubscription(instance._sourceId, {
            status: isPaused ? 'active' : 'paused',
          });
          break;
        }
      }

      toast.success(isPaused ? t('channel_resumed') : t('channel_paused'));
      await loadInstance();
    } catch (err) {
      toast.error(sanitizeError(err, t('channel_status_failed')));
    } finally {
      setIsPauseToggling(false);
    }
  }, [instance, projectId, loadInstance]);

  // ---------------------------------------------------------------------------
  // Tab content renderer
  // ---------------------------------------------------------------------------

  const tabProps = useMemo(() => {
    if (!instance) return null;
    return {
      projectId,
      channelType,
      channelDef,
      instance,
      onRefresh: handleRefresh,
    };
  }, [projectId, channelType, channelDef, instance, handleRefresh]);

  function renderTabContent() {
    if (!tabProps) return null;

    switch (activeTab) {
      case 'overview':
        return <OverviewTab {...tabProps} />;
      case 'credentials':
        return <CredentialsTab {...tabProps} />;
      case 'configuration':
        return <ConfigurationTab {...tabProps} />;
      case 'deployment':
        return <DeploymentTab {...tabProps} />;
      case 'testing':
        return <TestingTab {...tabProps} />;
      case 'activity':
        return <ActivityTab {...tabProps} />;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Render: Loading
  // ---------------------------------------------------------------------------

  if (loading) {
    return <ConfigSkeleton />;
  }

  // ---------------------------------------------------------------------------
  // Render: Error
  // ---------------------------------------------------------------------------

  if (error || !instance) {
    return (
      <ErrorState
        message={error || t('error_not_found_default')}
        onBack={onBack}
        title={t('error_not_found_title')}
        backLabel={t('back_to_list')}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Main
  // ---------------------------------------------------------------------------

  const isPaused = instance.status === 'paused' || instance.status === 'inactive';
  const canPauseResume = channelDef.capabilities.supportsPauseResume;
  const deleteAction = resolveChannelDeleteAction({
    source: instance._source,
    status: instance.status,
  });

  return (
    <div className="space-y-0 animate-fade-in">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pb-4">
        {/* Back button */}
        <button
          onClick={onBack}
          className="p-1.5 text-muted hover:text-foreground rounded-lg hover:bg-background-muted transition-default"
          aria-label={t('back')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* Channel icon + name + env badge */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-accent shrink-0">{channelDef.icon}</span>
            <h3 className="text-sm font-semibold text-foreground truncate">
              {instance.displayName}
            </h3>
            {instance.environment && <Badge variant="accent">{instance.environment}</Badge>}
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={clsx(
                'w-1.5 h-1.5 rounded-full shrink-0',
                STATUS_DOT_COLOR[instance.status],
              )}
            />
            <span className="text-xs text-muted">{STATUS_LABEL[instance.status]}</span>
            <span className="text-xs text-subtle mx-1">&middot;</span>
            <span className="text-xs text-subtle">{channelDef.name}</span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {canPauseResume && (
            <Button
              variant="ghost"
              size="sm"
              icon={isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              onClick={handlePauseToggle}
              loading={isPauseToggling}
              aria-label={isPaused ? t('resume') : t('pause')}
            >
              {isPaused ? t('resume') : t('pause')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 className="w-4 h-4" />}
            onClick={() => setShowDeleteConfirm(true)}
            className="text-error hover:text-error hover:bg-error-subtle"
            aria-label={deleteAction === 'deactivate' ? t('deactivate') : t('delete')}
          />
        </div>
      </div>

      {/* ── Tabs bar ────────────────────────────────────────────────────── */}
      <Tabs
        tabs={visibleTabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        layoutId={`channel-config-tabs-${instanceId}`}
      />

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      <div className="pt-5">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={transitions.backdrop}
          >
            {renderTabContent()}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Delete confirmation ─────────────────────────────────────────── */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t(deleteAction === 'deactivate' ? 'deactivate_dialog_title' : 'delete_dialog_title')}
        description={t(
          deleteAction === 'deactivate'
            ? 'deactivate_dialog_description'
            : 'delete_dialog_description',
          { name: instance.displayName },
        )}
        confirmLabel={t(deleteAction === 'deactivate' ? 'deactivate_confirm' : 'delete_confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}
