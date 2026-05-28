import { describe, it, expect } from 'vitest';
import { convertCanvasToSteps } from '../handlers/canvas-to-steps.js';

// Canvas nodes use nodeType 'api' for HTTP steps (maps to 'http' step type via NODE_TYPE_TO_STEP_TYPE)
const node = (id: string, nodeType: string, config: Record<string, unknown> = {}) => ({
  id,
  nodeType,
  name: id,
  config,
});
const edge = (source: string, target: string, sourceHandle = 'on_success') => ({
  id: `${source}->${target}`,
  source,
  sourceHandle,
  target,
});

describe('canvas-to-steps: inDegreeMap + cycle detection (INT-1, INT-2)', () => {
  // INT-1: Diamond topology — Start fans out to A and B, both converge on Join
  it('INT-1: diamond topology produces inDegreeMap[join] === 2', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'api'),
      node('b', 'api'),
      node('join', 'api'),
      node('end', 'end'),
    ];
    const edges = [
      edge('start', 'a'),
      edge('start', 'b'),
      edge('a', 'join'),
      edge('b', 'join'),
      edge('join', 'end'),
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    expect(result.inDegreeMap['join']).toBe(2);
    // a and b are root nodes — in-degree 0
    expect(result.inDegreeMap['a']).toBe(0);
    expect(result.inDegreeMap['b']).toBe(0);
    expect(result.steps).toHaveLength(3); // a, b, join
  });

  // Linear topology — each step has at most in-degree 1
  it('linear topology: all non-root in-degrees === 1', () => {
    const nodes = [node('start', 'start'), node('a', 'api'), node('b', 'api'), node('end', 'end')];
    const edges = [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    expect(result.inDegreeMap['a']).toBe(0);
    expect(result.inDegreeMap['b']).toBe(1);
    // No entry with value > 1
    expect(Object.values(result.inDegreeMap).every((v) => v <= 1)).toBe(true);
  });

  // INT-2: Cycle detection — back-edge B → A creates a cycle
  it('INT-2: cycle detection throws when a back-edge exists', () => {
    const nodes = [node('start', 'start'), node('a', 'api'), node('b', 'api'), node('end', 'end')];
    const edges = [
      edge('start', 'a'),
      edge('a', 'b'),
      edge('b', 'a'), // back-edge creates cycle
    ];

    expect(() => convertCanvasToSteps(nodes as never[], edges as never[], { full: true })).toThrow(
      /cycle/i,
    );
  });

  // EMPTY_RESULT backward compat — empty nodes array returns inDegreeMap: {}
  it('EMPTY_RESULT: empty nodes returns inDegreeMap: {}', () => {
    const result = convertCanvasToSteps([] as never[], [] as never[], { full: true });
    expect(result.inDegreeMap).toEqual({});
    expect(result.steps).toHaveLength(0);
  });

  // Nodes with no start node return EMPTY_RESULT
  it('no start node returns inDegreeMap: {}', () => {
    const nodes = [node('a', 'api'), node('end', 'end')];
    const result = convertCanvasToSteps(nodes as never[], [] as never[], { full: true });
    expect(result.inDegreeMap).toEqual({});
  });

  // requiredPredecessors attached from node config
  it('requiredPredecessors attached from node config to step', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'api'),
      node('b', 'api'),
      node('join', 'api', { requiredPredecessors: ['a', 'b'] }),
      node('end', 'end'),
    ];
    const edges = [
      edge('start', 'a'),
      edge('start', 'b'),
      edge('a', 'join'),
      edge('b', 'join'),
      edge('join', 'end'),
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    const joinStep = result.steps.find((s) => s.id === 'join');

    expect(joinStep).toBeDefined();
    expect(joinStep!.requiredPredecessors).toEqual(['a', 'b']);
  });

  // requiredPredecessors absent when not in config
  it('requiredPredecessors absent when not configured', () => {
    const nodes = [node('start', 'start'), node('a', 'api'), node('end', 'end')];
    const edges = [edge('start', 'a'), edge('a', 'end')];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });
    const aStep = result.steps.find((s) => s.id === 'a');

    expect(aStep).toBeDefined();
    expect(aStep!.requiredPredecessors).toBeUndefined();
  });

  // canvasRouted set on all steps
  it('canvasRouted is true on all canvas steps', () => {
    const nodes = [node('start', 'start'), node('a', 'api'), node('end', 'end')];
    const edges = [edge('start', 'a'), edge('a', 'end')];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    for (const step of result.steps) {
      expect(step.canvasRouted).toBe(true);
    }
  });

  it('counts incoming edges to loop containers in inDegreeMap barrier count', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'api'),
      node('loop1', 'loop', { items: '[]', steps: [] }),
      node('end', 'end'),
    ];
    const edges = [edge('start', 'a'), edge('a', 'loop1'), edge('loop1', 'end')];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    expect(result.inDegreeMap['loop1']).toBe(1);
  });

  it('waits for all incoming branches before dispatching a loop container', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'api'),
      node('b', 'api'),
      node('loop1', 'loop', { items: '[]', steps: [] }),
      node('end', 'end'),
    ];
    const edges = [
      edge('start', 'a'),
      edge('start', 'b'),
      edge('a', 'loop1'),
      edge('b', 'loop1'),
      edge('loop1', 'end'),
    ];

    const result = convertCanvasToSteps(nodes as never[], edges as never[], { full: true });

    expect(result.inDegreeMap['loop1']).toBe(2);
    expect(result.inDegreeMap['a']).toBe(0);
    expect(result.inDegreeMap['b']).toBe(0);
  });
});
