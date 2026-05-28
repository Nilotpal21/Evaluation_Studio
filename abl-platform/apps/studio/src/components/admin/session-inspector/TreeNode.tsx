'use client';

import { ChevronRight, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { formatDuration, formatCost } from '@/components/analytics/shared';
import { useSessionInspectorStore } from '@/store/session-inspector-store';
import type { TreeNode as TreeNodeType } from './types';

const SPAN_COLORS: Record<string, string> = {
  phase: 'text-info',
  turn: 'text-accent-foreground',
  llm_call: 'text-success',
  tool_call: 'text-warning',
};

const SPAN_BG: Record<string, string> = {
  phase: 'bg-info/5',
  turn: 'bg-accent/5',
  llm_call: 'bg-success/5',
  tool_call: 'bg-warning/5',
};

interface TreeNodeProps {
  node: TreeNodeType;
  depth: number;
}

export function TreeNodeComponent({ node, depth }: TreeNodeProps) {
  const { expandedNodes, toggleNode, openDrawer } = useSessionInspectorStore();
  const expanded = expandedNodes.has(node.event.eventId);
  const hasChildren = node.children.length > 0;
  const spanColor = SPAN_COLORS[node.event.spanKind] ?? 'text-muted-foreground';
  const spanBg = SPAN_BG[node.event.spanKind] ?? '';

  return (
    <div>
      <div
        className={clsx(
          'group flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer hover:bg-muted/50 transition-colors',
          spanBg,
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <button
          type="button"
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center"
          onClick={() => hasChildren && toggleNode(node.event.eventId)}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5" />
          )}
        </button>

        <button
          type="button"
          className="flex-1 flex items-center gap-2 text-left min-w-0"
          onClick={() => openDrawer(node.event.eventId)}
        >
          <span className={clsx('text-[10px] font-mono uppercase', spanColor)}>
            {node.event.spanKind || node.event.category}
          </span>
          <span className="text-xs text-foreground truncate">{node.event.summary}</span>
        </button>

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-shrink-0">
          {node.event.durationMs != null && node.event.durationMs > 0 && (
            <span>{formatDuration(node.event.durationMs)}</span>
          )}
          {node.event.tokens && <span>{node.event.tokens.total} tok</span>}
          {node.event.tokens && node.event.tokens.estimatedCost > 0 && (
            <span>{formatCost(node.event.tokens.estimatedCost)}</span>
          )}
          {node.event.severity === 'error' && <span className="text-error font-medium">ERR</span>}
        </div>
      </div>

      {expanded &&
        node.children.map((child) => (
          <TreeNodeComponent key={child.event.eventId} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}
