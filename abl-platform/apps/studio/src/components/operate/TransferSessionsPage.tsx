'use client';

/**
 * TransferSessionsPage
 *
 * Table-based monitoring page for active agent transfer sessions.
 * Uses SWR-based polling (30s) via useTransferSessions hook.
 */

import { useState, useCallback, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ListPageShell } from '../ui/ListPageShell';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { useTransferSessions } from '../../hooks/useTransferSessions';
import { endTransferSession, type TransferSession } from '../../api/agent-transfer';
import { useNavigationStore } from '../../store/navigation-store';
import { TransferSessionDetailModal } from './TransferSessionDetailModal';
import { sanitizeError } from '../../lib/sanitize-error';
import { useConnections } from '../../hooks/useConnections';
import { getProviderDef } from '../connections/agent-desktop-registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATUS_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = {
  pending: { label: 'Pending', variant: 'default' },
  queued: { label: 'Queued', variant: 'info' },
  active: { label: 'Active', variant: 'success' },
  post_agent: { label: 'Post-Agent', variant: 'warning' },
  ended: { label: 'Ended', variant: 'default' },
};

const ALL_PROVIDERS_OPTION = { value: '', label: 'All Providers' };

export const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'queued', label: 'Queued' },
  { value: 'active', label: 'Active' },
  { value: 'post_agent', label: 'Post-Agent' },
  { value: 'ended', label: 'Ended' },
];

export const CHANNEL_OPTIONS = [
  { value: '', label: 'All Channels' },
  { value: 'chat', label: 'Chat' },
  { value: 'voice', label: 'Voice' },
  { value: 'email', label: 'Email' },
  { value: 'messaging', label: 'Messaging' },
  { value: 'campaign', label: 'Campaign' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(createdAt: string, state: string, updatedAt?: string): string {
  const start = new Date(createdAt).getTime();
  if (isNaN(start)) return '\u2014';
  const end = state === 'ended' && updatedAt ? new Date(updatedAt).getTime() : Date.now();
  if (isNaN(end)) return '\u2014';
  const diffMs = end - start;
  const mins = Math.floor(diffMs / 60_000);
  const secs = Math.floor((diffMs % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TransferSessionsPage() {
  const projectId = useNavigationStore((s) => s.projectId);

  const { connections } = useConnections(projectId);
  const providerOptions = useMemo(() => {
    const configured = connections
      .map((c) => getProviderDef(c.connectorName))
      .filter((def): def is NonNullable<typeof def> => def !== undefined)
      .map((def) => ({ value: def.id, label: def.label }));
    return [ALL_PROVIDERS_OPTION, ...configured];
  }, [connections]);

  // Filters
  const [provider, setProvider] = useState('');
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');

  const filters = {
    provider: provider || undefined,
    state: status || undefined,
    channel: channel || undefined,
  };

  const { sessions, isLoading, error, refresh } = useTransferSessions(filters);

  // Detail modal
  const [selectedSession, setSelectedSession] = useState<TransferSession | null>(null);

  // End session confirmation
  const [endingSessionId, setEndingSessionId] = useState<string | null>(null);
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null);

  const handleEndSession = useCallback(
    async (sessionId: string) => {
      if (!projectId) return;
      setEndingSessionId(sessionId);
      try {
        await endTransferSession(projectId, sessionId);
        toast.success('Session ended successfully');
        refresh();
      } catch (err) {
        toast.error(sanitizeError(err, 'Failed to end session'));
      } finally {
        setEndingSessionId(null);
        setConfirmEndId(null);
      }
    },
    [projectId, refresh],
  );

  return (
    <>
      <ListPageShell
        title="Transfer Sessions"
        secondaryActions={
          <Button
            variant="secondary"
            icon={<RefreshCw className="w-4 h-4" />}
            onClick={() => refresh()}
            loading={isLoading}
          >
            Refresh
          </Button>
        }
        filters={[
          {
            id: 'provider',
            label: 'Provider',
            options: providerOptions,
            value: provider,
            onChange: setProvider,
          },
          {
            id: 'status',
            label: 'Status',
            options: STATUS_OPTIONS,
            value: status,
            onChange: setStatus,
          },
          {
            id: 'channel',
            label: 'Channel',
            options: CHANNEL_OPTIONS,
            value: channel,
            onChange: setChannel,
          },
        ]}
      >
        {error && (
          <div className="mb-4 p-3 text-sm text-error bg-error-subtle border border-error/20 rounded-lg">
            Failed to load sessions: {error}
          </div>
        )}

        {sessions.length === 0 && !isLoading ? (
          <EmptyState
            icon={<div className="w-6 h-6 rounded-full bg-accent/20 border border-accent/30" />}
            title="No active transfer sessions"
            description="Transfer sessions will appear here when agents escalate conversations to human agents."
          />
        ) : (
          <div className="border border-default rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-background-muted text-muted text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Contact</th>
                  <th className="text-left px-4 py-2.5 font-medium">Agent</th>
                  <th className="text-left px-4 py-2.5 font-medium">Provider</th>
                  <th className="text-left px-4 py-2.5 font-medium">Channel</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium">Queue</th>
                  <th className="text-left px-4 py-2.5 font-medium">Duration</th>
                  <th className="text-right px-4 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {sessions.map((session) => {
                  const statusCfg = STATUS_CONFIG[session.state] ?? STATUS_CONFIG.pending;
                  const isEnding = endingSessionId === session.id;
                  const isConfirming = confirmEndId === session.id;

                  return (
                    <tr
                      key={session.id}
                      className="hover:bg-background-muted/50 cursor-pointer transition-default"
                      onClick={() => setSelectedSession(session)}
                    >
                      <td className="px-4 py-3 font-mono text-xs truncate max-w-[160px]">
                        {session.contactId}
                      </td>
                      <td className="px-4 py-3">{session.agentName ?? session.agentId}</td>
                      <td className="px-4 py-3 capitalize">{session.provider}</td>
                      <td className="px-4 py-3 capitalize">{session.channel}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusCfg.variant} dot>
                          {statusCfg.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted">{session.queue ?? '-'}</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {formatDuration(session.createdAt, session.state, session.updatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isConfirming ? (
                          <span
                            className="inline-flex items-center gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              variant="danger"
                              size="xs"
                              loading={isEnding}
                              onClick={() => handleEndSession(session.id)}
                            >
                              Confirm
                            </Button>
                            <Button variant="ghost" size="xs" onClick={() => setConfirmEndId(null)}>
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <span onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={session.state === 'ended'}
                              onClick={() => setConfirmEndId(session.id)}
                            >
                              End
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ListPageShell>

      <TransferSessionDetailModal
        session={selectedSession}
        open={selectedSession !== null}
        onClose={() => setSelectedSession(null)}
        onEndSession={handleEndSession}
      />
    </>
  );
}
