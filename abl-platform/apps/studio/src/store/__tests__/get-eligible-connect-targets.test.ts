/**
 * Unit tests for `getEligibleConnectTargets` — the eligibility predicate that
 * powers the HandlePlusMenu's "Connect to existing" section.
 *
 * Covers:
 *   UT-1  Empty workflow (only Start) → empty list
 *   UT-2  Excludes source node itself
 *   UT-3  Excludes nodes already connected from this source handle
 *   UT-4  Per-handle duplicate rule (different handle on same source allowed)
 *   UT-5  Excludes ancestors (cycle prevention)
 *   UT-6  Excludes nodes in a different Loop scope (parentId comparison)
 *   UT-7  Includes End / Agent / Function / Integration when filter passes
 *   UT-8  Cross-branch convergence is allowed (Q1 (a) decision)
 *   UT-9  Fan-out cap (10 per handle) returns empty list when reached
 *   UT-10 Deterministic / stable order across calls
 *
 * Pure function tests — no React, no Zustand, no mocks.
 */

import { describe, test, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeType } from '@agent-platform/shared-kernel/types';
import { getEligibleConnectTargets } from '../workflow-canvas-helpers';

type TestNodeData = { nodeType: NodeType; label: string };
type TestNode = Node<TestNodeData>;

// Mirror of workflow-canvas-store.ts MAX_FAN_OUT. Kept local so the pure-function
// test suite stays free of Zustand transitive imports. If the store constant
// changes, update this value in the same commit.
const MAX_FAN_OUT = 10;

function makeNode(
  id: string,
  nodeType: NodeType = 'function',
  parentId?: string,
  label?: string,
): TestNode {
  return {
    id,
    type: 'workflowNode',
    position: { x: 0, y: 0 },
    parentId,
    data: { nodeType, label: label ?? id },
  };
}

function makeEdge(source: string, target: string, sourceHandle = 'on_success'): Edge {
  return { id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle };
}

