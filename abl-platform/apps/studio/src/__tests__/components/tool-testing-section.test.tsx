import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToolTestingSection } from '../../components/tools/sections/ToolTestingSection';
import {
  getToolTestEndpointFixture,
  updateToolTestEndpointFixture,
  type ToolTestEndpointFixture,
} from '../../api/tools';

vi.mock('../../api/tools', () => ({
  getToolTestEndpointFixture: vi.fn(),
  updateToolTestEndpointFixture: vi.fn(),
}));

const fixture: ToolTestEndpointFixture = {
  endpointId: 'endpoint-1',
  projectToolId: 'tool-1',
  toolName: 'get_order',
  status: 'active',
  staticResponse: { status: 'delayed', promised_delivery_date: '2026-05-19' },
  sampleInput: { order_id: 'VM-48217-A' },
  urls: {
    invokeUrl: 'https://studio.example.com/api/public/tool-test/tti_1',
    specUrl: 'https://studio.example.com/api/public/tool-test/specs/tts_1/openapi.json',
  },
  version: 1,
  updatedAt: '2026-05-16T00:00:00.000Z',
};

describe('ToolTestingSection', () => {
  beforeEach(() => {
    vi.mocked(getToolTestEndpointFixture).mockReset();
    vi.mocked(updateToolTestEndpointFixture).mockReset();
  });

  test('loads and saves hosted tool-test fixture JSON', async () => {
    const user = userEvent.setup();
    vi.mocked(getToolTestEndpointFixture).mockResolvedValue(fixture);
    vi.mocked(updateToolTestEndpointFixture).mockImplementation(
      async (_projectId, _toolId, input) => ({
        ...fixture,
        staticResponse: input.staticResponse ?? fixture.staticResponse,
        sampleInput: input.sampleInput !== undefined ? input.sampleInput : fixture.sampleInput,
        version: 2,
      }),
    );

    render(
      <ToolTestingSection
        projectId="project-1"
        toolId="tool-1"
        latestTestResult={null}
        onTestClick={vi.fn()}
        onRerunTest={vi.fn()}
        onClearResult={vi.fn()}
      />,
    );

    expect(await screen.findByText('Tool-Test Fixture')).toBeInTheDocument();
    expect(screen.getByText('v1 - active')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Static response'), {
      target: { value: '{"status":"replaced"}' },
    });
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(updateToolTestEndpointFixture).toHaveBeenCalledWith('project-1', 'tool-1', {
        staticResponse: { status: 'replaced' },
        sampleInput: { order_id: 'VM-48217-A' },
      });
    });
    expect(await screen.findByText('v2 - active')).toBeInTheDocument();
  });

  test('creates a hosted fixture from the empty editor when none exists', async () => {
    vi.mocked(getToolTestEndpointFixture).mockResolvedValue(null);
    vi.mocked(updateToolTestEndpointFixture).mockResolvedValue({
      ...fixture,
      staticResponse: {},
      sampleInput: null,
      version: 1,
    });

    render(
      <ToolTestingSection
        projectId="project-1"
        toolId="tool-1"
        latestTestResult={null}
        onTestClick={vi.fn()}
        onRerunTest={vi.fn()}
        onClearResult={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getToolTestEndpointFixture).toHaveBeenCalledWith('project-1', 'tool-1');
    });
    expect(await screen.findByText('Tool-Test Fixture')).toBeInTheDocument();
    expect(screen.getByText('Not created')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Static response'), {
      target: { value: '{}' },
    });
    fireEvent.change(screen.getByLabelText('Sample input'), {
      target: { value: 'null' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(updateToolTestEndpointFixture).toHaveBeenCalledWith('project-1', 'tool-1', {
        staticResponse: {},
        sampleInput: null,
      });
    });
    expect(await screen.findByText('v1 - active')).toBeInTheDocument();
  });

  test('preserves an existing null sample input when saving static response edits', async () => {
    const user = userEvent.setup();
    const nullSampleFixture: ToolTestEndpointFixture = {
      ...fixture,
      sampleInput: null,
    };

    vi.mocked(getToolTestEndpointFixture).mockResolvedValue(nullSampleFixture);
    vi.mocked(updateToolTestEndpointFixture).mockImplementation(
      async (_projectId, _toolId, input) => ({
        ...nullSampleFixture,
        staticResponse: input.staticResponse ?? nullSampleFixture.staticResponse,
        sampleInput:
          input.sampleInput !== undefined ? input.sampleInput : nullSampleFixture.sampleInput,
        version: 2,
      }),
    );

    render(
      <ToolTestingSection
        projectId="project-1"
        toolId="tool-1"
        latestTestResult={null}
        onTestClick={vi.fn()}
        onRerunTest={vi.fn()}
        onClearResult={vi.fn()}
      />,
    );

    expect(await screen.findByText('Tool-Test Fixture')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Static response'), {
      target: { value: '{"status":"replaced"}' },
    });
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(updateToolTestEndpointFixture).toHaveBeenCalledWith('project-1', 'tool-1', {
        staticResponse: { status: 'replaced' },
        sampleInput: null,
      });
    });
  });
});
