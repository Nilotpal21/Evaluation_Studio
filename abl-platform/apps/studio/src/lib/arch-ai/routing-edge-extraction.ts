export type RoutingEdgeType = 'handoff' | 'delegate' | 'escalate';

export interface RoutingEdge {
  from: string;
  to: string;
  type: RoutingEdgeType;
}

function buildEdgeKey(edge: RoutingEdge): string {
  return `${edge.from}->${edge.type}->${edge.to}`;
}

function addEdge(edges: RoutingEdge[], seen: Set<string>, edge: RoutingEdge | null): void {
  if (!edge || edge.to.length === 0) {
    return;
  }

  const key = buildEdgeKey(edge);
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  edges.push(edge);
}

function extractDslSection(dsl: string, sectionName: string): string | null {
  const pattern = new RegExp(
    `^${sectionName}\\s*:\\s*\\n([\\s\\S]*?)(?=^[A-Z][A-Z_]*\\s*:|$)`,
    'gm',
  );
  const match = pattern.exec(dsl);
  return match?.[1] ?? null;
}

function addSectionMatches(
  edges: RoutingEdge[],
  seen: Set<string>,
  sourceAgent: string,
  section: string | null,
  type: RoutingEdgeType,
  patterns: RegExp[],
): void {
  if (!section) {
    return;
  }

  for (const pattern of patterns) {
    for (const match of section.matchAll(pattern)) {
      const target = match[1]?.trim() ?? '';
      addEdge(edges, seen, target ? { from: sourceAgent, to: target, type } : null);
    }
  }
}

function addInlineActionMatches(
  edges: RoutingEdge[],
  seen: Set<string>,
  sourceAgent: string,
  dsl: string,
  type: Extract<RoutingEdgeType, 'handoff' | 'delegate'>,
): void {
  const pattern = new RegExp(
    `^\\s*-\\s*${type.toUpperCase()}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)`,
    'gm',
  );
  for (const match of dsl.matchAll(pattern)) {
    const target = match[1]?.trim() ?? '';
    addEdge(edges, seen, target ? { from: sourceAgent, to: target, type } : null);
  }
}

function addActionHandlerEdges(
  edges: RoutingEdge[],
  seen: Set<string>,
  sourceAgent: string,
  handlers: unknown,
): void {
  if (!Array.isArray(handlers)) {
    return;
  }

  for (const handler of handlers) {
    if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
      continue;
    }

    const actions = (handler as { do?: unknown }).do;
    if (!Array.isArray(actions)) {
      continue;
    }

    for (const action of actions) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) {
        continue;
      }

      const actionRecord = action as Record<string, unknown>;
      addEdge(
        edges,
        seen,
        typeof actionRecord.handoff === 'string' && actionRecord.handoff.length > 0
          ? { from: sourceAgent, to: actionRecord.handoff, type: 'handoff' }
          : null,
      );
      addEdge(
        edges,
        seen,
        typeof actionRecord.delegate === 'string' && actionRecord.delegate.length > 0
          ? { from: sourceAgent, to: actionRecord.delegate, type: 'delegate' }
          : null,
      );
    }
  }
}

export function extractRoutingEdgesFromParsedDocument(
  doc: unknown,
  sourceAgent: string,
): RoutingEdge[] {
  const edges: RoutingEdge[] = [];
  const seen = new Set<string>();
  const record = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};

  const handoffs = record.handoff as Array<{ to?: unknown }> | undefined;
  if (Array.isArray(handoffs)) {
    for (const handoff of handoffs) {
      addEdge(
        edges,
        seen,
        typeof handoff.to === 'string' && handoff.to.length > 0
          ? { from: sourceAgent, to: handoff.to, type: 'handoff' }
          : null,
      );
    }
  }

  const delegates = record.delegate as Array<{ agent?: unknown; to?: unknown }> | undefined;
  if (Array.isArray(delegates)) {
    for (const delegate of delegates) {
      const target =
        typeof delegate.agent === 'string'
          ? delegate.agent
          : typeof delegate.to === 'string'
            ? delegate.to
            : '';
      addEdge(edges, seen, target ? { from: sourceAgent, to: target, type: 'delegate' } : null);
    }
  }

  const escalate = record.escalate as { triggers?: Array<{ target?: unknown }> } | undefined;
  if (Array.isArray(escalate?.triggers)) {
    for (const trigger of escalate.triggers) {
      addEdge(
        edges,
        seen,
        typeof trigger.target === 'string' && trigger.target.length > 0
          ? { from: sourceAgent, to: trigger.target, type: 'escalate' }
          : null,
      );
    }
  }

  const flow = record.flow as
    | {
        definitions?: Record<string, { onAction?: unknown }>;
      }
    | undefined;
  for (const step of Object.values(flow?.definitions ?? {})) {
    addActionHandlerEdges(edges, seen, sourceAgent, step.onAction);
  }

  addActionHandlerEdges(
    edges,
    seen,
    sourceAgent,
    (record as { actionHandlers?: unknown }).actionHandlers,
  );

  return edges;
}

export function extractRoutingTargetsFromParsedDocument(
  doc: unknown,
  types?: RoutingEdgeType[],
): string[] {
  const typeFilter = types ? new Set(types) : null;
  const edges = extractRoutingEdgesFromParsedDocument(doc, '__source__');
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const edge of edges) {
    if (typeFilter && !typeFilter.has(edge.type)) {
      continue;
    }
    if (seen.has(edge.to)) {
      continue;
    }
    seen.add(edge.to);
    targets.push(edge.to);
  }

  return targets;
}

export function extractRoutingEdgesFromDslFallback(
  dslContent: string | null | undefined,
  sourceAgent: string,
): RoutingEdge[] {
  if (!dslContent?.trim()) {
    return [];
  }

  const edges: RoutingEdge[] = [];
  const seen = new Set<string>();

  addSectionMatches(edges, seen, sourceAgent, extractDslSection(dslContent, 'HANDOFF'), 'handoff', [
    /^\s*-?\s*TO\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/gm,
  ]);
  addSectionMatches(
    edges,
    seen,
    sourceAgent,
    extractDslSection(dslContent, 'DELEGATE'),
    'delegate',
    [
      /^\s*-?\s*TO\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/gm,
      /^\s*-?\s*AGENT\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/gm,
    ],
  );
  addSectionMatches(
    edges,
    seen,
    sourceAgent,
    extractDslSection(dslContent, 'ESCALATE'),
    'escalate',
    [
      /^\s*-?\s*TARGET\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/gim,
      /^\s*TARGET\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/gim,
    ],
  );

  addInlineActionMatches(edges, seen, sourceAgent, dslContent, 'handoff');
  addInlineActionMatches(edges, seen, sourceAgent, dslContent, 'delegate');

  return edges;
}
