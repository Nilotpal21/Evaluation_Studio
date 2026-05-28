'use client';

/**
 * ExternalAgentCard — chat-surface widget for `external_agent_card` events.
 *
 * Mirrors `KBStatusCard.tsx` structure end-to-end (LLD §3.8 R2 HIGH-2):
 *   - first line: 'use client'
 *   - export shape: `memo(ExternalAgentCardImpl)`
 *   - conditional classes: `clsx` (no template literals)
 *   - prop name: `event: ExternalAgentCardEvent` (NOT `data` — KBStatusCard convention)
 *   - i18n: hardcoded English (chat surface convention; EditPanel keeps `t()`)
 *
 * The discovered AgentCard's skills are rendered via the shared `SkillChips`
 * component (single source of truth shared with `ExternalAgentEditPanel`).
 */

import { memo } from 'react';
import { clsx } from 'clsx';
import type { ExternalAgentCardEvent } from '@agent-platform/arch-ai';
import { SkillChips } from '@/components/external-agents/SkillChips';

interface ExternalAgentCardProps {
  event: ExternalAgentCardEvent;
}

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case 'connected':
      return 'text-success';
    case 'failed':
      return 'text-destructive';
    default:
      return 'text-foreground-muted';
  }
}

// Visual fit cap for endpoint URLs in the chat card (chosen to keep the
// pill on a single line at the card's typical ~360px width).
const ENDPOINT_DISPLAY_MAX = 48;

function truncateEndpoint(url: string, max = ENDPOINT_DISPLAY_MAX): string {
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function ExternalAgentCardImpl({ event }: ExternalAgentCardProps) {
  const status = event.lastConnectionStatus ?? 'unknown';
  const card = event.lastDiscoveredCard ?? null;
  const skills =
    card && Array.isArray((card as Record<string, unknown>).skills)
      ? ((card as Record<string, unknown>).skills as Array<Record<string, unknown>>)
      : [];

  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-medium">
            A2A
          </span>
          <h3 className="text-sm font-semibold text-foreground truncate">
            {event.displayName ?? event.name}
          </h3>
        </div>
        <span className={clsx('text-xs font-medium capitalize ml-2', statusColor(status))}>
          {status}
        </span>
      </div>

      <div className="space-y-2 mb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-foreground-muted">Endpoint</span>
          <code className="text-xs text-foreground truncate font-mono" title={event.endpoint}>
            {truncateEndpoint(event.endpoint)}
          </code>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-foreground-muted">Protocol</span>
          <span className="text-xs font-medium uppercase tracking-wide text-foreground">
            {event.protocol}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-foreground-muted">Auth</span>
          <span className="text-xs text-foreground">
            {event.authType}
            {event.authConfigured ? '' : ' (not configured)'}
          </span>
        </div>
        {typeof event.lastConnectionLatencyMs === 'number' && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground-muted">Latency</span>
            <span className="text-xs text-foreground tabular-nums">
              {event.lastConnectionLatencyMs}ms
            </span>
          </div>
        )}
        {event.lastConnectionError && (
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs text-foreground-muted shrink-0">Error</span>
            <span className="text-xs text-destructive truncate" title={event.lastConnectionError}>
              {event.lastConnectionError}
            </span>
          </div>
        )}
      </div>

      {skills.length > 0 && (
        <div className="border-t border-border pt-2">
          <span className="text-xs text-foreground-muted">Skills</span>
          <SkillChips skills={skills} max={6} />
        </div>
      )}
    </div>
  );
}

export const ExternalAgentCard = memo(ExternalAgentCardImpl);
