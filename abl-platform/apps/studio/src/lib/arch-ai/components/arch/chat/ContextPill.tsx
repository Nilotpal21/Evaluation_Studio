'use client';

import { useMemo } from 'react';
import { MapPin } from 'lucide-react';
import { buildPageContext } from '@/lib/arch-ai/build-page-context';

/**
 * ContextPill — subtle indicator showing what page context Arch currently sees.
 * B02: Page Context Awareness — UX Design: visible but not loud, below chat input.
 */

const ENTITY_LABELS: Record<string, string> = {
  agent: 'Agent Editor',
  trace: 'Trace Viewer',
  session: 'Session',
  topology_node: 'Topology',
  topology_edge: 'Topology Edge',
};

const PAGE_LABELS: Record<string, string> = {
  agents: 'Agents',
  sessions: 'Sessions',
  dashboard: 'Dashboard',
  tools: 'Tools',
  deployments: 'Deployments',
  'search-ai': 'SearchAI',
  workflows: 'Workflows',
  'guardrails-config': 'Guardrails',
  'settings-api-keys': 'API Keys',
  'settings-models': 'Models',
  'settings-members': 'Members',
};

export function ContextPill() {
  const context = useMemo(() => buildPageContext(), []);

  if (!context) return null;

  const entityName = context.entity?.name ?? context.entity?.id;
  const entityType = context.entity?.type ? ENTITY_LABELS[context.entity.type] : null;
  const pageLabel = PAGE_LABELS[context.page] ?? context.page;

  const label = entityName ? `${entityName} · ${entityType ?? pageLabel}` : pageLabel;

  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-foreground-muted/60"
      aria-live="polite"
      aria-label={`Current context: ${label}`}
    >
      <MapPin className="h-3 w-3 text-foreground-muted/40" />
      <span className="truncate max-w-[280px]">{label}</span>
    </div>
  );
}
