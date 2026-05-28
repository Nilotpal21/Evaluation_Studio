/**
 * ExecutionEditor Component Tests
 *
 * Tests for the execution/LLM configuration section editor:
 * model select, temperature slider, maxTokens input, thinking toggle,
 * SectionHeader rendering, and onChange callbacks.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ExecutionSectionData } from '../../components/agent-editor/types';

// =============================================================================
// MOCKS
// =============================================================================

// Mock the Radix-based Select with a native <select> so tests can use
// standard DOM assertions (toHaveValue, fireEvent.change, querySelectorAll('option')).
// This also avoids the lucide-react barrel-import hang that the real Select triggers.
vi.mock('../../components/ui/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: Array<{ value: string; label: string }>;
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <select
      value={value ?? ''}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange?.(e.target.value)}
      disabled={disabled}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  ),
}));

// Mock SectionHeader
vi.mock('../../components/agent-editor/sections/SectionHeader', () => ({
  SectionHeader: ({ onArchClick }: { onArchClick?: () => void }) => {
    if (!onArchClick) return null;
    return (
      <div data-testid="section-header">
        <button onClick={onArchClick} data-testid="arch-button">
          AI Assist
        </button>
      </div>
    );
  },
}));

// Mock AgentModelTab — rendered conditionally when agentName + projectId exist
vi.mock('../../components/agents/AgentModelTab', () => ({
  AgentModelTab: ({
    projectId,
    agentName,
    embedded,
    modelLabel,
    modelDescription,
  }: {
    projectId: string;
    agentName: string;
    embedded?: boolean;
    modelLabel?: string;
    modelDescription?: string;
  }) => (
    <div data-testid="agent-model-tab">
      AgentModelTab: {projectId}/{agentName}
      {embedded ? ' [embedded]' : ''}
      {modelLabel ? ` ${modelLabel}` : ''}
      {modelDescription ? ` ${modelDescription}` : ''}
    </div>
  ),
}));

// Mock the Select component — Radix Select hangs in happy-dom, use native <select>
vi.mock('../../components/ui/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    disabled,
    label,
    id,
  }: {
    options: { value: string; label: string }[];
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
    label?: string;
    id?: string;
  }) => {
    const selectId = id || label?.toLowerCase().replace(/\s+/g, '-');
    return (
      <div>
        {label && <label htmlFor={selectId}>{label}</label>}
        <select
          id={selectId}
          value={value ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  },
}));

// Mock the agent editor store — provide agentName and projectId
const mockStoreState = {
  agentName: null as string | null,
  projectId: null as string | null,
};

vi.mock('../../components/agent-editor/hooks/useAgentEditorStore', () => ({
  useAgentEditorStore: (selector: (s: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
}));

const mockProjectModelOptionsState = vi.hoisted(() => ({
  models: [] as Array<{ id: string; name: string; modelId: string; isDefault: boolean }>,
  options: [
    {
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      modelId: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      isDefault: false,
      isCredentialReady: true,
    },
    {
      value: 'gpt-4o',
      label: 'GPT-4o',
      modelId: 'gpt-4o',
      name: 'GPT-4o',
      isDefault: true,
      isCredentialReady: true,
    },
  ],
  allOptions: [] as Array<{
    value: string;
    label: string;
    modelId: string;
    name: string;
    isDefault: boolean;
    isCredentialReady: boolean;
  }>,
  unavailableOptions: [] as Array<{
    value: string;
    label: string;
    modelId: string;
    name: string;
    isDefault: boolean;
    isCredentialReady: boolean;
  }>,
  isLoading: false,
  error: null as string | null,
  reload: vi.fn(),
}));

vi.mock('@/hooks/useProjectModelOptions', () => ({
  useProjectModelOptions: () => mockProjectModelOptionsState,
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { ExecutionEditor } from '../../components/agent-editor/sections/ExecutionEditor';

// =============================================================================
// HELPERS
// =============================================================================

const defaultData: ExecutionSectionData = {
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096,
  enableThinking: true,
};

function renderEditor(
  overrides: Partial<{
    data: ExecutionSectionData;
    onChange: (data: ExecutionSectionData) => void;
    readOnly: boolean;
    onArchClick: () => void;
  }> = {},
) {
  const props = {
    data: overrides.data ?? { ...defaultData },
    onChange: overrides.onChange ?? vi.fn(),
    readOnly: overrides.readOnly,
    onArchClick: overrides.onArchClick,
  };
  return { ...render(<ExecutionEditor {...props} />), props };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ExecutionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.agentName = null;
    mockStoreState.projectId = null;
    mockProjectModelOptionsState.models = [];
    mockProjectModelOptionsState.options = [
      {
        value: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        modelId: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        isDefault: false,
        isCredentialReady: true,
      },
      {
        value: 'gpt-4o',
        label: 'GPT-4o',
        modelId: 'gpt-4o',
        name: 'GPT-4o',
        isDefault: true,
        isCredentialReady: true,
      },
    ];
    mockProjectModelOptionsState.allOptions = [...mockProjectModelOptionsState.options];
    mockProjectModelOptionsState.unavailableOptions = [];
    mockProjectModelOptionsState.isLoading = false;
    mockProjectModelOptionsState.error = null;
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  it('renders model select with current value', () => {
    renderEditor();
    // The SelectField renders a <select> element with the model value
    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects[0];
    expect(modelSelect).toHaveValue('claude-sonnet-4-6');
  });

  it('renders temperature slider with current value', () => {
    renderEditor({ data: { ...defaultData, temperature: 1.2 } });
    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('1.2');
  });

  it('renders temperature display text', () => {
    renderEditor({ data: { ...defaultData, temperature: 1.2 } });
    expect(screen.getByText('1.2')).toBeInTheDocument();
  });

  it('renders maxTokens input with current value', () => {
    renderEditor();
    const maxTokensInput = screen.getByPlaceholderText('Default');
    expect(maxTokensInput).toHaveValue(4096);
  });

  it('renders enableThinking select with "Enabled" when true', () => {
    renderEditor({ data: { ...defaultData, enableThinking: true } });
    const selects = screen.getAllByRole('combobox');
    // Second select is the thinking select
    const thinkingSelect = selects[1];
    expect(thinkingSelect).toHaveValue('enabled');
  });

  it('renders enableThinking select with "Disabled" when false', () => {
    renderEditor({ data: { ...defaultData, enableThinking: false } });
    const selects = screen.getAllByRole('combobox');
    const thinkingSelect = selects[1];
    expect(thinkingSelect).toHaveValue('disabled');
  });

  it('renders enableThinking select with "Inherit" when null', () => {
    renderEditor({ data: { ...defaultData, enableThinking: null } });
    const selects = screen.getAllByRole('combobox');
    const thinkingSelect = selects[1];
    expect(thinkingSelect).toHaveValue('inherit');
  });

  it('renders sub-section headings', () => {
    renderEditor();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Generation')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('renders field labels', () => {
    renderEditor();
    expect(screen.getByText('Primary Model')).toBeInTheDocument();
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.getByText('Max Tokens')).toBeInTheDocument();
    expect(screen.getByText('Enable Thinking')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // SectionHeader
  // ---------------------------------------------------------------------------

  it('shows SectionHeader with AI Assist button when onArchClick is provided', () => {
    renderEditor({ onArchClick: vi.fn() });
    expect(screen.getByTestId('section-header')).toBeInTheDocument();
    expect(screen.getByText('AI Assist')).toBeInTheDocument();
  });

  it('does not show SectionHeader when onArchClick is not provided', () => {
    renderEditor();
    expect(screen.queryByTestId('section-header')).not.toBeInTheDocument();
  });

  it('calls onArchClick when AI Assist button is clicked', () => {
    const onArchClick = vi.fn();
    renderEditor({ onArchClick });
    fireEvent.click(screen.getByTestId('arch-button'));
    expect(onArchClick).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // onChange callbacks
  // ---------------------------------------------------------------------------

  it('calls onChange when model is changed', () => {
    const onChange = vi.fn();
    renderEditor({ onChange });

    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects[0];
    fireEvent.change(modelSelect, { target: { value: 'gpt-4o' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  it('calls onChange with undefined model when Default is selected', () => {
    const onChange = vi.fn();
    renderEditor({ onChange });

    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects[0];
    fireEvent.change(modelSelect, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it('calls onChange when temperature slider is changed', () => {
    const onChange = vi.fn();
    renderEditor({ onChange });

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '1.5' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ temperature: 1.5 }));
  });

  it('calls onChange when maxTokens is changed', () => {
    const onChange = vi.fn();
    renderEditor({ onChange });

    const maxTokensInput = screen.getByPlaceholderText('Default');
    fireEvent.change(maxTokensInput, { target: { value: '8192' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 8192 }));
  });

  it('calls onChange with undefined maxTokens when cleared', () => {
    const onChange = vi.fn();
    renderEditor({ onChange });

    const maxTokensInput = screen.getByPlaceholderText('Default');
    fireEvent.change(maxTokensInput, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: undefined }));
  });

  it('calls onChange when enableThinking is toggled to enabled', () => {
    const onChange = vi.fn();
    renderEditor({ onChange, data: { ...defaultData, enableThinking: null } });

    const selects = screen.getAllByRole('combobox');
    const thinkingSelect = selects[1];
    fireEvent.change(thinkingSelect, { target: { value: 'enabled' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enableThinking: true }));
  });

  it('calls onChange when enableThinking is toggled to disabled', () => {
    const onChange = vi.fn();
    renderEditor({ onChange, data: { ...defaultData, enableThinking: true } });

    const selects = screen.getAllByRole('combobox');
    const thinkingSelect = selects[1];
    fireEvent.change(thinkingSelect, { target: { value: 'disabled' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enableThinking: false }));
  });

  it('calls onChange when enableThinking is set to inherit', () => {
    const onChange = vi.fn();
    renderEditor({ onChange, data: { ...defaultData, enableThinking: true } });

    const selects = screen.getAllByRole('combobox');
    const thinkingSelect = selects[1];
    fireEvent.change(thinkingSelect, { target: { value: 'inherit' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enableThinking: null }));
  });

  // ---------------------------------------------------------------------------
  // Default / empty data
  // ---------------------------------------------------------------------------

  it('handles empty data gracefully', () => {
    renderEditor({ data: {} });
    // Model select defaults to empty string
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toHaveValue('');
    // Temperature slider defaults to 0.7
    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('0.7');
    // Temperature display shows 0.7
    expect(screen.getByText('0.7')).toBeInTheDocument();
    // MaxTokens input is empty
    const maxTokensInput = screen.getByPlaceholderText('Default');
    expect(maxTokensInput).toHaveValue(null);
    // Thinking select defaults to inherit
    expect(selects[1]).toHaveValue('inherit');
  });

  it('handles undefined temperature and maxTokens', () => {
    renderEditor({ data: { model: 'gpt-4o' } });
    const slider = screen.getByRole('slider');
    expect(slider).toHaveValue('0.7');
    const maxTokensInput = screen.getByPlaceholderText('Default');
    expect(maxTokensInput).toHaveValue(null);
  });

  // ---------------------------------------------------------------------------
  // readOnly mode
  // ---------------------------------------------------------------------------

  it('disables model select in readOnly mode', () => {
    renderEditor({ readOnly: true });
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toBeDisabled();
  });

  it('disables temperature slider in readOnly mode', () => {
    renderEditor({ readOnly: true });
    const slider = screen.getByRole('slider');
    expect(slider).toBeDisabled();
  });

  it('sets maxTokens input to readOnly in readOnly mode', () => {
    renderEditor({ readOnly: true });
    const maxTokensInput = screen.getByPlaceholderText('Default');
    expect(maxTokensInput).toHaveAttribute('readonly');
  });

  it('disables thinking select in readOnly mode', () => {
    renderEditor({ readOnly: true });
    const selects = screen.getAllByRole('combobox');
    expect(selects[1]).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // AgentModelTab conditional rendering
  // ---------------------------------------------------------------------------

  it('does not render AgentModelTab when agentName is null', () => {
    mockStoreState.agentName = null;
    mockStoreState.projectId = 'proj-1';
    renderEditor();
    expect(screen.queryByTestId('agent-model-tab')).not.toBeInTheDocument();
  });

  it('does not render AgentModelTab when projectId is null', () => {
    mockStoreState.agentName = 'my_agent';
    mockStoreState.projectId = null;
    renderEditor();
    expect(screen.queryByTestId('agent-model-tab')).not.toBeInTheDocument();
  });

  it('shows the runtime overrides section collapsed when both agentName and projectId exist', () => {
    mockStoreState.agentName = 'my_agent';
    mockStoreState.projectId = 'proj-1';
    renderEditor();
    expect(screen.getByText('Advanced Runtime Overrides')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /runtime-only model overrides/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByTestId('agent-model-tab')).not.toBeInTheDocument();
  });

  it('shows embedded runtime overrides only after expanding the advanced panel', () => {
    mockStoreState.agentName = 'my_agent';
    mockStoreState.projectId = 'proj-1';
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /runtime-only model overrides/i }));

    expect(screen.getByTestId('agent-model-tab')).toBeInTheDocument();
    expect(screen.getByText(/AgentModelTab: proj-1\/my_agent \[embedded\]/)).toBeInTheDocument();
    expect(screen.getByTestId('agent-model-tab')).toHaveTextContent('Runtime Override Model');
    expect(screen.getByTestId('agent-model-tab')).toHaveTextContent(
      'Optional runtime-only override. Leave this empty to follow the ABL primary model above.',
    );
    expect(screen.getByRole('button', { name: /runtime-only model overrides/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // ---------------------------------------------------------------------------
  // Model options
  // ---------------------------------------------------------------------------

  it('renders project model options in the select', () => {
    renderEditor();
    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects[0];
    const options = modelSelect.querySelectorAll('option');
    expect(options.length).toBe(3); // Default + 2 project models
    expect(options[0]).toHaveTextContent('Default');
    expect(options[1]).toHaveTextContent('Claude Sonnet 4.6');
    expect(options[2]).toHaveTextContent('GPT-4o');
  });

  it('hides project model options without active credentials from the primary model list', () => {
    mockProjectModelOptionsState.options = [
      {
        value: 'gpt-4o',
        label: 'GPT-4o',
        modelId: 'gpt-4o',
        name: 'GPT-4o',
        isDefault: true,
        isCredentialReady: true,
      },
    ];
    mockProjectModelOptionsState.unavailableOptions = [
      {
        value: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        modelId: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        isDefault: false,
        isCredentialReady: false,
      },
    ];
    mockProjectModelOptionsState.allOptions = [
      ...mockProjectModelOptionsState.options,
      ...mockProjectModelOptionsState.unavailableOptions,
    ];

    renderEditor({ data: { ...defaultData, model: 'gpt-4o' } });

    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects[0];
    const options = modelSelect.querySelectorAll('option');
    expect(options.length).toBe(2);
    expect(options[0]).toHaveTextContent('Default');
    expect(options[1]).toHaveTextContent('GPT-4o');
    expect(modelSelect).not.toHaveTextContent('Claude Sonnet 4.6');
    expect(
      screen.getByText(/1 project model without active credentials is hidden/),
    ).toBeInTheDocument();
  });

  it('shows a hint when the project has no configured models', () => {
    mockProjectModelOptionsState.options = [];
    mockStoreState.projectId = 'proj-1';

    renderEditor();

    expect(screen.getByText(/No project-specific models are configured yet\./)).toBeInTheDocument();
  });

  it('shows a warning when project models fail to load', () => {
    mockProjectModelOptionsState.options = [];
    mockProjectModelOptionsState.error = 'boom';

    renderEditor();

    expect(screen.getByText(/Project models could not be loaded\./)).toBeInTheDocument();
  });

  it('shows a warning for agent models not configured in the project', () => {
    mockProjectModelOptionsState.options = [
      {
        value: 'gpt-4o',
        label: 'GPT-4o',
        modelId: 'gpt-4o',
        name: 'GPT-4o',
        isDefault: true,
        isCredentialReady: true,
      },
    ];

    renderEditor({ data: { ...defaultData, model: 'claude-opus-4-7' } });

    expect(
      screen.getByText(/This agent references a model that is not currently configured/),
    ).toBeInTheDocument();

    const selects = screen.getAllByRole('combobox');
    const modelSelect = selects[0];
    const options = modelSelect.querySelectorAll('option');
    expect(options[2]).toHaveTextContent('claude-opus-4-7 (not in project models)');
  });

  it('disables the model select while project models are loading', () => {
    mockProjectModelOptionsState.isLoading = true;

    renderEditor();

    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toBeDisabled();
  });

  it('renders all thinking options in the select', () => {
    renderEditor();
    const selects = screen.getAllByRole('combobox');
    const thinkingSelect = selects[1];
    const options = thinkingSelect.querySelectorAll('option');
    expect(options.length).toBe(3);
    expect(options[0]).toHaveTextContent('Inherit from project');
    expect(options[1]).toHaveTextContent('Enabled');
    expect(options[2]).toHaveTextContent('Disabled');
  });
});
