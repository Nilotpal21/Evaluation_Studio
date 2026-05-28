/**
 * Circular Dependency Detector
 *
 * Uses DFS-based cycle detection on the dependency graph.
 */

import type { DependencyEdge } from '../types.js';

type AdjacencyMap = Map<string, DependencyEdge[]>;

enum Color {
  White = 0,
  Gray = 1,
  Black = 2,
}

/**
 * Detect all circular dependencies in a directed graph.
 *
 * Uses standard DFS coloring:
 * - White: unvisited
 * - Gray: in current DFS path (back edge to gray = cycle)
 * - Black: fully explored
 *
 * @param nodes - All node names in the graph
 * @param adjacency - Adjacency list mapping node → outgoing edges
 * @returns Array of cycles, each cycle is an array of node names forming the loop
 */
export function detectCircularDependencies(nodes: string[], adjacency: AdjacencyMap): string[][] {
  const color = new Map<string, Color>();
  const parent = new Map<string, string | null>();
  const cycles: string[][] = [];
  const foundCycleKeys = new Set<string>();

  for (const node of nodes) {
    color.set(node, Color.White);
    parent.set(node, null);
  }

  for (const node of nodes) {
    if (color.get(node) === Color.White) {
      dfs(node, color, parent, adjacency, cycles, foundCycleKeys);
    }
  }

  return cycles;
}

function dfs(
  node: string,
  color: Map<string, Color>,
  parent: Map<string, string | null>,
  adjacency: AdjacencyMap,
  cycles: string[][],
  foundCycleKeys: Set<string>,
): void {
  color.set(node, Color.Gray);

  const edges = adjacency.get(node) ?? [];
  for (const edge of edges) {
    // Skip tool_import edges — they reference files not agents
    if (edge.type === 'tool_import') continue;

    const neighbor = edge.to;
    const neighborColor = color.get(neighbor);

    if (neighborColor === undefined) {
      // Node not in graph — skip (will be caught by missing dep validation)
      continue;
    }

    if (neighborColor === Color.White) {
      parent.set(neighbor, node);
      dfs(neighbor, color, parent, adjacency, cycles, foundCycleKeys);
    } else if (neighborColor === Color.Gray) {
      // Back edge — cycle detected. Trace back to find the full cycle.
      const cycle = traceCycle(node, neighbor, parent);
      const key = normalizeCycleKey(cycle);
      if (!foundCycleKeys.has(key)) {
        foundCycleKeys.add(key);
        cycles.push(cycle);
      }
    }
  }

  color.set(node, Color.Black);
}

function traceCycle(
  current: string,
  cycleStart: string,
  parent: Map<string, string | null>,
): string[] {
  const cycle: string[] = [cycleStart];
  let node: string | null = current;

  while (node !== null && node !== cycleStart) {
    cycle.push(node);
    node = parent.get(node) ?? null;
  }

  cycle.reverse();
  return cycle;
}

/**
 * Normalize a cycle so the same cycle discovered from different starting
 * nodes produces the same key, avoiding duplicate reports.
 */
function normalizeCycleKey(cycle: string[]): string {
  // Rotate so the lexicographically smallest element is first
  const minIndex = cycle.indexOf(cycle.reduce((min, curr) => (curr < min ? curr : min)));
  const rotated = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
  return rotated.join(' -> ');
}
