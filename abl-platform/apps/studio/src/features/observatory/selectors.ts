import type { ExtendedTraceEvent, Span, SpanTreeNode } from '../../types';
import { buildSpanSummaries, buildSpanSummary, type SpanSummary } from './metrics';

export function selectSelectedSpan(
  spans: ReadonlyMap<string, Span>,
  selectedSpanId: string | null,
): Span | null {
  if (!selectedSpanId) {
    return null;
  }

  return spans.get(selectedSpanId) ?? null;
}

export function selectSpanSummaries(spans: ReadonlyMap<string, Span>): SpanSummary[] {
  return buildSpanSummaries(spans.values());
}

function getEventEndMs(event: ExtendedTraceEvent): number {
  return event.timestamp.getTime() + Math.max(event.durationMs ?? 0, 0);
}

function getEventStringData(event: ExtendedTraceEvent, key: string): string | undefined {
  const value = event.data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getEventBooleanData(event: ExtendedTraceEvent, key: string): boolean {
  return event.data[key] === true;
}

function resolveGroupedSpanName(events: ReadonlyArray<ExtendedTraceEvent>): string {
  for (const event of events) {
    const explicitName = getEventStringData(event, 'spanName');
    if (explicitName) {
      return explicitName;
    }
  }

  for (const event of events) {
    if (event.stepName) {
      return event.stepName;
    }
  }

  return events[0]?.type ?? 'span';
}

function resolveGroupedSpanEventType(events: ReadonlyArray<ExtendedTraceEvent>): string {
  for (const event of events) {
    const eventType = getEventStringData(event, 'eventType');
    if (eventType) {
      return eventType;
    }
  }

  return events[0]?.type ?? 'span';
}

function resolveGroupedSpanSummary(events: ReadonlyArray<ExtendedTraceEvent>): string | undefined {
  for (const event of events) {
    const summary = getEventStringData(event, 'summary');
    if (summary) {
      return summary;
    }
  }

  return undefined;
}

function resolveGroupedSpanStatus(events: ReadonlyArray<ExtendedTraceEvent>): Span['status'] {
  return events.some((event) => event.type === 'error' || getEventBooleanData(event, 'hasError'))
    ? 'error'
    : 'completed';
}

export function buildSpanSummariesFromEvents(events: Iterable<ExtendedTraceEvent>): SpanSummary[] {
  interface EventSpanGroup {
    agentName: string;
    endMs: number;
    events: ExtendedTraceEvent[];
    firstSeenOrder: number;
    parentSpanId?: string;
    sessionId: string;
    spanId: string;
    startMs: number;
    traceId: string;
  }

  const groups = new Map<string, EventSpanGroup>();
  let order = 0;

  for (const event of events) {
    const spanId = event.spanId;
    const eventStartMs = event.timestamp.getTime();
    const eventEndMs = getEventEndMs(event);
    const existingGroup = groups.get(spanId);

    if (!existingGroup) {
      groups.set(spanId, {
        agentName: event.agentName,
        endMs: eventEndMs,
        events: [event],
        firstSeenOrder: order,
        parentSpanId: event.parentSpanId,
        sessionId: event.sessionId,
        spanId,
        startMs: eventStartMs,
        traceId: event.traceId,
      });
      order += 1;
      continue;
    }

    existingGroup.events.push(event);
    existingGroup.startMs = Math.min(existingGroup.startMs, eventStartMs);
    existingGroup.endMs = Math.max(existingGroup.endMs, eventEndMs);

    if (!existingGroup.parentSpanId && event.parentSpanId) {
      existingGroup.parentSpanId = event.parentSpanId;
    }

    if (
      (!existingGroup.agentName || existingGroup.agentName === 'unknown') &&
      event.agentName &&
      event.agentName !== 'unknown'
    ) {
      existingGroup.agentName = event.agentName;
    }
  }

  return Array.from(groups.values())
    .sort(
      (left, right) => left.startMs - right.startMs || left.firstSeenOrder - right.firstSeenOrder,
    )
    .map((group) => {
      const orderedEvents = [...group.events].sort(
        (left, right) =>
          left.timestamp.getTime() - right.timestamp.getTime() ||
          getEventEndMs(left) - getEventEndMs(right),
      );
      const eventType = resolveGroupedSpanEventType(orderedEvents);
      const summaryText = resolveGroupedSpanSummary(orderedEvents);

      return buildSpanSummary({
        spanId: group.spanId,
        traceId: group.traceId,
        parentSpanId: group.parentSpanId,
        name: resolveGroupedSpanName(orderedEvents),
        startTime: new Date(group.startMs),
        endTime: new Date(group.endMs),
        durationMs: Math.max(group.endMs - group.startMs, 0),
        status: resolveGroupedSpanStatus(orderedEvents),
        agentName: group.agentName,
        sessionId: group.sessionId,
        events: orderedEvents,
        attributes: {
          eventType,
          summary: summaryText,
        },
      });
    });
}

export function collectAllSpanIds(nodes: ReadonlyArray<SpanTreeNode>): Set<string> {
  const spanIds = new Set<string>();

  const walk = (treeNodes: ReadonlyArray<SpanTreeNode>) => {
    for (const node of treeNodes) {
      spanIds.add(node.span.spanId);
      walk(node.children);
    }
  };

  walk(nodes);
  return spanIds;
}

export function collectVisibleSpanIds(
  nodes: ReadonlyArray<SpanTreeNode>,
  collapsedSpanIds: ReadonlySet<string>,
): string[] {
  const visibleSpanIds: string[] = [];

  const walk = (treeNodes: ReadonlyArray<SpanTreeNode>) => {
    for (const node of treeNodes) {
      visibleSpanIds.push(node.span.spanId);
      if (!collapsedSpanIds.has(node.span.spanId)) {
        walk(node.children);
      }
    }
  };

  walk(nodes);
  return visibleSpanIds;
}

export function findAncestorSpanIds(
  nodes: ReadonlyArray<SpanTreeNode>,
  targetSpanId: string,
  ancestors: string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.span.spanId === targetSpanId) {
      return ancestors;
    }

    const descendantAncestors = findAncestorSpanIds(node.children, targetSpanId, [
      ...ancestors,
      node.span.spanId,
    ]);
    if (descendantAncestors) {
      return descendantAncestors;
    }
  }

  return null;
}

