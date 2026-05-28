/**
 * Denormalize Studio step payloads from { config: { ...fields } } to flat top-level fields.
 *
 * Studio wraps type-specific fields under step.config for UI ergonomics.
 * The DB schema (WorkflowStepSchema) and engine executors expect flat top-level fields.
 * Exception: loop and transform steps use step.config by convention in their executors.
 */

const TOP_LEVEL_KEYS = new Set(['id', 'name', 'type', 'position']);
const CONFIG_WRAPPER_TYPES = new Set(['loop', 'transform']);

// =============================================================================
// Workflow graph validation (self-loops, cycles, dangling edges)
// =============================================================================

export type WorkflowValidationCode = 'SELF_LOOP' | 'CYCLE_DETECTED' | 'INVALID_EDGE';

export class WorkflowValidationError extends Error {
  readonly code: WorkflowValidationCode;
  readonly details: Record<string, unknown>;
  constructor(
    code: WorkflowValidationCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.code = code;
    this.details = details;
  }
}

interface ValidationNode {
  id: string;
  nodeType?: string;
}
interface ValidationEdge {
  source: string;
  target: string;
}

/**
 * Validates a node-based workflow graph. Mirrors the studio canvas rules so
 * clients that bypass the UI cannot persist invalid graphs.
 *
 *  - Every edge endpoint must reference an existing node (INVALID_EDGE).
 *  - Self-loops are rejected (SELF_LOOP).
 *  - Cycles are rejected (CYCLE_DETECTED), with a carve-out: edges whose
 *    TARGET is a `loop` node are ignored during cycle detection so the
 *    intended loop pattern (loop -> body -> ... -> back into the loop)
 *    stays valid.
 *
 * Undefined / empty arrays are treated as "no graph supplied" and skipped —
 * older workflows stored only as steps[] should not be forced through this.
 */
export function validateWorkflowDag(
  nodes: ValidationNode[] | undefined,
  edges: ValidationEdge[] | undefined,
): void {
  if (!nodes || nodes.length === 0) return;
  if (!edges || edges.length === 0) return;

  const ids = new Set(nodes.map((n) => n.id));
  const nodeTypeOf = new Map<string, string | undefined>();
  for (const n of nodes) nodeTypeOf.set(n.id, n.nodeType);

  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      throw new WorkflowValidationError(
        'INVALID_EDGE',
        `Edge references unknown node: ${e.source} → ${e.target}`,
        { source: e.source, target: e.target },
      );
    }
    if (e.source === e.target) {
      throw new WorkflowValidationError(
        'SELF_LOOP',
        `Self-connections are not allowed (node ${e.source})`,
        { nodeId: e.source },
      );
    }
  }

  // Kahn's algorithm — all node types including loop containers are subject to cycle detection.
  // Loop bodies execute inside a child sub-graph; no outer back-edges to the loop container
  // should exist, and if drawn they are genuine cycles that must be rejected.
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }

  const queue: string[] = [];
  for (const [id, d] of indeg) {
    if (d === 0) queue.push(id);
  }
  let visited = 0;
  // Track remaining in-degree so we can identify nodes that stay stuck in a cycle.
  while (queue.length) {
    const n = queue.shift()!;
    visited++;
    for (const m of adj.get(n) ?? []) {
      const next = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, next);
      if (next === 0) queue.push(m);
    }
  }

  if (visited !== nodes.length) {
    // Surface one offending node to help the UI highlight the cycle.
    const stuck: string[] = [];
    for (const [id, d] of indeg) {
      if (d > 0) stuck.push(id);
    }
    throw new WorkflowValidationError(
      'CYCLE_DETECTED',
      `Workflow contains a cycle involving: ${stuck.slice(0, 5).join(', ')}`,
      { nodeIds: stuck },
    );
  }
}

export function denormalizeSteps(
  steps: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  if (!steps || !Array.isArray(steps)) return [];

  return steps.map((step) => {
    const config = step.config;

    // No config wrapper — already flat, pass through
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return step;
    }

    // loop and transform executors expect step.config — preserve wrapper
    if (CONFIG_WRAPPER_TYPES.has(step.type as string)) {
      return step;
    }

    // Spread config fields to top level, remove config key
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) {
      if (key !== 'config') {
        flat[key] = value;
      }
    }
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        flat[key] = value;
      }
    }
    return flat;
  });
}
