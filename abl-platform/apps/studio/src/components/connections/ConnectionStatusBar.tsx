'use client';

import type { ConnectionSummary } from '../../api/connections';

interface ConnectionStatusBarProps {
  connections: ConnectionSummary[];
  catalogCount: number;
}

export function ConnectionStatusBar({ connections, catalogCount }: ConnectionStatusBarProps) {
  const active = connections.filter((c) => c.status === 'active').length;
  const failed = connections.filter((c) => c.status === 'revoked').length;

  const parts: string[] = [];
  if (active > 0) parts.push(`${active} connected`);
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`${catalogCount} available`);

  return <p className="text-sm text-muted">{parts.join(' · ')}</p>;
}
