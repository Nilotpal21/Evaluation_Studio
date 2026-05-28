/**
 * Span Hierarchy and Trace Tree
 *
 * Provides hierarchical tracing with parent/child relationships,
 * compatible with OpenTelemetry concepts.
 */

import {
  ExtendedTraceEvent,
  TraceEventType,
  generateSpanId,
  generateTraceId,
} from './trace-events.js';

/**
 * Span status
 */
export type SpanStatus = 'running' | 'completed' | 'error';

/**
 * A span represents a unit of work with timing and hierarchy
 */
export interface Span {
  /** Unique span identifier */
  spanId: string;

  /** Trace this span belongs to */
  traceId: string;

  /** Parent span (if nested) */
  parentSpanId?: string;

  /** Human-readable name */
  name: string;

  /** Start time */
  startTime: Date;

  /** End time (set when span completes) */
  endTime?: Date;

  /** Duration in milliseconds */
  durationMs?: number;

  /** Current status */
  status: SpanStatus;

  /** Associated agent name */
  agentName: string;

  /** Session this span belongs to */
  sessionId: string;

  /** Events within this span */
  events: ExtendedTraceEvent[];

  /** Attributes/tags */
  attributes: Record<string, unknown>;
}

/**
 * Span builder for fluent span creation
 */
export class SpanBuilder {
  private span: Partial<Span>;

  constructor(name: string, traceId: string, sessionId: string, agentName: string) {
    this.span = {
      spanId: generateSpanId(),
      traceId,
      name,
      startTime: new Date(),
      status: 'running',
      sessionId,
      agentName,
      events: [],
      attributes: {},
    };
  }

  withParent(parentSpanId: string): SpanBuilder {
    this.span.parentSpanId = parentSpanId;
    return this;
  }

  withAttribute(key: string, value: unknown): SpanBuilder {
    this.span.attributes![key] = value;
    return this;
  }

  withAttributes(attrs: Record<string, unknown>): SpanBuilder {
    Object.assign(this.span.attributes!, attrs);
    return this;
  }

  build(): Span {
    return this.span as Span;
  }
}

/**
 * Manages span lifecycle
 */
export class SpanManager {
  private spans: Map<string, Span> = new Map();
  private activeSpanStack: Map<string, string[]> = new Map(); // sessionId -> spanId stack

  /**
   * Start a new span
   */
  startSpan(
    name: string,
    traceId: string,
    sessionId: string,
    agentName: string,
    parentSpanId?: string,
  ): Span {
    const builder = new SpanBuilder(name, traceId, sessionId, agentName);

    // If no parent specified, use the current active span for this session
    const effectiveParent = parentSpanId ?? this.getActiveSpanId(sessionId);
    if (effectiveParent) {
      builder.withParent(effectiveParent);
    }

    const span = builder.build();
    this.spans.set(span.spanId, span);

    // Push to active span stack
    this.pushActiveSpan(sessionId, span.spanId);

    return span;
  }

  /**
   * End a span
   */
  endSpan(spanId: string, status: SpanStatus = 'completed'): Span | undefined {
    const span = this.spans.get(spanId);
    if (!span) return undefined;

    span.endTime = new Date();
    span.durationMs = span.endTime.getTime() - span.startTime.getTime();
    span.status = status;

    // Pop from active span stack
    this.popActiveSpan(span.sessionId, spanId);

    return span;
  }

  /**
   * Add an event to a span
   */
  addEventToSpan(spanId: string, event: ExtendedTraceEvent): void {
    const span = this.spans.get(spanId);
    if (span) {
      span.events.push(event);
    }
  }

  /**
   * Get a span by ID
   */
  getSpan(spanId: string): Span | undefined {
    return this.spans.get(spanId);
  }

  /**
   * Get the current active span for a session
   */
  getActiveSpanId(sessionId: string): string | undefined {
    const stack = this.activeSpanStack.get(sessionId);
    return stack?.[stack.length - 1];
  }

  /**
   * Get all spans for a trace
   */
  getSpansForTrace(traceId: string): Span[] {
    return Array.from(this.spans.values()).filter((s) => s.traceId === traceId);
  }

  /**
   * Clear spans for a session (cleanup)
   */
  clearSession(sessionId: string): void {
    for (const [id, span] of this.spans) {
      if (span.sessionId === sessionId) {
        this.spans.delete(id);
      }
    }
    this.activeSpanStack.delete(sessionId);
  }

  private pushActiveSpan(sessionId: string, spanId: string): void {
    if (!this.activeSpanStack.has(sessionId)) {
      this.activeSpanStack.set(sessionId, []);
    }
    this.activeSpanStack.get(sessionId)!.push(spanId);
  }

  private popActiveSpan(sessionId: string, spanId: string): void {
    const stack = this.activeSpanStack.get(sessionId);
    if (stack) {
      const idx = stack.lastIndexOf(spanId);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    }
  }
}

/**
 * Tree node for trace visualization
 */