describe('getEligibleConnectTargets', () => {
  test('UT-1: empty workflow (only Start) returns empty list', () => {
    const start = makeNode('start', 'start');
    const result = getEligibleConnectTargets([start], [], 'start', 'on_success', MAX_FAN_OUT);
    expect(result).toEqual([]);
  });

  test('UT-2: excludes the source node itself', () => {
    const start = makeNode('start', 'start');
    const a = makeNode('A', 'function');
    const result = getEligibleConnectTargets(
      [start, a],
      [makeEdge('start', 'A')],
      'A',
      'on_success',
      MAX_FAN_OUT,
    );
    expect(result.map((n) => n.id)).not.toContain('A');
  });

  test('UT-3: excludes nodes already connected from this source handle', () => {
    const a = makeNode('A', 'function');
    const b = makeNode('B', 'function');
    const c = makeNode('C', 'end');
    // A.on_success already points at B
    const edges = [makeEdge('A', 'B', 'on_success')];
    const result = getEligibleConnectTargets([a, b, c], edges, 'A', 'on_success', MAX_FAN_OUT);
    expect(result.map((n) => n.id)).toEqual(['C']);
  });

  test('UT-4: per-handle duplicate rule — different handle on same source IS allowed', () => {
    // Condition has two outgoing handles. Edge on_success_if_0 → End exists.
    // Querying on_success_else for End should include End.
    const cond = makeNode('cond', 'condition');
    const end = makeNode('end', 'end');
    const edges = [makeEdge('cond', 'end', 'on_success_if_0')];
    const result = getEligibleConnectTargets(
      [cond, end],
      edges,
      'cond',
      'on_success_else',
      MAX_FAN_OUT,
    );
    expect(result.map((n) => n.id)).toContain('end');
  });

  test('UT-5: excludes ancestors (would create cycle)', () => {
    // Start → A → B → C; from C, none of {Start, A, B} should be eligible.
    const start = makeNode('start', 'start');
    const a = makeNode('A', 'function');
    const b = makeNode('B', 'function');
    const c = makeNode('C', 'function');
    const edges = [makeEdge('start', 'A'), makeEdge('A', 'B'), makeEdge('B', 'C')];
    const result = getEligibleConnectTargets(
      [start, a, b, c],
      edges,
      'C',
      'on_success',
      MAX_FAN_OUT,
    );
    expect(result.map((n) => n.id)).toEqual([]);
  });

  test('UT-6: excludes loop-body internal nodes; loop container IS included (picker resolves to loop_start on click)', () => {
    // Top-level: Start, A. Loop body: LoopChild + loop_start + loop_end (parentId = loop-1).
    // From A (top-level scope, no parentId):
    //   - LoopChild is in a different scope → EXCLUDED
    //   - loop_end is an internal socket → EXCLUDED (unconditional)
    //   - loop_start is an internal socket → EXCLUDED (unconditional — picker shows the
    //     loop CONTAINER instead; ConnectToExistingSection.handlePick resolves the
    //     container click to loop_start at interaction time)
    //   - the Loop container node itself is a top-level sibling → INCLUDED
    const start = makeNode('start', 'start');
    const a = makeNode('A', 'function');
    const loop = makeNode('loop-1', 'loop');
    const loopStart = makeNode('loop-start-1', 'loop_start', 'loop-1');
    const loopEnd = makeNode('loop-end-1', 'loop_end', 'loop-1');
    const loopChild = makeNode('LoopChild', 'function', 'loop-1');
    const edges = [makeEdge('start', 'A')];
    const result = getEligibleConnectTargets(
      [start, a, loop, loopStart, loopEnd, loopChild],
      edges,
      'A',
      'on_success',
      MAX_FAN_OUT,
    );
    const ids = result.map((n) => n.id);
    expect(ids).not.toContain('LoopChild');
    expect(ids).not.toContain('loop-end-1');
    expect(ids).not.toContain('loop-start-1'); // internal socket — picker shows container instead
    expect(ids).toContain('loop-1'); // loop container IS shown; click resolves to loop_start
  });

  test('UT-6b: source INSIDE a loop body cannot connect to nodes OUTSIDE the loop', () => {
    // Inside-the-loop source (parentId = loop-1). Outside candidate (top-level)
    // must be excluded — different scope, no carve-out applies.
    const outsideStart = makeNode('start', 'start');
    const outsideEnd = makeNode('OutsideEnd', 'end');
    const loop = makeNode('loop-1', 'loop');
    const insideSource = makeNode('InsideSource', 'function', 'loop-1');
    const insideSibling = makeNode('InsideSibling', 'function', 'loop-1');
    const edges: Edge[] = [];
    const result = getEligibleConnectTargets(
      [outsideStart, outsideEnd, loop, insideSource, insideSibling],
      edges,
      'InsideSource',
      'on_success',
      MAX_FAN_OUT,
    );
    const ids = result.map((n) => n.id);
    expect(ids).not.toContain('OutsideEnd');
    expect(ids).not.toContain('start');
    expect(ids).not.toContain('loop-1');
    expect(ids).toContain('InsideSibling');
  });

  test('UT-7: includes End, Agent, Function, Integration when downstream and eligible', () => {
    // Start → A; downstream End, Agent, Function, Integration placed sibling
    const start = makeNode('start', 'start');
    const a = makeNode('A', 'function');
    const end = makeNode('end', 'end');
    const agent = makeNode('agent-1', 'agent');
    const fn = makeNode('fn-1', 'function');
    const intg = makeNode('intg-1', 'integration');
    const edges = [makeEdge('start', 'A')];
    const result = getEligibleConnectTargets(
      [start, a, end, agent, fn, intg],
      edges,
      'A',
      'on_success',
      MAX_FAN_OUT,
    );
    const ids = result.map((n) => n.id).sort();
    expect(ids).toEqual(['agent-1', 'end', 'fn-1', 'intg-1']);
  });

  test('UT-8: cross-branch convergence is allowed (Q1 (a))', () => {
    // Start → Condition → if_0 branch (X), else branch (Y).
    // From X (inside if_0 branch), Y must be eligible (cross-branch allowed).
    const start = makeNode('start', 'start');
    const cond = makeNode('cond', 'condition');
    const x = makeNode('X', 'function');
    const y = makeNode('Y', 'function');
    const edges = [
      makeEdge('start', 'cond'),
      makeEdge('cond', 'X', 'on_success_if_0'),
      makeEdge('cond', 'Y', 'on_success_else'),
    ];
    const result = getEligibleConnectTargets(
      [start, cond, x, y],
      edges,
      'X',
      'on_success',
      MAX_FAN_OUT,
    );
    expect(result.map((n) => n.id)).toContain('Y');
  });

  test('UT-9: fan-out cap reached on source handle returns empty list', () => {
    const source = makeNode('A', 'function');
    const downstream = Array.from({ length: 12 }, (_, i) => makeNode(`T${i}`, 'function'));
    // 10 edges already attached to A.on_success
    const edges = Array.from({ length: 10 }, (_, i) => makeEdge('A', `T${i}`));
    const result = getEligibleConnectTargets(
      [source, ...downstream],
      edges,
      'A',
      'on_success',
      MAX_FAN_OUT,
    );
    expect(result).toEqual([]);
  });

  test('UT-10: deterministic / stable order across repeated calls', () => {
    const start = makeNode('start', 'start');
    const a = makeNode('A', 'function');
    const b = makeNode('B', 'agent');
    const c = makeNode('C', 'end');
    const nodes = [start, a, b, c];
    const edges = [makeEdge('start', 'A')];
    const r1 = getEligibleConnectTargets(nodes, edges, 'A', 'on_success', MAX_FAN_OUT);
    const r2 = getEligibleConnectTargets(nodes, edges, 'A', 'on_success', MAX_FAN_OUT);
    expect(r1.map((n) => n.id)).toEqual(r2.map((n) => n.id));
  });
});
