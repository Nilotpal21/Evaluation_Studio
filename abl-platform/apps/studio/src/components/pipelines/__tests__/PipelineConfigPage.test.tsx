/**
 * PipelineConfigPage Tests
 *
 * @vitest-environment happy-dom
 */

import React, { createElement } from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const navigate = vi.fn();
const openRun = vi.fn();
const mutateConfig = vi.fn();
const mutateSchema = vi.fn();
const mutateTriggers = vi.fn();

interface SwrState {
  data?: unknown;
  error?: unknown;
  isLoading: boolean;
  mutate: ReturnType<typeof vi.fn>;
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
        subPage: 'friction_detection',
      };
      return selector ? selector(state) : state;
    },
  ),
}));

vi.mock('../../../store/project-store', () => ({
  useProjectStore: vi.fn((selector?: (state: { currentProject: { id: string } }) => unknown) => {
    const state = {
      currentProject: { id: 'proj-1' },
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../../store/pipeline-runs-store', () => ({
  useRunsStore: vi.fn((selector?: (state: { openRun: typeof openRun }) => unknown) => {
    const state = { openRun };
    return selector ? selector(state) : state;
  }),
}));

vi.mock('../../ui/Button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => createElement('button', { type: 'button', disabled, onClick }, children),
}));

vi.mock('../../ui/Badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../ui/Toggle', () => ({
  Toggle: ({
    checked,
    label,
    onChange,
  }: {
    checked: boolean;
    label: string;
    onChange: () => void;
  }) =>
    createElement(
      'button',
      { type: 'button', 'data-checked': checked ? 'true' : 'false', onClick: onChange },
      label,
    ),
}));

vi.mock('../../ui/Tabs', () => ({
  Tabs: ({
    tabs,
    activeTab,
    onTabChange,
  }: {
    tabs: Array<{ id: string; label: string }>;
    activeTab: string;
    onTabChange: (id: string) => void;
  }) =>
    createElement(
      'div',
      null,
      tabs.map((tab) =>
        createElement(
          'button',
          {
            key: tab.id,
            type: 'button',
            'data-active': tab.id === activeTab ? 'true' : 'false',
            onClick: () => onTabChange(tab.id),
          },
          tab.label,
        ),
      ),
    ),
}));

vi.mock('../../ui/ErrorAlert', () => ({
  ErrorAlert: ({ error }: { error: string | string[] }) =>
    createElement('div', { 'data-testid': 'error-alert' }, String(error)),
}));

vi.mock('../ConfigSchemaForm', () => ({
  ConfigSchemaForm: () => createElement('div', { 'data-testid': 'config-schema-form' }),
}));

vi.mock('../TriggerManager', () => ({
  TriggerManager: () => createElement('div', { 'data-testid': 'trigger-manager' }),
}));

vi.mock('../runs/RecentRunsPanel', () => ({
  RecentRunsPanel: () => createElement('div', { 'data-testid': 'recent-runs-panel' }),
}));

vi.mock('../PipelineTestDrawer', () => ({
  PipelineTestDrawer: ({ open }: { open: boolean }) =>
    open ? createElement('div', { 'data-testid': 'pipeline-test-drawer' }) : null,
}));

import { PipelineConfigPage } from '../PipelineConfigPage';

describe('PipelineConfigPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    openRun.mockReset();
    mutateConfig.mockReset();
    mutateSchema.mockReset();
    mutateTriggers.mockReset();
    swrResponses.clear();

    swrResponses.set('/api/projects/proj-1/pipeline-config/friction_detection', {
      data: {
        success: true,
        data: {
          pipelineType: 'friction_detection',
          version: 1,
          enabled: true,
          config: {},
          activeTriggers: ['batch'],
          triggerConfigs: {},
        },
      },
      error: undefined,
      isLoading: false,
      mutate: mutateConfig,
    });

    swrResponses.set('/api/projects/proj-1/pipeline-config/friction_detection/schema', {
      data: {
        success: true,
        data: {
          fields: [],
          sharedFields: [],
        },
      },
      error: undefined,
      isLoading: false,
      mutate: mutateSchema,
    });

    swrResponses.set('/api/projects/proj-1/pipeline-config/friction_detection/triggers', {
      data: {
        success: true,
        data: {
          triggers: [
            {
              id: 'batch',
              type: 'kafka',
              strategy: 'batch',
              label: 'On session end',
              description: 'Full trajectory friction analysis',
              kafkaTopic: 'abl.session.ended',
              executionMode: 'batch',
              active: true,
              samplingRate: 1,
            },
            {
              id: 'realtime-user',
              type: 'kafka',
              strategy: 'realtime',
              label: 'On each user message',
              description: 'Realtime frustration detection',
              kafkaTopic: 'abl.message.user',
              executionMode: 'realtime',
              active: false,
              samplingRate: 1,
            },
          ],
          defaultTriggerIds: ['batch'],
        },
      },
      error: undefined,
      isLoading: false,
      mutate: mutateTriggers,
    });
  });

  it('does not mark the page dirty when trigger sampling only comes from effective defaults', async () => {
    render(createElement(PipelineConfigPage));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Test$/ })).toBeEnabled();
    });

    expect(screen.queryByRole('button', { name: /^Discard$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
  });
});
