/**
 * Graph utilities for the universal pipeline engine.
 *
 * Provides conversion from legacy step arrays to graph nodes,
 * reachability analysis, cycle detection, and transition resolution.
 */

import type {
  PipelineStep,
  PipelineNode,
  NodeTransition,
  GroupChildNode,
  StepOutput,
} from './types.js';

// ── Public API ──

/**
 * Converts a legacy `steps[]` array to a graph `{ nodes, entryNodeId }`.
 *
 * - Sequential steps are chained via transitions.
 * - Steps sharing the same `parallel` tag are collapsed into a single
 *   `node-group` node with `children`.
 */
export function stepsToGraph(steps: PipelineStep[]): {
  nodes: PipelineNode[];
  entryNodeId: string;
} {
  if (steps.length === 0) {
    return { nodes: [], entryNodeId: '' };
  }

  // Group consecutive steps by parallel tag
  const segments: Array<{ parallel?: string; steps: PipelineStep[] }> = [];

  for (const step of steps) {
    const lastSegment = segments[segments.length - 1];
    if (step.parallel) {
      if (lastSegment && lastSegment.parallel === step.parallel) {
        lastSegment.steps.push(step);
      } else {
        segments.push({ parallel: step.parallel, steps: [step] });
      }
    } else {
      segments.push({ steps: [step] });
    }
  }

  // Convert segments to nodes
  const nodes: PipelineNode[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];

    if (segment.parallel && segment.steps.length > 0) {
      // Create a node-group
      const groupId = `group-${segment.parallel}`;
      const children: GroupChildNode[] = segment.steps.map((s) => ({
        id: s.id,
        type: s.activity ?? s.type ?? 'unknown',
        label: s.name,
        config: s.config ?? {},
        timeout: s.timeout,
        retries: s.retries,
        onFailure: s.onFailure,
      }));

      const transitions: NodeTransition[] = [];
      if (nextSegment) {
        const nextId = nextSegment.parallel
          ? `group-${nextSegment.parallel}`
          : nextSegment.steps[0].id;
        transitions.push({ target: nextId });
      }

      nodes.push({
        id: groupId,
        type: 'node-group',
        label: `Parallel: ${segment.parallel}`,
        config: {},
        transitions,
        children,
      });
    } else {
      // Single sequential step
      const step = segment.steps[0];
      const transitions: NodeTransition[] = [];
      if (nextSegment) {
        const nextId = nextSegment.parallel
          ? `group-${nextSegment.parallel}`
          : nextSegment.steps[0].id;
        transitions.push({ target: nextId });
      }

      nodes.push({
        id: step.id,
        type: step.activity ?? step.type ?? 'unknown',
        label: step.name,
        config: step.config ?? {},
        transitions,
        timeout: step.timeout,
        retries: step.retries,
        onFailure: step.onFailure,
      });
    }
  }

  return {
    nodes,
    entryNodeId: nodes[0].id,
  };
}

/**
 * BFS from the entry node, returning the set of all reachable node IDs.
 * Children of `node-group` nodes are included in the reachable set.
 */
export function findReachableNodes(nodes: PipelineNode[], entryNodeId: string): Set<string> {
  const nodeMap = new Map<string, PipelineNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const reachable = new Set<string>();
  const queue: string[] = [entryNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;

    const node = nodeMap.get(current);
    if (!node) continue;

    reachable.add(current);

    // Include children of node-groups
    if (node.children) {
      for (const child of node.children) {
        reachable.add(child.id);
      }
    }

    // Enqueue transition targets
    for (const transition of node.transitions) {
      if (!reachable.has(transition.target)) {
        queue.push(transition.target);
      }
    }
  }

  return reachable;
}

/**
 * DFS-based cycle detection. Returns a list of back-edges (from, to).
 * A back-edge exists when a transition points to a node currently on
 * the DFS recursion stack.
 */
export function detectBackEdges(
  nodes: PipelineNode[],
  entryNodeId: string,
): Array<{ from: string; to: string }> {
  const nodeMap = new Map<string, PipelineNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdges: Array<{ from: string; to: string }> = [];

  function dfs(nodeId: string): void {
    visited.add(nodeId);
    onStack.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (node) {
      for (const transition of node.transitions) {
        if (onStack.has(transition.target)) {
          backEdges.push({ from: nodeId, to: transition.target });
        } else if (!visited.has(transition.target)) {
          dfs(transition.target);
        }
      }
    }

    onStack.delete(nodeId);
  }

  dfs(entryNodeId);
  return backEdges;
}

