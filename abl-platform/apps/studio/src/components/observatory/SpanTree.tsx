'use client';

/**
 * SpanTree Component
 *
 * Displays a hierarchical tree view of spans showing parent-child relationships,
 * timing information, status indicators, decision event rendering, cost column,
 * and token breakdown tooltip.
 */

import { useState, useCallback, useMemo, useEffect, memo } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Clock,
  Activity,
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  DollarSign,
} from 'lucide-react';
import { useObservatoryStore } from '../../store/observatory-store';
import type { SpanTreeNode, Span, ExtendedTraceEvent } from '../../types';
import clsx from 'clsx';
import { formatDuration, formatCost } from '../analytics/shared';
import { DecisionCard } from './DecisionCard';
import { getDecisionEvents, getSpanLlmMetrics } from '../../features/observatory/metrics';
import {
  collectAllSpanIds,
  collectVisibleSpanIds,
  findAncestorSpanIds,
  hasDescendantSpan,
} from '../../features/observatory/selectors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COST_THRESHOLD_GREEN = 0.01;
const COST_THRESHOLD_YELLOW = 0.1;
const STALE_SPAN_THRESHOLD_MS = 60_000; // 60s — spans running longer are likely orphaned

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCostColor(cost: number): string {
  if (cost < COST_THRESHOLD_GREEN) return 'text-success';
  if (cost < COST_THRESHOLD_YELLOW) return 'text-warning';
  return 'text-error';
}

/**
 * Group consecutive sibling spans that share the same name AND status into
 * runs. Runs of 3+ render as a single collapsed row with a count chip; runs
 * of 1–2 render as individual nodes. Only consecutive matches collapse so
 * order is preserved — `[check pass, check pass, tool, check pass]` keeps
 * the trailing check separate.
 *
 * Audit reference: Theme 23 (Studio UI/UX audit, 2026-04-25).
 */
export const RUN_COLLAPSE_THRESHOLD = 3;

export type ChildEntry =
  | { kind: 'single'; node: SpanTreeNode }
  | { kind: 'run'; key: string; nodes: SpanTreeNode[] };

