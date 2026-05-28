import { describe, it, expect } from 'vitest';
import { detectCircularDependencies } from '../dependencies/circular-detector.js';
import type { DependencyEdge } from '../types.js';

type AdjacencyMap = Map<string, DependencyEdge[]>;

function makeEdge(
  from: string,
  to: string,
  type: DependencyEdge['type'] = 'handoff',
): DependencyEdge {
  return { from, to, type };
}

function buildAdjacency(edges: DependencyEdge[], nodes: string[]): AdjacencyMap {
  const adjacency: AdjacencyMap = new Map();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) {
      list.push(edge);
    }
  }
  return adjacency;
}

describe('circular-detector', () => {
  describe('detectCircularDependencies', () => {
    it('should return no cycles for an empty graph', () => {
      const cycles = detectCircularDependencies([], new Map());
      expect(cycles).toHaveLength(0);
    });

    it('should return no cycles for a single node with no edges', () => {
      const nodes = ['A'];
      const adjacency = buildAdjacency([], nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);
      expect(cycles).toHaveLength(0);
    });

    it('should return no cycles for a linear chain', () => {
      const nodes = ['A', 'B', 'C'];
      const edges = [makeEdge('A', 'B'), makeEdge('B', 'C')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);
      expect(cycles).toHaveLength(0);
    });

    it('should detect a simple 2-node cycle', () => {
      const nodes = ['A', 'B'];
      const edges = [makeEdge('A', 'B'), makeEdge('B', 'A')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toContain('A');
      expect(cycles[0]).toContain('B');
    });

    it('should detect a 3-node cycle', () => {
      const nodes = ['A', 'B', 'C'];
      const edges = [makeEdge('A', 'B'), makeEdge('B', 'C'), makeEdge('C', 'A')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
      const cycle = cycles[0];
      expect(cycle).toContain('A');
      expect(cycle).toContain('B');
      expect(cycle).toContain('C');
    });

    it('should detect a self-loop', () => {
      const nodes = ['A'];
      const edges = [makeEdge('A', 'A')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toContain('A');
    });

    it('should detect multiple independent cycles', () => {
      const nodes = ['A', 'B', 'C', 'D'];
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('B', 'A'),
        makeEdge('C', 'D'),
        makeEdge('D', 'C'),
      ];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(2);
    });

    it('should skip tool_import edges', () => {
      const nodes = ['A', 'B'];
      const edges = [makeEdge('A', 'B', 'tool_import'), makeEdge('B', 'A', 'tool_import')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(0);
    });

    it('should detect cycles with delegate edges', () => {
      const nodes = ['A', 'B'];
      const edges = [makeEdge('A', 'B', 'delegate'), makeEdge('B', 'A', 'delegate')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
    });

    it('should detect cycles with inline_handoff edges', () => {
      const nodes = ['A', 'B', 'C'];
      const edges = [
        makeEdge('A', 'B', 'inline_handoff'),
        makeEdge('B', 'C', 'handoff'),
        makeEdge('C', 'A', 'delegate'),
      ];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
    });

    it('should not duplicate cycles found from different starting nodes', () => {
      // A -> B -> C -> A is the same cycle whether discovered from A, B, or C
      const nodes = ['A', 'B', 'C'];
      const edges = [makeEdge('A', 'B'), makeEdge('B', 'C'), makeEdge('C', 'A')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
    });

    it('should handle a diamond graph with no cycle', () => {
      //   A
      //  / \
      // B   C
      //  \ /
      //   D
      const nodes = ['A', 'B', 'C', 'D'];
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('A', 'C'),
        makeEdge('B', 'D'),
        makeEdge('C', 'D'),
      ];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(0);
    });

    it('should handle a diamond graph with back edge creating a cycle', () => {
      //   A
      //  / \
      // B   C
      //  \ /
      //   D -> A
      const nodes = ['A', 'B', 'C', 'D'];
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('A', 'C'),
        makeEdge('B', 'D'),
        makeEdge('C', 'D'),
        makeEdge('D', 'A'),
      ];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle nodes that reference non-existent nodes (not in graph)', () => {
      const nodes = ['A', 'B'];
      const edges = [
        makeEdge('A', 'Unknown'), // 'Unknown' is not in nodes
      ];
      const adjacency = buildAdjacency(edges, nodes);
      // Manually add the edge to A's adjacency list even though Unknown isn't in the map
      adjacency.get('A')!.push(makeEdge('A', 'Unknown'));

      const cycles = detectCircularDependencies(nodes, adjacency);

      // Should not crash, just skip the unknown node
      expect(cycles).toHaveLength(0);
    });

    it('should handle large acyclic graph', () => {
      // Linear chain: 0 -> 1 -> 2 -> ... -> 49
      const nodes = Array.from({ length: 50 }, (_, i) => `node${i}`);
      const edges: DependencyEdge[] = [];
      for (let i = 0; i < 49; i++) {
        edges.push(makeEdge(`node${i}`, `node${i + 1}`));
      }
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(0);
    });

    it('should handle large cyclic graph', () => {
      // Ring: 0 -> 1 -> 2 -> ... -> 49 -> 0
      const nodes = Array.from({ length: 50 }, (_, i) => `node${i}`);
      const edges: DependencyEdge[] = [];
      for (let i = 0; i < 50; i++) {
        edges.push(makeEdge(`node${i}`, `node${(i + 1) % 50}`));
      }
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
      expect(cycles[0].length).toBe(50);
    });

    it('should handle mixed cycle and non-cycle subgraphs', () => {
      // A -> B -> C -> A (cycle)
      // D -> E (no cycle)
      // F (isolated)
      const nodes = ['A', 'B', 'C', 'D', 'E', 'F'];
      const edges = [
        makeEdge('A', 'B'),
        makeEdge('B', 'C'),
        makeEdge('C', 'A'),
        makeEdge('D', 'E'),
      ];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
      const cycle = cycles[0];
      expect(cycle).toContain('A');
      expect(cycle).toContain('B');
      expect(cycle).toContain('C');
      expect(cycle).not.toContain('D');
      expect(cycle).not.toContain('E');
      expect(cycle).not.toContain('F');
    });

    it('should handle node with multiple outgoing edges, one creating a cycle', () => {
      // A -> B, A -> C
      // B -> A (cycle through A->B->A)
      // C has no outgoing
      const nodes = ['A', 'B', 'C'];
      const edges = [makeEdge('A', 'B'), makeEdge('A', 'C'), makeEdge('B', 'A')];
      const adjacency = buildAdjacency(edges, nodes);

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(1);
    });

    it('should handle graph where adjacency has no edges for a node', () => {
      const nodes = ['A', 'B'];
      const adjacency: AdjacencyMap = new Map();
      // Only A has an adjacency entry; B is missing from the adjacency map
      adjacency.set('A', [makeEdge('A', 'B')]);
      // B is not in adjacency at all, so adjacency.get('B') returns undefined
      // The code does `adjacency.get(node) ?? []`

      const cycles = detectCircularDependencies(nodes, adjacency);

      expect(cycles).toHaveLength(0);
    });
  });

  describe('edge type handling', () => {
    it('should detect cycle regardless of mixed edge types (handoff + delegate)', () => {
      const edges = [makeEdge('A', 'B', 'handoff'), makeEdge('B', 'A', 'delegate')];
      const adj = buildAdjacency(edges, ['A', 'B']);
      const cycles = detectCircularDependencies(['A', 'B'], adj);
      expect(cycles.length).toBe(1);
    });

    it('should skip tool_import edges entirely', () => {
      const edges = [makeEdge('A', 'B', 'tool_import'), makeEdge('B', 'A', 'tool_import')];
      const adj = buildAdjacency(edges, ['A', 'B']);
      const cycles = detectCircularDependencies(['A', 'B'], adj);
      expect(cycles.length).toBe(0);
    });

    it('should detect cycle in handoff edges while ignoring tool_import cycle', () => {
      const edges = [
        makeEdge('A', 'B', 'handoff'),
        makeEdge('B', 'A', 'handoff'),
        makeEdge('C', 'D', 'tool_import'),
        makeEdge('D', 'C', 'tool_import'),
      ];
      const adj = buildAdjacency(edges, ['A', 'B', 'C', 'D']);
      const cycles = detectCircularDependencies(['A', 'B', 'C', 'D'], adj);
      expect(cycles.length).toBe(1);
      // The cycle should be between A and B, not C and D
      const cycleNodes = cycles[0];
      expect(cycleNodes).toContain('A');
      expect(cycleNodes).toContain('B');
    });
  });
});
