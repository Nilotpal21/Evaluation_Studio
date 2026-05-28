/**
 * @vitest-environment happy-dom
 */

import React, { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowEdgeComponent } from '../components/workflows/canvas/edges/WorkflowEdgeComponent';
import { useWorkflowCanvasStore } from '../store/workflow-canvas-store';

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react');

  return {
    BaseEdge: ({
      id,
      path,
      style,
      markerEnd,
      'data-testid': dataTestId,
    }: {
      id: string;
      path: string;
      style?: React.CSSProperties;
      markerEnd?: string;
      'data-testid'?: string;
    }) =>
      createElement('path', {
        id,
        d: path,
        style,
        markerEnd,
        'data-testid': dataTestId,
      }),
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) =>
      createElement(ReactModule.Fragment, null, children),
    getBezierPath: () => ['M0,0 C25,0 75,0 100,0', 50, 0],
  };
});

const FAILURE_STROKE = 'hsl(var(--error, 0 72.2% 50.6%))';
const SUCCESS_STROKE = 'hsl(var(--success, 142.1 76.2% 36.3%))';
const DEFAULT_STROKE = 'hsl(var(--border, 220 4% 18%))';
const FAILURE_ACTIVE_GLOW = 'drop-shadow(0 0 4px rgba(220, 38, 38, 0.4))';

function renderEdge(props: { id: string; sourceHandleId: string }) {
  return render(
    createElement(WorkflowEdgeComponent, {
      id: props.id,
      source: 'source-node',
      target: 'target-node',
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 0,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceHandleId: props.sourceHandleId,
      selected: false,
      data: {},
    } as never),
  );
}

describe('WorkflowEdgeComponent', () => {
  beforeEach(() => {
    useWorkflowCanvasStore.getState().setExecutionEdges(null);
  });

  it('renders failure-path edges in the failure color before execution starts', () => {
    renderEdge({
      id: 'pre-run-failure-edge',
      sourceHandleId: 'on_failure',
    });

    const edge = screen.getByTestId('workflow-edge-pre-run-failure-edge') as SVGPathElement;

    expect(edge.style.stroke).toBe(FAILURE_STROKE);
  });

  it('keeps unreached failure-path edges in the default color during execution', () => {
    useWorkflowCanvasStore.getState().setExecutionEdges({
      traversed: new Set(),
      active: new Set(),
    });

    renderEdge({
      id: 'idle-failure-edge',
      sourceHandleId: 'on_failure',
    });

    const edge = screen.getByTestId('workflow-edge-idle-failure-edge') as SVGPathElement;

    expect(edge.style.stroke).toBe(DEFAULT_STROKE);
  });

  it('renders traversed failure-path edges in the failure color', () => {
    useWorkflowCanvasStore.getState().setExecutionEdges({
      traversed: new Set(['failure-edge']),
      active: new Set(),
    });

    const { container } = renderEdge({
      id: 'failure-edge',
      sourceHandleId: 'on_failure',
    });

    const edge = screen.getByTestId('workflow-edge-failure-edge') as SVGPathElement;
    const glow = container.querySelector('path:not([data-testid])');

    expect(edge.style.stroke).toBe(FAILURE_STROKE);
    expect(glow).toHaveAttribute('stroke', FAILURE_STROKE);
  });

  it('keeps traversed success-path edges in the success color', () => {
    useWorkflowCanvasStore.getState().setExecutionEdges({
      traversed: new Set(['success-edge']),
      active: new Set(),
    });

    renderEdge({
      id: 'success-edge',
      sourceHandleId: 'on_success',
    });

    const edge = screen.getByTestId('workflow-edge-success-edge') as SVGPathElement;

    expect(edge.style.stroke).toBe(SUCCESS_STROKE);
  });

  it('renders active failure-path edges with failure stroke and glow', () => {
    useWorkflowCanvasStore.getState().setExecutionEdges({
      traversed: new Set(),
      active: new Set(['active-failure-edge']),
    });

    renderEdge({
      id: 'active-failure-edge',
      sourceHandleId: 'on_failure',
    });

    const edge = screen.getByTestId('workflow-edge-active-failure-edge') as SVGPathElement;

    expect(edge.style.stroke).toBe(FAILURE_STROKE);
    expect(edge.style.filter).toBe(FAILURE_ACTIVE_GLOW);
  });
});