export function groupConsecutiveSimilarChildren(children: readonly SpanTreeNode[]): ChildEntry[] {
  if (children.length === 0) return [];

  const out: ChildEntry[] = [];
  let runStart = 0;

  const flushRun = (endExclusive: number) => {
    const runLength = endExclusive - runStart;
    if (runLength >= RUN_COLLAPSE_THRESHOLD) {
      const nodes = children.slice(runStart, endExclusive);
      out.push({
        kind: 'run',
        key: `run-${nodes[0].span.spanId}`,
        nodes,
      });
    } else {
      for (let i = runStart; i < endExclusive; i += 1) {
        out.push({ kind: 'single', node: children[i] });
      }
    }
  };

  for (let i = 1; i <= children.length; i += 1) {
    const prev = children[i - 1].span;
    const curr = i < children.length ? children[i].span : null;
    const isSameRun = curr !== null && curr.name === prev.name && curr.status === prev.status;
    if (!isSameRun) {
      flushRun(i);
      runStart = i;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SpanTreeProps {
  className?: string;
}

export function SpanTree({ className }: SpanTreeProps) {
  const getSpanTree = useObservatoryStore((state) => state.getSpanTree);
  const spans = useObservatoryStore((state) => state.spans);
  const selectSpan = useObservatoryStore((state) => state.selectSpan);
  const events = useObservatoryStore((state) => state.events);
  const selectedSpanId = useObservatoryStore((state) => state.selection.spanId);
  const [collapsedSpanIds, setCollapsedSpanIds] = useState<Set<string>>(() => new Set());

  const roots = useMemo(() => getSpanTree(), [getSpanTree, spans]);
  const hasLegacyEvents = useMemo(() => events.some((e) => !e.spanId), [events]);
  const allSpanIds = useMemo(() => collectAllSpanIds(roots), [roots]);
  const flatSpanIds = useMemo(
    () => collectVisibleSpanIds(roots, collapsedSpanIds),
    [roots, collapsedSpanIds],
  );

  useEffect(() => {
    setCollapsedSpanIds((current) => {
      let changed = false;
      const next = new Set<string>();

      for (const spanId of current) {
        if (allSpanIds.has(spanId)) {
          next.add(spanId);
        } else {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [allSpanIds]);

  useEffect(() => {
    if (!selectedSpanId) return;

    const ancestorSpanIds = findAncestorSpanIds(roots, selectedSpanId);
    if (!ancestorSpanIds || ancestorSpanIds.length === 0) {
      return;
    }

    setCollapsedSpanIds((current) => {
      let changed = false;
      const next = new Set(current);

      for (const ancestorSpanId of ancestorSpanIds) {
        if (next.delete(ancestorSpanId)) {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [roots, selectedSpanId]);

  const handleToggleCollapse = useCallback(
    (node: SpanTreeNode) => {
      const spanId = node.span.spanId;
      const isCollapsed = collapsedSpanIds.has(spanId);

      if (
        !isCollapsed &&
        selectedSpanId &&
        selectedSpanId !== spanId &&
        hasDescendantSpan(node, selectedSpanId)
      ) {
        selectSpan(spanId);
      }

      setCollapsedSpanIds((current) => {
        const next = new Set(current);
        if (next.has(spanId)) {
          next.delete(spanId);
        } else {
          next.add(spanId);
        }
        return next;
      });
    },
    [collapsedSpanIds, selectedSpanId, selectSpan],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatSpanIds.length === 0) return;

      const currentIdx = selectedSpanId ? flatSpanIds.indexOf(selectedSpanId) : -1;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const nextIdx = currentIdx < flatSpanIds.length - 1 ? currentIdx + 1 : 0;
          selectSpan(flatSpanIds[nextIdx]);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prevIdx = currentIdx > 0 ? currentIdx - 1 : flatSpanIds.length - 1;
          selectSpan(flatSpanIds[prevIdx]);
          break;
        }
        case 'Escape': {
          e.preventDefault();
          selectSpan(null);
          break;
        }
      }
    },
    [flatSpanIds, selectedSpanId, selectSpan],
  );

  if (roots.length === 0) {
    return (
      <div className={clsx('flex items-center justify-center text-muted text-sm p-8', className)}>
        <p className="text-center">
          No spans recorded yet.
          <br />
          <span className="text-xs">Start a conversation to see the span hierarchy.</span>
        </p>
      </div>
    );
  }

  return (
    <div
      className={clsx('p-2 space-y-1', className)}
      role="tree"
      aria-label="Span hierarchy"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {hasLegacyEvents && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1 rounded bg-warning-subtle text-warning text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Some events predate span tracking and may not appear in the tree.</span>
        </div>
      )}
      {roots.map((node) => (
        <MemoizedSpanNode
          key={node.span.spanId}
          node={node}
          selectedId={selectedSpanId}
          onSelect={selectSpan}
          collapsedSpanIds={collapsedSpanIds}
          onToggleCollapse={handleToggleCollapse}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SpanNode
// ---------------------------------------------------------------------------

interface SpanNodeProps {
  node: SpanTreeNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsedSpanIds: ReadonlySet<string>;
  onToggleCollapse: (node: SpanTreeNode) => void;
}

function SpanNode({
  node,
  selectedId,
  onSelect,
  collapsedSpanIds,
  onToggleCollapse,
}: SpanNodeProps) {
  const { span, children, depth } = node;
  const isSelected = selectedId === span.spanId;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsedSpanIds.has(span.spanId);
  const expanded = !isCollapsed;
  const llmMetrics = useMemo(() => getSpanLlmMetrics(span), [span]);
  const decisions = useMemo(() => getDecisionEvents(span), [span]);
  const cost = llmMetrics?.hasCost ? llmMetrics.cost : undefined;
  const tokens = llmMetrics?.hasTokens
    ? {
        promptTokens: llmMetrics.promptTokens,
        completionTokens: llmMetrics.completionTokens,
        totalTokens: llmMetrics.totalTokens,
      }
    : undefined;

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
          if (hasChildren && isCollapsed) {
            e.preventDefault();
            e.stopPropagation();
            onToggleCollapse(node);
          }
          break;
        case 'ArrowLeft':
          if (hasChildren && expanded) {
            e.preventDefault();
            e.stopPropagation();
            onToggleCollapse(node);
          }
          break;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          onSelect(isSelected ? null : span.spanId);
          break;
      }
    },
    [expanded, hasChildren, isCollapsed, isSelected, node, onSelect, onToggleCollapse, span.spanId],
  );

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleCollapse(node);
    },
    [node, onToggleCollapse],
  );

  const handleSelect = useCallback(() => {
    onSelect(isSelected ? null : span.spanId);
  }, [onSelect, isSelected, span.spanId]);

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={isSelected}
    >
      {/* Span header */}
      <div
        className={clsx(
          'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-default',
          'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none',
          isSelected ? 'bg-accent-subtle border border-accent/30' : 'hover:bg-background-muted',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleSelect}
        onKeyDown={handleRowKeyDown}
        tabIndex={0}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            onClick={handleToggleExpand}
            className="text-muted hover:text-foreground transition-default focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none rounded"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        ) : (
          <div className="w-4" />
        )}

        {/* Status icon */}
        <SpanStatusIcon status={span.status} startTime={span.startTime} />

        {/* Span name */}
        <span
          className="flex-1 text-sm font-medium text-foreground truncate max-w-[150px]"
          title={span.name}
        >
          {span.name}
        </span>

        {/* Decision badges (inline) */}
        {decisions.length > 0 && (
          <span className="flex items-center gap-1">
            {decisions.slice(0, 2).map((d: ExtendedTraceEvent) => (
              <DecisionBadge key={d.id} event={d} />
            ))}
            {decisions.length > 2 && (
              <span className="text-xs text-muted">+{decisions.length - 2}</span>
            )}
          </span>
        )}

        {/* Cost */}
        {cost !== undefined && (
          <TokenTooltip tokens={tokens}>
            <span className={clsx('text-xs flex items-center gap-0.5', getCostColor(cost))}>
              <DollarSign className="w-3 h-3" />
              {formatCost(cost)}
            </span>
          </TokenTooltip>
        )}

        {/* Duration */}
        {span.durationMs !== undefined && (
          <span className="text-xs text-muted flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDuration(span.durationMs)}
          </span>
        )}

        {/* Event count */}
        <span className="text-xs text-subtle">{span.events.length} events</span>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div role="group">
          {groupConsecutiveSimilarChildren(children).map((entry) =>
            entry.kind === 'single' ? (
              <MemoizedSpanNode
                key={entry.node.span.spanId}
                node={entry.node}
                selectedId={selectedId}
                onSelect={onSelect}
                collapsedSpanIds={collapsedSpanIds}
                onToggleCollapse={onToggleCollapse}
              />
            ) : (
              <SpanRunGroup
                key={entry.key}
                nodes={entry.nodes}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                collapsedSpanIds={collapsedSpanIds}
                onToggleCollapse={onToggleCollapse}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SpanRunGroup — collapses a run of identical sibling spans
// ---------------------------------------------------------------------------

interface SpanRunGroupProps {
  nodes: SpanTreeNode[];
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsedSpanIds: ReadonlySet<string>;
  onToggleCollapse: (node: SpanTreeNode) => void;
}

function SpanRunGroup({
  nodes,
  depth,
  selectedId,
  onSelect,
  collapsedSpanIds,
  onToggleCollapse,
}: SpanRunGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const first = nodes[0].span;
  const containsSelection = useMemo(
    () => (selectedId ? nodes.some((n) => n.span.spanId === selectedId) : false),
    [nodes, selectedId],
  );

  // Auto-expand the run if a descendant is selected so the user can see it.
  useEffect(() => {
    if (containsSelection) setExpanded(true);
  }, [containsSelection]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  if (expanded) {
    return (
      <div role="group">
        <div
          className="flex items-center gap-1 text-xs text-subtle"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <button
            type="button"
            onClick={handleToggle}
            className="flex items-center gap-1 px-1 py-0.5 rounded hover:text-foreground hover:bg-background-muted transition-default focus-visible:ring-2 focus-visible:ring-border-focus outline-none"
            aria-label={`Collapse ${nodes.length} repeated ${first.name} spans`}
          >
            <ChevronDown className="w-3.5 h-3.5" />
            <span>{nodes.length} repeated</span>
          </button>
        </div>
        {nodes.map((node) => (
          <MemoizedSpanNode
            key={node.span.spanId}
            node={node}
            selectedId={selectedId}
            onSelect={onSelect}
            collapsedSpanIds={collapsedSpanIds}
            onToggleCollapse={onToggleCollapse}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      role="treeitem"
      aria-expanded={false}
      className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-muted hover:bg-background-muted transition-default"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={handleToggle}
      title={`Expand ${nodes.length} consecutive ${first.name} spans`}
    >
      <ChevronRight className="w-4 h-4" />
      <SpanStatusIcon status={first.status} startTime={first.startTime} />
      <span className="text-sm font-medium text-foreground truncate" title={first.name}>
        {first.name}
      </span>
      <span className="text-xs px-1.5 py-0.5 rounded-full bg-background-muted text-muted">
        × {nodes.length}
      </span>
      <span className="text-xs text-subtle ml-auto">consecutive identical</span>
    </div>
  );
}

const MemoizedSpanNode = memo(SpanNode);

// ---------------------------------------------------------------------------
// SpanStatusIcon — with AlertTriangle for warnings
// ---------------------------------------------------------------------------

const SpanStatusIcon = memo(function SpanStatusIcon({
  status,
  startTime,
}: {
  status: Span['status'];
  startTime: Date;
}) {
  switch (status) {
    case 'running': {
      const elapsed = Date.now() - new Date(startTime).getTime();
      if (elapsed > STALE_SPAN_THRESHOLD_MS) {
        return (
          <span title="Span appears stale">
            <AlertTriangle className="w-4 h-4 text-warning" />
          </span>
        );
      }
      return <Loader2 className="w-4 h-4 text-info animate-spin" />;
    }
    case 'completed':
      return <CheckCircle className="w-4 h-4 text-success" />;
    case 'error':
      return <XCircle className="w-4 h-4 text-error" />;
    default:
      return <Activity className="w-4 h-4 text-muted" />;
  }
});

// ---------------------------------------------------------------------------
// DecisionBadge — renders decision event type inline
// ---------------------------------------------------------------------------

const DecisionBadge = memo(function DecisionBadge({ event }: { event: ExtendedTraceEvent }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs">
      <DecisionCard data={event.data} compact />
    </span>
  );
});

// ---------------------------------------------------------------------------
// TokenTooltip — hover to see token breakdown
// ---------------------------------------------------------------------------

function TokenTooltip({
  tokens,
  children,
}: {
  tokens:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);

  if (!tokens) {
    return <>{children}</>;
  }

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span className="absolute z-50 bottom-full mb-1.5 left-1/2 -translate-x-1/2 px-2.5 py-1.5 rounded-md shadow-md bg-foreground text-background text-xs whitespace-nowrap animate-fade-in">
          <span className="block">Prompt: {tokens.promptTokens.toLocaleString()}</span>
          <span className="block">Completion: {tokens.completionTokens.toLocaleString()}</span>
          <span className="block font-medium">Total: {tokens.totalTokens.toLocaleString()}</span>
        </span>
      )}
    </span>
  );
}
