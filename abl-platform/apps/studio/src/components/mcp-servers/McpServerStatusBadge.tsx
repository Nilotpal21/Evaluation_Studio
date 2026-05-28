/**
 * McpServerStatusBadge Component
 *
 * Badges for MCP server transport type and connection status.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import { Badge } from '../ui/Badge';
import type { BadgeVariant } from '../ui/Badge';

interface TransportBadgeProps {
  transport: string;
  className?: string;
}

export function TransportBadge({ transport, className }: TransportBadgeProps) {
  const t = useTranslations('mcp.status_badge');

  const TRANSPORT_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = useMemo(
    () => ({
      sse: { label: t('transport_sse'), variant: 'info' },
      http: { label: t('transport_http'), variant: 'accent' },
    }),
    [t],
  );

  const config = TRANSPORT_CONFIG[transport] || {
    label: transport,
    variant: 'default' as BadgeVariant,
  };
  return (
    <Badge variant={config.variant} className={className}>
      {config.label}
    </Badge>
  );
}

// ─── Connection Status Badge ─────────────────────────────────────────────

type ConnectionStatus = 'connected' | 'failed' | 'untested' | null;

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  className?: string;
}

export function ConnectionStatusBadge({ status, className }: ConnectionStatusBadgeProps) {
  const t = useTranslations('mcp.status_badge');

  const STATUS_CONFIG = useMemo(
    () => ({
      connected: {
        label: t('connected'),
        dotClass: 'bg-success',
        textClass: 'text-success',
      },
      failed: {
        label: t('failed'),
        dotClass: 'bg-error',
        textClass: 'text-error',
      },
      untested: {
        label: t('untested'),
        dotClass: 'bg-foreground-subtle',
        textClass: 'text-muted',
      },
    }),
    [t],
  );

  const config = STATUS_CONFIG[status || 'untested'] || STATUS_CONFIG.untested;
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', config.dotClass)} />
      <span className={config.textClass}>{config.label}</span>
    </span>
  );
}
