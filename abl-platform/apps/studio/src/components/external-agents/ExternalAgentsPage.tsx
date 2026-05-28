'use client';

/**
 * ExternalAgentsPage
 *
 * List page for external agent configurations within a project.
 * Supports registration, inline test-connection, edit panel, and deletion.
 */

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, Plus, RotateCcw, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ErrorAlert } from '../ui/ErrorAlert';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu';
import { DataTable, type Column } from '../ui/DataTable';
import { SkeletonTable } from '../ui/Skeleton';
import { RegisterExternalAgentModal } from './RegisterExternalAgentModal';
import { ExternalAgentEditPanel } from './ExternalAgentEditPanel';
import {
  fetchExternalAgents,
  deleteExternalAgent,
  testExternalAgentConnection,
  type ExternalAgentConfig,
} from '../../api/external-agents';
import { sanitizeErrors } from '../../lib/sanitize-error';

export function ExternalAgentsPage() {
  const t = useTranslations('externalAgents');
  const projectId = useNavigationStore((s) => s.projectId);

  const [agents, setAgents] = useState<ExternalAgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string[] | null>(null);

  // Modal / panel state
  const [registerOpen, setRegisterOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<ExternalAgentConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExternalAgentConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Track which agents are currently being tested
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  // ─── Load ─────────────────────────────────────────────────────────────
  const loadAgents = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchExternalAgents(projectId);
      setAgents(res.data);
    } catch (err: unknown) {
      setError(sanitizeErrors(err, 'Failed to load external agents'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // ─── Test Connection ──────────────────────────────────────────────────
  const handleTestConnection = useCallback(
    async (agent: ExternalAgentConfig) => {
      if (!projectId) return;
      setTestingIds((prev) => new Set(prev).add(agent.id));
      try {
        const res = await testExternalAgentConnection(projectId, agent.id);
        // Update the agent in list with fresh data from server
        setAgents((prev) => prev.map((a) => (a.id === agent.id ? res.data : a)));
      } catch (err: unknown) {
        // On error, mark as failed locally
        setAgents((prev) =>
          prev.map((a) =>
            a.id === agent.id
              ? {
                  ...a,
                  lastConnectionStatus: 'failed' as const,
                  lastConnectionError: err instanceof Error ? err.message : String(err),
                }
              : a,
          ),
        );
      } finally {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(agent.id);
          return next;
        });
      }
    },
    [projectId],
  );

  // ─── Delete ───────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!projectId || !deleteTarget) return;
    setDeleting(true);
    try {
      await deleteExternalAgent(projectId, deleteTarget.id);
      setAgents((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err: unknown) {
      setError(sanitizeErrors(err, 'Failed to delete external agent'));
    } finally {
      setDeleting(false);
    }
  }, [projectId, deleteTarget]);

  // ─── Callbacks from modal / panel ─────────────────────────────────────
  const handleRegistered = useCallback((agent: ExternalAgentConfig) => {
    setAgents((prev) => [agent, ...prev]);
    setRegisterOpen(false);
  }, []);

  const handleUpdated = useCallback((updated: ExternalAgentConfig) => {
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    setEditAgent(null);
  }, []);

  // ─── Status Badge ─────────────────────────────────────────────────────
  const statusBadge = useCallback(
    (agent: ExternalAgentConfig) => {
      let variant: BadgeVariant = 'default';
      let label = t('status_untested');

      if (agent.lastConnectionStatus === 'connected') {
        variant = 'success';
        label = t('status_connected');
      } else if (agent.lastConnectionStatus === 'failed') {
        variant = 'error';
        label = t('status_failed');
      }

      return (
        <Badge variant={variant} dot appearance="outlined">
          {label}
        </Badge>
      );
    },
    [t],
  );
  const columns: Column<ExternalAgentConfig>[] = [
    {
      key: 'name',
      label: t('columns.name'),
      render: (agent) => (
        <div>
          <span className="font-medium text-foreground">{agent.displayName ?? agent.name}</span>
          {agent.displayName && <span className="ml-2 text-xs text-muted">{agent.name}</span>}
        </div>
      ),
      sortable: true,
      sortValue: (agent) => agent.displayName ?? agent.name,
    },
    {
      key: 'endpoint',
      label: t('columns.endpoint'),
      render: (agent) => (
        <span className="block min-w-0 max-w-xs truncate text-muted" title={agent.endpoint}>
          {agent.endpoint}
        </span>
      ),
      sortable: true,
      sortValue: (agent) => agent.endpoint,
    },
    {
      key: 'protocol',
      label: t('columns.protocol'),
      render: (agent) => (
        <Badge variant="default" appearance="outlined">
          {agent.protocol === 'a2a' ? t('protocol_a2a') : t('protocol_rest')}
        </Badge>
      ),
      sortable: true,
      sortValue: (agent) => agent.protocol,
    },
    {
      key: 'status',
      label: t('columns.status'),
      render: statusBadge,
      sortable: true,
      sortValue: (agent) => agent.lastConnectionStatus ?? '',
    },
    {
      key: 'auth',
      label: t('columns.auth'),
      render: (agent) => (
        <span className="text-muted">
          {agent.authType === 'none'
            ? t('auth_none')
            : agent.authType === 'bearer'
              ? t('auth_bearer')
              : t('auth_api_key')}
        </span>
      ),
      sortable: true,
      sortValue: (agent) => agent.authType,
    },
    {
      key: 'actions',
      label: t('columns.actions'),
      render: (agent) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            loading={testingIds.has(agent.id)}
            disabled={testingIds.has(agent.id)}
            onClick={() => handleTestConnection(agent)}
            aria-label={t('aria.test_connection', {
              name: agent.displayName ?? agent.name,
            })}
            icon={<RotateCcw className="w-3.5 h-3.5" />}
          >
            {testingIds.has(agent.id) ? t('testing_connection') : t('test_connection')}
          </Button>
          <DropdownMenu
            trigger={
              <Button
                variant="ghost"
                size="xs"
                aria-label={t('aria.actions_menu', {
                  name: agent.displayName ?? agent.name,
                })}
                icon={<MoreVertical className="w-3.5 h-3.5" />}
              />
            }
          >
            <DropdownMenuItem
              onSelect={() => setEditAgent(agent)}
              icon={<Pencil className="w-3.5 h-3.5" />}
            >
              {t('edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setDeleteTarget(agent)}
              variant="danger"
              icon={<Trash2 className="w-3.5 h-3.5" />}
            >
              {t('delete')}
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  // ─── Render ───────────────────────────────────────────────────────────
  if (!projectId) return null;

  return (
    <ListPageShell
      title={t('title')}
      description={t('description')}
      primaryAction={
        <Button icon={<Plus className="w-4 h-4" />} onClick={() => setRegisterOpen(true)}>
          {t('register')}
        </Button>
      }
      hidePrimaryAction={!loading && agents.length === 0}
    >
      {error && <ErrorAlert error={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <div className="rounded-xl border border-default p-3">
          <SkeletonTable rows={3} cols={6} />
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-6 h-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
          action={
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => setRegisterOpen(true)}>
              {t('register')}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-default">
          <DataTable columns={columns} data={agents} keyExtractor={(agent) => agent.id} />
        </div>
      )}

      {/* Register Modal */}
      <RegisterExternalAgentModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        projectId={projectId}
        onRegistered={handleRegistered}
      />

      {/* Edit Panel */}
      {editAgent && (
        <ExternalAgentEditPanel
          agent={editAgent}
          projectId={projectId}
          onClose={() => setEditAgent(null)}
          onUpdated={handleUpdated}
        />
      )}

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('delete_title')}
        description={t('delete_description')}
        confirmLabel={t('delete_confirm')}
        variant="danger"
        loading={deleting}
      />
    </ListPageShell>
  );
}
