/**
 * Canvas Fan-out Tests
 *
 * Covers:
 *   UT-1: Fan-out allowed (second edge from same handle to different target accepted)
 *   UT-2: Duplicate rejected (source + sourceHandle + target already exists)
 *   UT-3: Cap enforced (11th edge rejected)
 *   UT-4: Cycle blocked (back-edge returns state unchanged)
 *   UT-5: computeExecutionEdges — all 3 on_success edges of completed node classified traversed
 *   UT-6: MergerNodeConfig renders correct predecessor names (2 checkboxes, both unchecked)
 *   UT-7: Toggle updates requiredPredecessors; removing edge drops predecessor list
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useWorkflowCanvasStore } from '../store/workflow-canvas-store';
import { computeExecutionEdges } from '../components/workflows/canvas/edges/computeExecutionEdges';
import { MergerNodeConfig } from '../components/workflows/canvas/config/MergerNodeConfig';
import type { WorkflowFlowNode, WorkflowFlowEdge } from '../store/workflow-canvas-store';
import type { ExecutionStepResult } from '../api/workflows';

// =============================================================================
// Helpers
// =============================================================================

function makeNode(id: string, nodeType = 'api'): WorkflowFlowNode {
  return {
    id,
    type: 'workflowNode',
    position: { x: 0, y: 0 },
    data: {
      nodeType: nodeType as never,
      label: id,
      config: {},
      color: '#000',
      isStub: false,
      outputHandles: ['on_success'],
    },
  };
}

function makeEdge(source: string, target: string, sourceHandle = 'on_success'): WorkflowFlowEdge {
  return {
    id: `${source}-${sourceHandle}-${target}`,
    source,
    target,
    sourceHandle,
    type: 'workflowEdge',
  };
}

function makeStep(
  id: string,
  nodeType = 'api',
  status: ExecutionStepResult['status'] = 'completed',
): ExecutionStepResult {
  return {
    stepId: id,
    stepName: id,
    nodeType,
    status,
  };
}

// =============================================================================
// UT-1 through UT-4: workflow-canvas-store onConnect
// =============================================================================

describe('workflow-canvas-store onConnect — fan-out guard', () => {
  beforeEach(() => {
    useWorkflowCanvasStore.setState({
      nodes: [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
      edges: [makeEdge('A', 'B')],
      isDirty: false,
      changeVersion: 0,
    });
  });

  test('UT-1: allows second edge from same handle to different target', () => {
    useWorkflowCanvasStore.getState().onConnect({
      source: 'A',
      target: 'C',
      sourceHandle: 'on_success',
      targetHandle: null,
    });
    const { edges } = useWorkflowCanvasStore.getState();
    expect(edges).toHaveLength(2);
    expect(edges.some((e) => e.source === 'A' && e.target === 'C')).toBe(true);
  });

  test('UT-2: rejects exact duplicate (same source + handle + target)', () => {
    useWorkflowCanvasStore.getState().onConnect({
      source: 'A',
      target: 'B',
      sourceHandle: 'on_success',
      targetHandle: null,
    });
    const { edges } = useWorkflowCanvasStore.getState();
    expect(edges).toHaveLength(1);
  });

  test('UT-3: rejects 11th edge from same handle (cap = 10)', () => {
    const extraNodes = Array.from({ length: 12 }, (_, i) => makeNode(`T${i}`));
    useWorkflowCanvasStore.setState((s) => ({
      nodes: [...s.nodes, ...extraNodes],
    }));

    // Add 9 more (total = 10 including the initial A→B)
    for (let i = 0; i < 9; i++) {
      useWorkflowCanvasStore.getState().onConnect({
        source: 'A',
        target: `T${i}`,
        sourceHandle: 'on_success',
        targetHandle: null,
      });
    }
    expect(useWorkflowCanvasStore.getState().edges).toHaveLength(10);

    // 11th should be blocked
    useWorkflowCanvasStore.getState().onConnect({
      source: 'A',
      target: 'T9',
      sourceHandle: 'on_success',
      targetHandle: null,
    });
    expect(useWorkflowCanvasStore.getState().edges).toHaveLength(10);
  });

  test('UT-4: blocks cycle (back-edge returns state unchanged)', () => {
    // A→B exists; B→A would create a cycle
    useWorkflowCanvasStore.getState().onConnect({
      source: 'B',
      target: 'A',
      sourceHandle: 'on_success',
      targetHandle: null,
    });
    const { edges } = useWorkflowCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges.some((e) => e.source === 'B' && e.target === 'A')).toBe(false);
  });

  test('UT-4b: blocks downstream edge back into loop left socket', () => {
    const loopNode = makeNode('loop-1', 'loop');
    const loopStartNode = { ...makeNode('loop-start-1', 'loop_start'), parentId: 'loop-1' };
    const afterLoopNode = makeNode('after-loop', 'delay');

    useWorkflowCanvasStore.setState({
      nodes: [loopNode, loopStartNode, afterLoopNode],
      edges: [makeEdge('loop-1', 'after-loop', 'on_complete')],
      isDirty: false,
      changeVersion: 0,
    });

    useWorkflowCanvasStore.getState().onConnect({
      source: 'after-loop',
      target: 'loop-start-1',
      sourceHandle: 'on_success',
      targetHandle: null,
    });

    const { edges } = useWorkflowCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges.some((e) => e.source === 'after-loop' && e.target === 'loop-start-1')).toBe(false);
  });

  test('UT-4c: blocks loop node from connecting to its own left socket', () => {
    const loopNode = makeNode('loop-1', 'loop');
    const loopStartNode = { ...makeNode('loop-start-1', 'loop_start'), parentId: 'loop-1' };

    useWorkflowCanvasStore.setState({
      nodes: [loopNode, loopStartNode],
      edges: [],
      isDirty: false,
      changeVersion: 0,
    });

    useWorkflowCanvasStore.getState().onConnect({
      source: 'loop-1',
      target: 'loop-start-1',
      sourceHandle: 'on_complete',
      targetHandle: null,
    });

    expect(useWorkflowCanvasStore.getState().edges).toHaveLength(0);
  });
});

// =============================================================================
// UT-5: computeExecutionEdges — fan-out classification
// =============================================================================

describe('computeExecutionEdges — fan-out all 3 edges classified traversed', () => {
  test('UT-5: all 3 on_success edges of a completed node are classified traversed', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')];
    const edges = [makeEdge('A', 'B'), makeEdge('A', 'C'), makeEdge('A', 'D')];
    const steps = [makeStep('A'), makeStep('B'), makeStep('C'), makeStep('D')];

    const result = computeExecutionEdges({ nodes, edges, steps });
    expect(result.traversed.has('A-on_success-B')).toBe(true);
    expect(result.traversed.has('A-on_success-C')).toBe(true);
    expect(result.traversed.has('A-on_success-D')).toBe(true);
  });
});

describe('workflow-canvas-store loop iteration overlay', () => {
  test('projects only the selected parallel loop iteration onto body nodes', () => {
    const loopNode = makeNode('Loop0001', 'loop');
    const firstPath = { ...makeNode('Delay0001', 'delay'), parentId: 'Loop0001' };
    const secondPath = { ...makeNode('API0001', 'api'), parentId: 'Loop0001' };

    useWorkflowCanvasStore.setState({
      nodes: [loopNode, firstPath, secondPath],
      edges: [],
      loopIterationData: null,
      selectedLoopIteration: {},
      baseExecutionOverlay: null,
      baseExecutionEdges: null,
      executionOverlay: null,
      executionEdges: null,
    });

    useWorkflowCanvasStore.getState().setLoopData('Loop0001', [
      {
        currentIndex: 0,
        currentItem: 1,
        steps: {
          Delay0001: { stepId: 'Delay0001', status: 'completed' },
        },
      },
      {
        currentIndex: 1,
        currentItem: 2,
        steps: {
          API0001: { stepId: 'API0001', status: 'failed' },
        },
      },
    ]);
    useWorkflowCanvasStore.getState().setSelectedLoopIteration('Loop0001', 1);
    useWorkflowCanvasStore
      .getState()
      .setBaseExecution({ Loop0001: 'completed' }, { traversed: new Set(), active: new Set() });

    expect(useWorkflowCanvasStore.getState().executionOverlay).toEqual({
      Loop0001: 'completed',
      API0001: 'failed',
    });
  });
});

// =============================================================================
// UT-6 and UT-7: MergerNodeConfig React component
// =============================================================================

describe('MergerNodeConfig', () => {
  beforeEach(() => {
    useWorkflowCanvasStore.setState({
      nodes: [makeNode('join'), makeNode('alpha'), makeNode('beta')],
      edges: [makeEdge('alpha', 'join'), makeEdge('beta', 'join')],
    });
  });

  test('UT-6: renders correct predecessor names, both unchecked by default', () => {
    render(<MergerNodeConfig nodeId="join" config={{}} onUpdate={() => {}} />);

    const alphaWrapper = screen.getByTestId('merger-predecessor-alpha');
    const betaWrapper = screen.getByTestId('merger-predecessor-beta');
    expect(alphaWrapper.querySelector('input')).not.toBeChecked();
    expect(betaWrapper.querySelector('input')).not.toBeChecked();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  test('UT-7a: toggle adds node ID to requiredPredecessors', () => {
    const updates: Record<string, unknown>[] = [];
    render(<MergerNodeConfig nodeId="join" config={{}} onUpdate={(cfg) => updates.push(cfg)} />);

    const alphaInput = screen
      .getByTestId('merger-predecessor-alpha')
      .querySelector('input') as HTMLInputElement;
    fireEvent.click(alphaInput);

    expect(updates).toHaveLength(1);
    expect(updates[0].requiredPredecessors as string[]).toContain('alpha');
  });

  test('UT-7b: removing edge makes component hidden (fewer than 2 predecessors)', () => {
    const { unmount } = render(<MergerNodeConfig nodeId="join" config={{}} onUpdate={() => {}} />);
    expect(screen.getByText('beta')).toBeInTheDocument();
    unmount();

    // Remove the beta→join edge so only 1 predecessor remains
    useWorkflowCanvasStore.setState((s) => ({
      edges: s.edges.filter((e) => !(e.source === 'beta' && e.target === 'join')),
    }));

    const { container } = render(
      <MergerNodeConfig nodeId="join" config={{}} onUpdate={() => {}} />,
    );
    // With only 1 predecessor the component returns null
    expect(container.firstChild).toBeNull();
  });
});