export interface TraceTreeNode {
  span: Span;
  children: TraceTreeNode[];
  depth: number;
}

/**
 * Builds a tree structure from flat spans
 */
export class TraceTree {
  private rootNodes: TraceTreeNode[] = [];
  private nodeMap: Map<string, TraceTreeNode> = new Map();

  constructor(spans: Span[]) {
    this.buildTree(spans);
  }

  private buildTree(spans: Span[]): void {
    // Sort by start time
    const sortedSpans = [...spans].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Create nodes
    for (const span of sortedSpans) {
      const node: TraceTreeNode = { span, children: [], depth: 0 };
      this.nodeMap.set(span.spanId, node);
    }

    // Build hierarchy
    for (const span of sortedSpans) {
      const node = this.nodeMap.get(span.spanId)!;
      if (span.parentSpanId) {
        const parent = this.nodeMap.get(span.parentSpanId);
        if (parent) {
          parent.children.push(node);
          node.depth = parent.depth + 1;
        } else {
          // Orphaned span - add as root
          this.rootNodes.push(node);
        }
      } else {
        this.rootNodes.push(node);
      }
    }

    // Recursively update depths
    for (const root of this.rootNodes) {
      this.updateDepths(root, 0);
    }
  }

  private updateDepths(node: TraceTreeNode, depth: number): void {
    node.depth = depth;
    for (const child of node.children) {
      this.updateDepths(child, depth + 1);
    }
  }

  /**
   * Get root nodes of the tree
   */
  getRoots(): TraceTreeNode[] {
    return this.rootNodes;
  }

  /**
   * Get a node by span ID
   */
  getNode(spanId: string): TraceTreeNode | undefined {
    return this.nodeMap.get(spanId);
  }

  /**
   * Flatten tree to array (pre-order traversal)
   */
  flatten(): TraceTreeNode[] {
    const result: TraceTreeNode[] = [];
    const visit = (node: TraceTreeNode) => {
      result.push(node);
      for (const child of node.children) {
        visit(child);
      }
    };
    for (const root of this.rootNodes) {
      visit(root);
    }
    return result;
  }

  /**
   * Get critical path (longest duration chain)
   */
  getCriticalPath(): Span[] {
    let maxDuration = 0;
    let criticalPath: Span[] = [];

    const findPath = (node: TraceTreeNode, path: Span[], totalDuration: number): void => {
      const newPath = [...path, node.span];
      const newDuration = totalDuration + (node.span.durationMs ?? 0);

      if (node.children.length === 0) {
        if (newDuration > maxDuration) {
          maxDuration = newDuration;
          criticalPath = newPath;
        }
      } else {
        for (const child of node.children) {
          findPath(child, newPath, newDuration);
        }
      }
    };

    for (const root of this.rootNodes) {
      findPath(root, [], 0);
    }

    return criticalPath;
  }

  /**
   * Find spans by event type
   */
  findSpansByEventType(eventType: TraceEventType): Span[] {
    const result: Span[] = [];
    for (const node of this.nodeMap.values()) {
      if (node.span.events.some((e) => e.type === eventType)) {
        result.push(node.span);
      }
    }
    return result;
  }

  /**
   * Get total duration of the trace
   */
  getTotalDuration(): number {
    let minStart = Infinity;
    let maxEnd = 0;

    for (const node of this.nodeMap.values()) {
      const start = node.span.startTime.getTime();
      const end = node.span.endTime?.getTime() ?? start;
      minStart = Math.min(minStart, start);
      maxEnd = Math.max(maxEnd, end);
    }

    return maxEnd - minStart;
  }

  /**
   * Generate ASCII visualization of the tree
   */
  toAscii(): string {
    const lines: string[] = [];

    const render = (node: TraceTreeNode, prefix: string, isLast: boolean): void => {
      const connector = isLast ? '\\-- ' : '+-- ';
      const status = node.span.status === 'error' ? ' [ERROR]' : '';
      const duration = node.span.durationMs ? ` (${node.span.durationMs}ms)` : '';

      lines.push(`${prefix}${connector}${node.span.name}${duration}${status}`);

      const childPrefix = prefix + (isLast ? '    ' : '|   ');
      for (let i = 0; i < node.children.length; i++) {
        render(node.children[i], childPrefix, i === node.children.length - 1);
      }
    };

    for (let i = 0; i < this.rootNodes.length; i++) {
      render(this.rootNodes[i], '', i === this.rootNodes.length - 1);
    }

    return lines.join('\n');
  }
}

/**
 * Trace context for propagation
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  sessionId: string;
  agentName: string;
}

/**
 * Create a new trace context
 */
export function createTraceContext(sessionId: string, agentName: string): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    sessionId,
    agentName,
  };
}

/**
 * Create a child context from a parent
 */
export function createChildContext(parent: TraceContext, agentName?: string): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    sessionId: parent.sessionId,
    agentName: agentName ?? parent.agentName,
  };
}
