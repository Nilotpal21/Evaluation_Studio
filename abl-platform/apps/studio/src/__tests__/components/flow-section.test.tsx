/**
 * FlowSection & FlowMiniGraph Component Tests
 *
 * Tests for the flow section: collapsed summary with step count and mini flow
 * graph, expanded view with full graph and step editor list, and the add step button.
 * Also tests the FlowMiniGraph SVG rendering with nodes and edges.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { FlowSection } from '../../components/agent-detail/FlowSection';
import { FlowMiniGraph } from '../../components/agent-detail/FlowMiniGraph';
import type { FlowSectionData, FlowStepData } from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const greetStep: FlowStepData = {
  name: 'greet',
  respond: 'Hello! How can I help you today?',
  then: 'collect_info',
  hasGather: false,
  hasBranching: false,
  reasoning: false,
};

const collectInfoStep: FlowStepData = {
  name: 'collect_info',
  respond: 'Let me gather some details.',
  hasGather: true,
  hasBranching: false,
  then: 'process',
  reasoning: false,
};

const processStep: FlowStepData = {
  name: 'process',
  call: 'search_hotels',
  then: 'respond_results',
  hasGather: false,
  hasBranching: true,
  reasoning: false,
};

const respondResultsStep: FlowStepData = {
  name: 'respond_results',
  respond: 'Here are your results!',
  hasGather: false,
  hasBranching: false,
  reasoning: false,
};

const mockFlowData: FlowSectionData = {
  steps: [greetStep, collectInfoStep, processStep, respondResultsStep],
  entryPoint: 'greet',
};

const twoStepFlowData: FlowSectionData = {
  steps: [greetStep, collectInfoStep],
  entryPoint: 'greet',
};

const emptyFlowData: FlowSectionData = {
  steps: [],
  entryPoint: '',
};

// =============================================================================
// FLOW SECTION TESTS
// =============================================================================

describe('FlowSection', () => {
  it('renders collapsed with step count', () => {
    render(
      <FlowSection
        data={mockFlowData}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title is "Flow"
    expect(screen.getByText('Flow')).toBeInTheDocument();

    // Count badge shows "4"
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders expanded with step list showing names', () => {
    render(
      <FlowSection data={mockFlowData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Step names are visible when expanded — names appear in both the
    // FlowMiniGraph SVG and in step editor cards (and sometimes in
    // transition badges), so use getAllByText
    expect(screen.getAllByText('greet').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('collect_info').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('process').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('respond_results').length).toBeGreaterThanOrEqual(1);
  });

  it('shows step details: respond text, call action, then transition', () => {
    render(
      <FlowSection data={mockFlowData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Respond text for greet step (now in a <textarea>)
    expect(screen.getByDisplayValue('Hello! How can I help you today?')).toBeInTheDocument();

    // Call action for process step (now in an <input>)
    expect(screen.getByDisplayValue('search_hotels')).toBeInTheDocument();

    // Then transitions visible — step names appear in FlowMiniGraph SVG text
    // nodes AND in <input> fields (step name + "then" transition inputs)
    const collectInfoInputs = screen.getAllByDisplayValue('collect_info');
    expect(collectInfoInputs.length).toBeGreaterThanOrEqual(2); // step name input + transition input

    const respondResultsInputs = screen.getAllByDisplayValue('respond_results');
    expect(respondResultsInputs.length).toBeGreaterThanOrEqual(1); // transition input
  });

  it('shows [+ Add Step] button in expanded state', () => {
    render(
      <FlowSection data={mockFlowData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    const addButton = screen.getByRole('button', { name: /add step/i });
    expect(addButton).toBeInTheDocument();
  });

  it('renders empty when no steps', () => {
    render(
      <FlowSection
        data={emptyFlowData}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title still shows
    expect(screen.getByText('Flow')).toBeInTheDocument();

    // Shows empty message
    expect(screen.getByText(/no flow steps/i)).toBeInTheDocument();
  });

  it('shows gather and branching indicator badges on steps', () => {
    render(
      <FlowSection data={mockFlowData} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Gather badge on collect_info step
    expect(screen.getByText('gather')).toBeInTheDocument();

    // Branch badge on process step
    expect(screen.getByText('branching')).toBeInTheDocument();
  });
});

// =============================================================================
// FLOW MINI GRAPH TESTS
// =============================================================================

describe('FlowMiniGraph', () => {
  it('renders SVG with node elements for each step', () => {
    const { container } = render(<FlowMiniGraph data={mockFlowData} compact={false} />);

    // Should render an SVG element
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // Should have a rect for each step node (4 steps)
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(4);

    // Should have text labels for step names
    expect(screen.getByText('greet')).toBeInTheDocument();
    expect(screen.getByText('collect_info')).toBeInTheDocument();
    expect(screen.getByText('process')).toBeInTheDocument();
    expect(screen.getByText('respond_results')).toBeInTheDocument();
  });

  it('renders edges between connected nodes', () => {
    const { container } = render(<FlowMiniGraph data={twoStepFlowData} compact={false} />);

    // Should have line/path elements for edges
    // greet -> collect_info = 1 edge
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(1);
  });

  it('renders in compact mode with smaller dimensions', () => {
    const { container } = render(<FlowMiniGraph data={mockFlowData} compact={true} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // Compact mode should still render nodes
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(4);
  });

  it('renders empty state with no nodes when steps are empty', () => {
    const { container } = render(<FlowMiniGraph data={emptyFlowData} compact={false} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // No rect nodes
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(0);
  });

  it('calls onStepClick when a node is clicked', () => {
    const handleClick = vi.fn();
    render(<FlowMiniGraph data={mockFlowData} compact={false} onStepClick={handleClick} />);

    // Click on a step node text — use fireEvent for SVG elements
    const greetNode = screen.getByText('greet');
    fireEvent.click(greetNode);

    expect(handleClick).toHaveBeenCalledWith('greet');
  });

  it('highlights entry point node with accent style', () => {
    const { container } = render(<FlowMiniGraph data={mockFlowData} compact={false} />);

    // The first rect (entry point "greet") should have an accent-colored stroke
    const rects = container.querySelectorAll('rect');
    const entryRect = rects[0];
    expect(entryRect).toBeInTheDocument();
    // Entry point node has a distinct stroke color
    expect(entryRect.getAttribute('data-entry')).toBe('true');
  });
});
