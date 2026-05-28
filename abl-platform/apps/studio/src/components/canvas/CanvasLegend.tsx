'use client';

import { EDGE_COLORS, EDGE_LABELS, type RelationshipType } from './edges/RelationshipEdge';

const LEGEND_ITEMS: { type: RelationshipType; dash: string }[] = [
  { type: 'handoff', dash: '' },
  { type: 'delegate', dash: '8 5' },
  { type: 'escalate', dash: '2 4' },
];

export function CanvasLegend() {
  return (
    <div className="absolute bottom-14 right-4 z-10 bg-background-elevated border border-default rounded-lg shadow-md px-3 py-2 space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-1">
        Relationships
      </p>
      {LEGEND_ITEMS.map(({ type, dash }) => (
        <div key={type} className="flex items-center gap-2">
          <svg width="32" height="8" className="shrink-0">
            <line
              x1="0"
              y1="4"
              x2="32"
              y2="4"
              stroke={EDGE_COLORS[type]}
              strokeWidth={2}
              strokeDasharray={dash || undefined}
            />
          </svg>
          <span className="text-xs text-foreground">{EDGE_LABELS[type]}</span>
        </div>
      ))}
    </div>
  );
}