export function hasDescendantSpan(node: SpanTreeNode, targetSpanId: string): boolean {
  return node.children.some(
    (child) => child.span.spanId === targetSpanId || hasDescendantSpan(child, targetSpanId),
  );
}

export interface SpanSummaryTreeNode {
  children: SpanSummaryTreeNode[];
  depth: number;
  summary: SpanSummary;
}

export interface SpanSummaryTimelineNode extends SpanSummaryTreeNode {
  children: SpanSummaryTimelineNode[];
  durationMs: number;
  endMs: number;
  endTime: Date;
  offsetMs: number;
  offsetPct: number;
  startMs: number;
  widthPct: number;
}

export interface SpanSummaryTimeline {
  endTime: Date | null;
  roots: ReadonlyArray<SpanSummaryTimelineNode>;
  startTime: Date | null;
  totalDurationMs: number;
}

export function buildSpanSummaryTree(
  summaries: ReadonlyArray<SpanSummary>,
): ReadonlyArray<SpanSummaryTreeNode> {
  const nodeMap = new Map<string, SpanSummaryTreeNode>();
  const roots: SpanSummaryTreeNode[] = [];
  const attachedSpanIds = new Set<string>();

  for (const summary of summaries) {
    if (!nodeMap.has(summary.span.spanId)) {
      nodeMap.set(summary.span.spanId, {
        summary,
        children: [],
        depth: 0,
      });
    }
  }

  for (const summary of summaries) {
    if (attachedSpanIds.has(summary.span.spanId)) {
      continue;
    }

    const node = nodeMap.get(summary.span.spanId);
    if (!node) {
      continue;
    }

    attachedSpanIds.add(summary.span.spanId);
    const parentSpanId = summary.span.parentSpanId;
    if (parentSpanId) {
      const parent = nodeMap.get(parentSpanId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }

    roots.push(node);
  }

  const assignDepth = (node: SpanSummaryTreeNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) {
      assignDepth(child, depth + 1);
    }
  };

  for (const root of roots) {
    assignDepth(root, 0);
  }

  return roots;
}

function resolveSpanSummaryEndMs(summary: SpanSummary): number {
  if (summary.span.endTime) {
    return summary.span.endTime.getTime();
  }

  const startMs = summary.span.startTime.getTime();
  const durationMs = Math.max(summary.span.durationMs ?? summary.latencyMs ?? 0, 0);
  return startMs + durationMs;
}

export function buildSpanSummaryTimeline(
  summaries: ReadonlyArray<SpanSummary>,
): SpanSummaryTimeline {
  if (summaries.length === 0) {
    return {
      startTime: null,
      endTime: null,
      totalDurationMs: 0,
      roots: [],
    };
  }

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const summary of summaries) {
    const summaryStartMs = summary.span.startTime.getTime();
    const summaryEndMs = resolveSpanSummaryEndMs(summary);
    startMs = Math.min(startMs, summaryStartMs);
    endMs = Math.max(endMs, summaryEndMs);
  }

  const totalDurationMs = Math.max(endMs - startMs, 0);

  const mapNode = (node: SpanSummaryTreeNode): SpanSummaryTimelineNode => {
    const nodeStartMs = node.summary.span.startTime.getTime();
    const nodeEndMs = resolveSpanSummaryEndMs(node.summary);
    const durationMs = Math.max(nodeEndMs - nodeStartMs, 0);

    return {
      ...node,
      children: node.children.map(mapNode),
      durationMs,
      endMs: nodeEndMs,
      endTime: new Date(nodeEndMs),
      offsetMs: nodeStartMs - startMs,
      offsetPct: totalDurationMs > 0 ? ((nodeStartMs - startMs) / totalDurationMs) * 100 : 0,
      startMs: nodeStartMs,
      widthPct: totalDurationMs > 0 ? (durationMs / totalDurationMs) * 100 : 100,
    };
  };

  return {
    startTime: new Date(startMs),
    endTime: new Date(endMs),
    totalDurationMs,
    roots: buildSpanSummaryTree(summaries).map(mapNode),
  };
}

export function flattenVisibleSpanSummaryTimelineNodes(
  nodes: ReadonlyArray<SpanSummaryTimelineNode>,
  collapsedSpanIds: ReadonlySet<string>,
): SpanSummaryTimelineNode[] {
  const visibleNodes: SpanSummaryTimelineNode[] = [];

  const walk = (timelineNodes: ReadonlyArray<SpanSummaryTimelineNode>) => {
    for (const node of timelineNodes) {
      visibleNodes.push(node);
      if (!collapsedSpanIds.has(node.summary.span.spanId)) {
        walk(node.children);
      }
    }
  };

  walk(nodes);
  return visibleNodes;
}

export function findSpanSummaryTimelineNode(
  nodes: ReadonlyArray<SpanSummaryTimelineNode>,
  targetSpanId: string,
): SpanSummaryTimelineNode | null {
  for (const node of nodes) {
    if (node.summary.span.spanId === targetSpanId) {
      return node;
    }

    const descendantMatch = findSpanSummaryTimelineNode(node.children, targetSpanId);
    if (descendantMatch) {
      return descendantMatch;
    }
  }

  return null;
}
