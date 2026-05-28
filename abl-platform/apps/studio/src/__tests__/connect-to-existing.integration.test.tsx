/**
 * Integration tests for the "Connect to existing" feature.
 *
 * Covers:
 *   INT-1  ConnectToExistingSection renders the eligibility-filtered list
 *   INT-2  Clicking a row dispatches onConnect and closes the modal
 *   INT-3  Eligibility-filter / onConnect predicate parity (FR-4 invariant)
 *   INT-4  Search filter — reactive behaviour and empty-results state
 *   INT-5  Keyboard navigation — ArrowDown / ArrowUp / Enter
 *   INT-6  MergerNodeConfig auto-engages after picker creates 2nd incoming edge
 *
 * Pattern: RTL + real Zustand store — no mocks of platform components.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useWorkflowCanvasStore, MAX_FAN_OUT } from '../store/workflow-canvas-store';
import {
  isValidWorkflowConnection,
  getEligibleConnectTargets,
} from '../store/workflow-canvas-helpers';
import { ConnectToExistingSection } from '../components/workflows/canvas/nodes/ConnectToExistingSection';
import { MergerNodeConfig } from '../components/workflows/canvas/config/MergerNodeConfig';
import type { WorkflowFlowNode, WorkflowFlowEdge } from '../store/workflow-canvas-store';

// =============================================================================
// Shared helpers
// =============================================================================

function makeNode(
  id: string,
  nodeType = 'function',
  parentId?: string,
  label?: string,
): WorkflowFlowNode {
  return {
    id,
    type: 'workflowNode',
    position: { x: 0, y: 0 },
    parentId,
    data: {
      nodeType: nodeType as never,
      label: label ?? id,
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

// =============================================================================
// INT-1: Eligibility-filtered list rendering
// =============================================================================

describe('INT-1: ConnectToExistingSection renders the eligibility-filtered list', () => {
  beforeEach(() => {
    const start = makeNode('start', 'start');
    const condition = makeNode('condition', 'condition');
    const agent = makeNode('agent', 'agent');
    const end = makeNode('end', 'end');
    useWorkflowCanvasStore.setState({
      nodes: [start, condition, agent, end],
      edges: [makeEdge('start', 'condition')],
    });
  });

  test('shows only eligible candidates — not self, not ancestor', () => {
    render(
      <ConnectToExistingSection
        sourceNodeId="condition"
        sourceHandle="on_success_if_0"
        onClose={() => {}}
      />,
    );

    const rows = screen.queryAllByTestId(/^connect-to-existing-row-/);
    const rowIds = rows.map((el) =>
      el.getAttribute('data-testid')!.replace('connect-to-existing-row-', ''),
    );

    // Only agent and end are eligible; start creates a cycle; condition is self
    expect(rowIds).toHaveLength(2);
    expect(rowIds).toContain('agent');
    expect(rowIds).toContain('end');
    expect(rowIds).not.toContain('start');
    expect(rowIds).not.toContain('condition');
  });

  test('empty-state message renders when there are zero eligible candidates', () => {
    // Only Start exists on canvas — it is the source; no candidates
    useWorkflowCanvasStore.setState({
      nodes: [makeNode('start', 'start')],
      edges: [],
    });
    render(
      <ConnectToExistingSection
        sourceNodeId="start"
        sourceHandle="on_success"
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('connect-to-existing-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^connect-to-existing-row-/)).toHaveLength(0);
  });
});

// =============================================================================
// INT-2: Click-to-connect dispatches onConnect and calls onClose
// =============================================================================

describe('INT-2: clicking a row dispatches onConnect and closes the modal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
    const start = makeNode('start', 'start');
    const condition = makeNode('condition', 'condition');
    const agent = makeNode('agent', 'agent');
    const end = makeNode('end', 'end');
    useWorkflowCanvasStore.setState({
      nodes: [start, condition, agent, end],
      edges: [makeEdge('start', 'condition')],
      isDirty: false,
    });
  });

  test('adds the correct edge to the store and calls onClose exactly once', () => {
    render(
      <ConnectToExistingSection
        sourceNodeId="condition"
        sourceHandle="on_success_if_0"
        onClose={onClose}
      />,
    );

    const agentRow = screen.getByTestId('connect-to-existing-row-agent');
    fireEvent.click(agentRow);

    // onClose must have been called
    expect(onClose).toHaveBeenCalledTimes(1);

    // The edge must exist in the store
    const { edges } = useWorkflowCanvasStore.getState();
    const newEdge = edges.find(
      (e) =>
        e.source === 'condition' && e.sourceHandle === 'on_success_if_0' && e.target === 'agent',
    );
    expect(newEdge).toBeDefined();

    // Other existing edges untouched
    const startToCondition = edges.find((e) => e.source === 'start' && e.target === 'condition');
    expect(startToCondition).toBeDefined();
  });
});

// =============================================================================
// INT-3: Predicate parity across 6 graph fixtures
// =============================================================================

describe('INT-3: getEligibleConnectTargets matches onConnect composite predicate', () => {
  // Build the composite "would onConnect accept this?" predicate.
  // Mirrors workflow-canvas-store.ts onConnect guards:
  //   (a) no duplicate edge (same source + sourceHandle + target)
  //   (b) fan-out cap — fewer than MAX_FAN_OUT outgoing edges on this handle
  //   (c) isValidWorkflowConnection — scope + cycle
  function wouldOnConnectAccept(
    nodes: WorkflowFlowNode[],
    edges: WorkflowFlowEdge[],
    sourceId: string,
    sourceHandle: string,
    candidateId: string,
  ): boolean {
    // (b) fan-out cap
    const fanOut = edges.filter(
      (e) => e.source === sourceId && e.sourceHandle === sourceHandle,
    ).length;
    if (fanOut >= MAX_FAN_OUT) return false;
    // (a) duplicate
    const isDuplicate = edges.some(
      (e) => e.source === sourceId && e.sourceHandle === sourceHandle && e.target === candidateId,
    );
    if (isDuplicate) return false;
    // (c) isValidWorkflowConnection
    return isValidWorkflowConnection(edges, nodes, {
      source: sourceId,
      sourceHandle,
      target: candidateId,
      targetHandle: null,
    });
  }

  function assertParity(
    label: string,
    nodes: WorkflowFlowNode[],
    edges: WorkflowFlowEdge[],
    sourceId: string,
    sourceHandle: string,
  ) {
    const eligible = getEligibleConnectTargets(nodes, edges, sourceId, sourceHandle, MAX_FAN_OUT);
    const eligibleIds = new Set(eligible.map((n) => n.id));

    // Build the set of nodes the composite predicate would accept
    const wouldAccept = new Set(
      nodes
        .filter((n) => n.id !== sourceId)
        .filter((n) => wouldOnConnectAccept(nodes, edges, sourceId, sourceHandle, n.id))
        .map((n) => n.id),
    );

    // getEligibleConnectTargets additionally excludes start, loop_start, loop_end
    // from the visible picker even though isValidWorkflowConnection may allow them.
    // This is by design (loop_start/loop_end are internal sockets; start never gets
    // incoming edges). Remove those from wouldAccept for this parity assertion.
    const pickerExclusions = new Set(
      nodes
        .filter((n) => ['start', 'loop_start', 'loop_end'].includes(n.data.nodeType as string))
        .map((n) => n.id),
    );
    for (const id of pickerExclusions) wouldAccept.delete(id);

    expect(eligibleIds, `Parity failure in fixture ${label}`).toEqual(wouldAccept);
  }

  test('F1: single Start node — no candidates', () => {
    const nodes = [makeNode('start', 'start')];
    assertParity('F1', nodes, [], 'start', 'on_success');
  });

  test('F2: linear chain Start→A→B→End — from A: B and End eligible', () => {
    const nodes = [
      makeNode('start', 'start'),
      makeNode('A'),
      makeNode('B'),
      makeNode('end', 'end'),
    ];
    const edges = [makeEdge('start', 'A'), makeEdge('A', 'B'), makeEdge('B', 'end')];
    assertParity('F2', nodes, edges, 'A', 'on_success');
  });

  test('F3: diamond half-built — from Condition if_0: End eligible', () => {
    const nodes = [
      makeNode('start', 'start'),
      makeNode('cond', 'condition'),
      makeNode('end', 'end'),
    ];
    const edges = [makeEdge('start', 'cond')];
    assertParity('F3', nodes, edges, 'cond', 'on_success_if_0');
  });

  test('F4: source handle at fan-out cap — empty list', () => {
    const source = makeNode('src');
    const targets = Array.from({ length: 12 }, (_, i) => makeNode(`T${i}`));
    const nodes = [source, ...targets];
    const edges = Array.from({ length: 10 }, (_, i) => makeEdge('src', `T${i}`));
    assertParity('F4', nodes, edges, 'src', 'on_success');
  });

  test('F5: source inside loop body — outside nodes excluded', () => {
    const outsideA = makeNode('outsideA');
    const outsideEnd = makeNode('outsideEnd', 'end');
    const loop = makeNode('loop-1', 'loop');
    const insideSrc = makeNode('insideSrc', 'function', 'loop-1');
    const insideSibling = makeNode('insideSib', 'function', 'loop-1');
    const nodes = [outsideA, outsideEnd, loop, insideSrc, insideSibling];
    assertParity('F5', nodes, [], 'insideSrc', 'on_success');
  });

  test('F6: pre-existing edge from source handle — duplicate excluded', () => {
    const src = makeNode('src');
    const alreadyConnected = makeNode('already');
    const fresh = makeNode('fresh');
    const nodes = [src, alreadyConnected, fresh];
    const edges = [makeEdge('src', 'already')];
    assertParity('F6', nodes, edges, 'src', 'on_success');
  });
});

// =============================================================================
// INT-4: Search filter — reactive behaviour and empty results
// =============================================================================

describe('INT-4: search filter reactive behaviour', () => {
  beforeEach(() => {
    useWorkflowCanvasStore.setState({
      nodes: [
        makeNode('start', 'start'),
        makeNode('fn-format', 'function', undefined, 'Format'),
        makeNode('fn-compute', 'function', undefined, 'Compute'),
        makeNode('ag-refund', 'agent', undefined, 'Refund'),
        makeNode('end', 'end'),
        makeNode('tl-send', 'tool', undefined, 'Send Email'),
      ],
      edges: [],
    });
  });

  test('shows all eligible rows initially, filters by label, resets on clear', async () => {
    const user = userEvent.setup();
    render(
      <ConnectToExistingSection
        sourceNodeId="start"
        sourceHandle="on_success"
        onClose={() => {}}
      />,
    );

    // All 5 eligible nodes (everything except start itself)
    expect(screen.queryAllByTestId(/^connect-to-existing-row-/)).toHaveLength(5);

    const search = screen.getByTestId('connect-to-existing-search');

    // Filter by label (case-insensitive)
    await user.type(search, 'format');
    expect(screen.queryAllByTestId(/^connect-to-existing-row-/)).toHaveLength(1);

    // Clear → back to 5
    await user.clear(search);
    expect(screen.queryAllByTestId(/^connect-to-existing-row-/)).toHaveLength(5);

    // Filter by node type
    await user.type(search, 'agent');
    expect(screen.queryAllByTestId(/^connect-to-existing-row-/)).toHaveLength(1);
  });

  test('shows no-matches message when query matches nothing', async () => {
    const user = userEvent.setup();
    render(
      <ConnectToExistingSection
        sourceNodeId="start"
        sourceHandle="on_success"
        onClose={() => {}}
      />,
    );

    const search = screen.getByTestId('connect-to-existing-search');
    await user.type(search, 'xyz123nope');

    expect(screen.queryAllByTestId(/^connect-to-existing-row-/)).toHaveLength(0);
    expect(screen.getByTestId('connect-to-existing-no-matches')).toBeInTheDocument();
  });
});

// =============================================================================
// INT-5: Keyboard navigation
// =============================================================================

describe('INT-5: keyboard navigation — arrow keys and Enter', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
    useWorkflowCanvasStore.setState({
      nodes: [
        makeNode('start', 'start'),
        makeNode('A', 'function', undefined, 'Alpha'),
        makeNode('B', 'agent', undefined, 'Beta'),
        makeNode('C', 'end', undefined, 'Gamma'),
      ],
      edges: [],
    });
  });

  test('ArrowDown moves focus through rows; Enter fires the pick', () => {
    render(
      <ConnectToExistingSection sourceNodeId="start" sourceHandle="on_success" onClose={onClose} />,
    );

    const container = screen.getByTestId('connect-to-existing-section');

    // Nodes sort alphabetically by label: Alpha (A), Beta (B), Gamma (C)
    const rows = screen.queryAllByTestId(/^connect-to-existing-row-/);
    expect(rows).toHaveLength(3);

    // ArrowDown from section focuses first row
    fireEvent.keyDown(container, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[0]);

    // ArrowDown again → second row
    fireEvent.keyDown(container, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);

    // ArrowUp → back to first
    fireEvent.keyDown(container, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[0]);

    // Enter on first row → fires pick and calls onClose
    fireEvent.keyDown(container, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Edge was created for row[0]'s node (Alpha / A)
    const { edges } = useWorkflowCanvasStore.getState();
    const created = edges.find((e) => e.source === 'start' && e.target === 'A');
    expect(created).toBeDefined();
  });
});

// =============================================================================
// INT-6: MergerNodeConfig auto-engages after picker creates 2nd incoming edge
// =============================================================================

describe('INT-6: MergerNodeConfig auto-engages on fan-in', () => {
  test('MergerNodeConfig becomes visible when in-degree reaches 2', () => {
    // Setup: target Function has 1 incoming edge already (alpha → target)
    useWorkflowCanvasStore.setState({
      nodes: [makeNode('alpha'), makeNode('beta'), makeNode('target', 'function')],
      edges: [makeEdge('alpha', 'target')],
      isDirty: false,
    });

    const onClose = vi.fn();

    // Render both the picker (to add 2nd edge) and the MergerNodeConfig
    const { rerender } = render(
      <>
        <ConnectToExistingSection sourceNodeId="beta" sourceHandle="on_success" onClose={onClose} />
        <MergerNodeConfig nodeId="target" config={{}} onUpdate={() => {}} />
      </>,
    );

    // Before click: only 1 predecessor → MergerNodeConfig returns null
    expect(screen.queryByTestId('merger-node-config')).not.toBeInTheDocument();

    // Click target row in the picker (beta → target)
    fireEvent.click(screen.getByTestId('connect-to-existing-row-target'));
    expect(onClose).toHaveBeenCalledOnce();

    // Re-render so the MergerNodeConfig picks up the updated store state
    rerender(
      <>
        <ConnectToExistingSection sourceNodeId="beta" sourceHandle="on_success" onClose={onClose} />
        <MergerNodeConfig nodeId="target" config={{}} onUpdate={() => {}} />
      </>,
    );

    // After click: in-degree = 2 → MergerNodeConfig must render
    expect(screen.getByTestId('merger-node-config')).toBeInTheDocument();
  });
});