/**
 * Evaluates transitions in order (sorted by `order`), returns the target
 * of the first matching condition, or null if none match.
 *
 * Transitions without a `condition` are unconditional (always match).
 */
export function resolveTransition(
  transitions: NodeTransition[],
  output: StepOutput,
  context: { input: Record<string, unknown>; nodeOutputs: Record<string, unknown> },
): string | null {
  if (transitions.length === 0) return null;

  // Sort by order (undefined order goes to end)
  const sorted = [...transitions].sort((a, b) => {
    const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });

  for (const transition of sorted) {
    if (!transition.condition) {
      // Unconditional transition always matches
      return transition.target;
    }

    if (evalSimple(transition.condition, output.data, context)) {
      return transition.target;
    }
  }

  return null;
}

// ── Internal Expression Evaluator ──

/**
 * Resolves a dot-path value from a scope object.
 * e.g. resolveValue('output.score', { output: { score: 0.9 } }) => 0.9
 */
function resolveValue(
  token: string,
  outputData: Record<string, unknown>,
  context: { input: Record<string, unknown>; nodeOutputs: Record<string, unknown> },
): unknown {
  const trimmed = token.trim();

  // Boolean literals
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Null literal
  if (trimmed === 'null') return null;

  // String literals (single or double quoted)
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  // Number literals
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '') return num;

  // Dot-path resolution
  const parts = trimmed.split('.');
  const root = parts[0];

  let value: unknown;
  if (root === 'output') {
    value = outputData;
    for (let i = 1; i < parts.length; i++) {
      if (value == null || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[parts[i]];
    }
  } else if (root === 'context') {
    value = context as Record<string, unknown>;
    for (let i = 1; i < parts.length; i++) {
      if (value == null || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[parts[i]];
    }
  } else {
    return undefined;
  }

  return value;
}

/**
 * Splits a string by a delimiter, but only at the top level
 * (not inside parentheses or quotes).
 */
function splitTopLevel(expr: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }

    if (
      !inSingle &&
      !inDouble &&
      depth === 0 &&
      expr.substring(i, i + delimiter.length) === delimiter
    ) {
      parts.push(current);
      current = '';
      i += delimiter.length - 1;
    } else {
      current += ch;
    }
  }

  parts.push(current);
  return parts;
}

/**
 * Simple expression evaluator supporting:
 * - Dot-path access: output.score, context.input.x
 * - Comparisons: ==, !=, >, <, >=, <=
 * - Logical: &&, ||, !
 * - Literals: strings, numbers, booleans, null
 */
function evalSimple(
  expression: string,
  outputData: Record<string, unknown>,
  context: { input: Record<string, unknown>; nodeOutputs: Record<string, unknown> },
): boolean {
  const expr = expression.trim();

  // Handle logical OR (lowest precedence)
  const orParts = splitTopLevel(expr, '||');
  if (orParts.length > 1) {
    return orParts.some((part) => evalSimple(part, outputData, context));
  }

  // Handle logical AND
  const andParts = splitTopLevel(expr, '&&');
  if (andParts.length > 1) {
    return andParts.every((part) => evalSimple(part, outputData, context));
  }

  // Handle logical NOT
  if (expr.startsWith('!')) {
    return !evalSimple(expr.slice(1), outputData, context);
  }

  // Handle parentheses
  if (expr.startsWith('(') && expr.endsWith(')')) {
    return evalSimple(expr.slice(1, -1), outputData, context);
  }

  // Handle comparison operators (order matters: >= before >, <= before <, != before ==)
  const operators = ['>=', '<=', '!=', '==', '>', '<'] as const;
  for (const op of operators) {
    const opParts = splitTopLevel(expr, op);
    if (opParts.length === 2) {
      const left = resolveValue(opParts[0], outputData, context);
      const right = resolveValue(opParts[1], outputData, context);
      return compareValues(left, right, op);
    }
  }

  // Treat as a truthy check
  const value = resolveValue(expr, outputData, context);
  return Boolean(value);
}

function compareValues(
  left: unknown,
  right: unknown,
  op: '>=' | '<=' | '!=' | '==' | '>' | '<',
): boolean {
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return (left as number) > (right as number);
    case '<':
      return (left as number) < (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '<=':
      return (left as number) <= (right as number);
    default:
      return false;
  }
}
