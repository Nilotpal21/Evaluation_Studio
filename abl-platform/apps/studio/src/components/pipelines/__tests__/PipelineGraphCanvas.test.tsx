/**
 * PipelineGraphCanvas Tests
 *
 * @vitest-environment happy-dom
 */

import React, { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { usePipelineEditorStore } from '../../../store/pipeline-editor-store';
import { TRIGGER_NODE_ID } from '../pipeline-trigger-constants';

let graphChangeDispatches = 0;

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react');

  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      createElement(ReactModule.Fragment, null, children),
    ReactFlow: ({
      onNodesChange,
      onEdgesChange,
    }: {
      onNodesChange?: (changes: unknown[]) => void;
      onEdgesChange?: (changes: unknown[]) => void;
    }) => {
      ReactModule.useEffect(() => {
        graphChangeDispatches += 1;
        onNodesChange?.([
          { id: 'step-1', type: 'dimensions', dimensions: { width: 240, height: 96 } },
        ]);
        onEdgesChange?.([{ id: 'e-trigger-step-1', type: 'select', selected: false }]);
      }, [onEdgesChange, onNodesChange]);

      return createElement('div', { 'data-testid': 'react-flow' });
    },
    MiniMap: () => null,
    Background: () => null,
    Controls: () => null,
    BackgroundVariant: { Dots: 'dots' },
    ConnectionLineType: { SmoothStep: 'smoothstep' },
    useReactFlow: () => ({
      screenToFlowPosition: (position: { x: number; y: number }) => position,
    }),
    applyNodeChanges: <T,>(_changes: unknown[], nodes: T[]) => nodes,
    applyEdgeChanges: <T,>(_changes: unknown[], edges: T[]) => edges,
  };
});

import { PipelineGraphCanvas } from '../PipelineGraphCanvas';

describe('PipelineGraphCanvas', () => {
  beforeEach(() => {
    graphChangeDispatches = 0;
    usePipelineEditorStore.getState().reset();

    usePipelineEditorStore.getState().setPipeline(
      'pipeline-1',
      'Custom Friction Preview',
      'active',
      [
        {
          id: TRIGGER_NODE_ID,
          type: 'pipelineTriggerNode',
          position: { x: 120, y: 40 },
          data: {
            label: 'Trigger',
            triggerCount: 1,
            triggerSummary: 'Manual',
          },
        },
        {
          id: 'step-1',
          type: 'pipelineNode',
          position: { x: 120, y: 220 },
          data: {
            label: 'Read messages',
            activityType: 'read-message-window',
            category: 'compute',
            config: {},
          },
        },
      ],
      [
        {
          id: 'e-trigger-step-1',
          source: TRIGGER_NODE_ID,
          target: 'step-1',
          type: 'pipelineEdge',
        },
      ],
      [{ triggerId: 'manual' }],
    );
  });

  it('does not mark the editor dirty for React Flow mount-time sync changes', async () => {
    render(createElement(PipelineGraphCanvas));

    await waitFor(() => {
      expect(graphChangeDispatches).toBeGreaterThan(0);
    });

    expect(usePipelineEditorStore.getState().isDirty).toBe(false);
  });
});
