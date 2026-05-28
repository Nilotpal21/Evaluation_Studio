'use client';

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { ConnectionSummary } from '../../api/connections';
import type { AuthProfileStatus } from '../../api/auth-profiles';
import { ConnectorLogo } from './ConnectorLogo';

interface ConnectionCardProps {
  connection: ConnectionSummary;
  isExpanded: boolean;
  onClick: () => void;
  agentCount?: number;
  /** Display name of the linked auth profile. */
  authProfileName?: string | null;
  /** Status of the linked auth profile. null = profile not found. */
  authProfileStatus?: AuthProfileStatus | null;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

function getHealthColor(
  connection: ConnectionSummary,
  authProfileStatus?: AuthProfileStatus | null,
): string {
  // Auth profile missing or unhealthy takes priority
  if (authProfileStatus === null) return 'bg-error';
  if (authProfileStatus && authProfileStatus !== 'active') return 'bg-error';
  if (connection.status === 'revoked') return 'bg-error';
  if (connection.status === 'active') return 'bg-success';
  return 'bg-muted';
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < SECONDS_PER_MINUTE) return 'just now';
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  return `${days}d ago`;
}

export function ConnectionCard({
  connection,
  isExpanded,
  onClick,
  agentCount = 0,
  authProfileName,
  authProfileStatus,
}: ConnectionCardProps) {
  return (
    <motion.button
      onClick={onClick}
      className={clsx(
        'group relative w-full rounded-xl border p-4 text-left transition-colors duration-150',
        isExpanded
          ? 'border-accent bg-background-elevated'
          : 'border-default bg-background hover:border-accent',
      )}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <ConnectorLogo name={connection.connectorName} className="h-8 w-8" />
          <div>
            <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
            <p className="text-xs text-muted">
              {connection.connectorName}
              {authProfileName && (
                <>
                  {' · '}
                  <span className="text-subtle">{authProfileName}</span>
                </>
              )}
            </p>
          </div>
        </div>
        <span
          className={clsx(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            getHealthColor(connection, authProfileStatus),
          )}
        />
      </div>
      <p className="mt-3 text-xs text-muted">
        {agentCount > 0 ? `${agentCount} agent${agentCount !== 1 ? 's' : ''}` : 'No agents'}{' '}
        &middot; {formatRelativeTime(connection.updatedAt)}
      </p>
    </motion.button>
  );
}
