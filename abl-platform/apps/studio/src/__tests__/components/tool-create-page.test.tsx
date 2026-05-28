/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockNavigate = vi.fn();
const mockAddTool = vi.fn();
const mockCreateTool = vi.fn();

vi.mock('../../store/project-store', () => ({
  useProjectStore: () => ({
    currentProject: { id: 'proj-1' },
  }),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({
    navigate: mockNavigate,
  }),
}));

vi.mock('../../store/tool-store', () => ({
  useToolStore: () => ({
    addTool: mockAddTool,
  }),
}));

vi.mock('../../api/tools', () => ({
  createTool: (...args: unknown[]) => mockCreateTool(...args),
}));

vi.mock('@agent-platform/shared/tools', () => ({
  normalizeHttpAuthConfig: vi.fn(() => null),
}));

vi.mock('../../components/tools/wizard/HttpToolWizard', () => ({
  HttpToolWizard: ({
    onCancel,
    onSubmit,
  }: {
    onCancel: () => void;
    onSubmit: (data: {
      name: string;
      description: string;
      httpConfig: {
        endpoint: string;
        method: string;
        authType: string;
        parameters: unknown[];
      };
    }) => Promise<void>;
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement('button', { onClick: onCancel }, 'Cancel tool creation'),
      React.createElement(
        'button',
        {
          onClick: () =>
            onSubmit({
              name: 'weather_lookup',
              description: 'Fetch weather',
              httpConfig: {
                endpoint: 'https://api.example.com/weather',
                method: 'GET',
                authType: 'none',
                parameters: [],
              },
            }),
        },
        'Save tool',
      ),
    ),
}));

vi.mock('../../components/tools/wizard/SandboxToolWizard', () => ({
  SandboxToolWizard: () => null,
}));

vi.mock('../../components/tools/wizard/McpToolWizard', () => ({
  McpToolWizard: () => null,
}));

import { ToolCreatePage } from '../../components/tools/ToolCreatePage';

const AGENT_TOOLS_RETURN_PATH = '/projects/proj-1/agents/ShopAssist_Supervisor#tools';

describe('ToolCreatePage agent Tools return navigation (ABLP-839)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockAddTool.mockClear();
    mockCreateTool.mockReset();
    window.history.pushState(
      {},
      '',
      `/projects/proj-1/tools/new?type=http&returnTo=${encodeURIComponent(
        AGENT_TOOLS_RETURN_PATH,
      )}`,
    );
  });

  it('returns to the originating agent Tools section when creation is cancelled', async () => {
    render(<ToolCreatePage />);

    fireEvent.click(await screen.findByRole('button', { name: /cancel tool creation/i }));

    expect(mockNavigate).toHaveBeenCalledWith(AGENT_TOOLS_RETURN_PATH, { replace: true });
  });

  it('returns to the originating agent Tools section after saving a new tool', async () => {
    mockCreateTool.mockResolvedValue({
      tool: {
        id: 'tool-1',
        name: 'weather_lookup',
        toolType: 'http',
      },
    });

    render(<ToolCreatePage />);

    fireEvent.click(await screen.findByRole('button', { name: /save tool/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(AGENT_TOOLS_RETURN_PATH, { replace: true });
    });
    expect(mockAddTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tool-1', name: 'weather_lookup' }),
    );
  });

  it('rejects an external return target and falls back to the project tools list on cancel', async () => {
    window.history.pushState(
      {},
      '',
      `/projects/proj-1/tools/new?type=http&returnTo=${encodeURIComponent(
        'https://evil.example/projects/proj-1/agents/ShopAssist_Supervisor#tools',
      )}`,
    );

    render(<ToolCreatePage />);

    fireEvent.click(await screen.findByRole('button', { name: /cancel tool creation/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tools', { replace: true });
  });

  it('rejects a cross-project return target and falls back to the created tool detail', async () => {
    window.history.pushState(
      {},
      '',
      `/projects/proj-1/tools/new?type=http&returnTo=${encodeURIComponent(
        '/projects/proj-2/agents/ShopAssist_Supervisor#tools',
      )}`,
    );
    mockCreateTool.mockResolvedValue({
      tool: {
        id: 'tool-1',
        name: 'weather_lookup',
        toolType: 'http',
      },
    });

    render(<ToolCreatePage />);

    fireEvent.click(await screen.findByRole('button', { name: /save tool/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/projects/proj-1/tools/tool-1', {
        replace: true,
      });
    });
  });
});
