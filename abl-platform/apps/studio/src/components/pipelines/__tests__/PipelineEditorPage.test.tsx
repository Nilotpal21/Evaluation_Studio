/**
 * PipelineEditorPage Tests
 *
 * @vitest-environment happy-dom
 */

import React, { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TRIGGER_NODE_ID } from '../pipeline-trigger-constants';
import { usePipelineEditorStore } from '../../../store/pipeline-editor-store';

const navigate = vi.fn();
const setActiveTab = vi.fn();
const openRun = vi.fn();

interface SwrState {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
  mutate?: ReturnType<typeof vi.fn>;
}

const swrResponses = new Map<string, SwrState>();

vi.mock('swr', () => ({
  default: vi.fn((key: string | null) => {
    if (!key) {
      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    }

    return (
      swrResponses.get(key) ?? {
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      }
    );
  }),
}));

vi.mock('../../../store/navigation-store', () => ({
  useNavigationStore: vi.fn(
    (selector?: (state: { navigate: typeof navigate; subPage: string }) => unknown) => {
      const state = {
        navigate,
        subPage: 'pipeline-1',
      };
      return selector ? selector(state) : state;
    },
  ),
}));

vi.mock('../../../store/project-store', () => ({
  useProjectStore: vi.fn((selector?: (state: { currentProjectId: string | null }) => unknown) => {
    const state = {
      currentProjectId: 'proj-1',
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../../store/pipeline-list-store', () => ({
  usePipelineListStore: vi.fn(
    (selector?: (state: { setActiveTab: typeof setActiveTab }) => unknown) => {
      const state = { setActiveTab };
      return selector ? selector(state) : state;
    },
  ),
}));

vi.mock('../../../store/pipeline-runs-store', () => ({
  useRunsStore: vi.fn((selector?: (state: { openRun: typeof openRun }) => unknown) => {
    const state = { openRun };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../usePipelineAutoLayout', () => ({
  usePipelineAutoLayout: () => ({
    autoLayout: vi.fn(async (nodes: unknown[]) => nodes),
  }),
}));

vi.mock('../PipelineEditorToolbar', () => ({
  PipelineEditorToolbar: ({ testDisabled }: { testDisabled?: boolean }) =>
    createElement('div', { 'data-testid': 'toolbar' }, String(Boolean(testDisabled))),
}));

vi.mock('../NodePalette', () => ({
  NodePalette: () => createElement('div', { 'data-testid': 'node-palette' }),
}));

vi.mock('../PipelineGraphCanvas', () => ({
  PipelineGraphCanvas: () => createElement('div', { 'data-testid': 'pipeline-graph-canvas' }),
}));

vi.mock('../NodeConfigPanel', () => ({
  NodeConfigPanel: () => createElement('div', { 'data-testid': 'node-config-panel' }),
}));

vi.mock('../PipelineTestDrawer', () => ({
  PipelineTestDrawer: () => null,
}));

import { PipelineEditorPage } from '../PipelineEditorPage';

describe('PipelineEditorPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    setActiveTab.mockReset();
    openRun.mockReset();
    swrResponses.clear();
    usePipelineEditorStore.getState().reset();

    swrResponses.set('/api/pipelines/pipeline-1', {
      data: {
        _id: 'pipeline-1',
        name: 'Custom Friction Preview',
        status: 'active',
        entryNodeId: 'step-1',
        nodes: [
          {
            id: 'step-1',
            type: 'read-message-window',
            label: 'Read messages',
            config: {},
            transitions: [],
            position: { x: 120, y: 220 },
          },
        ],
        supportedTriggers: [
          {
            id: 'manual',
            type: 'manual',
            strategy: 'default',
            label: 'Manual',
            description: 'Manual trigger',
          },
        ],
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });

    swrResponses.set('/api/pipelines/nodes', {
      data: {
        success: true,
        data: [],
      },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });
  });

  it('hydrates saved triggers without dirtying the editor when trigger definitions are still loading', async () => {
    render(createElement(PipelineEditorPage));

    await waitFor(() => {
      expect(usePipelineEditorStore.getState().pipelineId).toBe('pipeline-1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('toolbar')).toHaveTextContent('false');
    });

    const state = usePipelineEditorStore.getState();
    const triggerNode = state.nodes.find((node) => node.id === TRIGGER_NODE_ID);

    expect(state.selectedTriggers).toEqual([{ triggerId: 'manual', schedule: undefined }]);
    expect(state.isDirty).toBe(false);
    expect(triggerNode).toBeDefined();
    expect(triggerNode?.data).toMatchObject({
      triggerCount: 1,
      triggerSummary: 'Manual',
    });
  });
});
