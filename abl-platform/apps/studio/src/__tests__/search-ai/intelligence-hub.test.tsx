/**
 * Tests for IntelligenceHub and IntelligenceCard
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (barrel import of 1000+ icons hangs under happy-dom)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const icon = (props: Record<string, unknown>) => <svg data-testid="icon-mock" {...props} />;
  return {
    Workflow: icon,
    TableProperties: icon,
    BookOpen: icon,
    Share2: icon,
    Cpu: icon,
  };
});

// MockIcon for IntelligenceCard's `icon` prop (not from lucide-react directly)
const MockIcon = (props: Record<string, unknown>) => <svg data-testid="icon-mock" {...props} />;
MockIcon.displayName = 'MockIcon';

// ---------------------------------------------------------------------------
// Mock SWR (used by card sub-components)
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
let mockSwrReturn: Record<string, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// ---------------------------------------------------------------------------
// Mock navigation store
// ---------------------------------------------------------------------------

const mockSetSubSection = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      projectId: 'p-1',
      navigate: mockNavigate,
      setSubSection: mockSetSubSection,
    };
    return selector ? selector(state) : state;
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  IntelligenceCard,
  type IntelligenceCardState,
} from '../../components/search-ai/intelligence/IntelligenceCard';
import { IntelligenceHub } from '../../components/search-ai/intelligence/IntelligenceHub';

// ===========================================================================
// IntelligenceCard
// ===========================================================================

describe('IntelligenceCard', () => {
  const baseProps = {
    title: 'Pipeline',
    icon: MockIcon as any,
    state: 'healthy' as IntelligenceCardState,
    stats: [{ label: 'Stages', value: 4 }],
    description: 'Configure document processing.',
    actionLabel: 'Configure',
    onAction: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title and icon', () => {
    render(<IntelligenceCard {...baseProps} />);

    expect(screen.getByText('Pipeline')).toBeInTheDocument();
    // Icon renders as our MockIcon
    expect(screen.getByTestId('icon-mock')).toBeInTheDocument();
  });

  it('shows correct state dot color for healthy state', () => {
    const { container } = render(<IntelligenceCard {...baseProps} state="healthy" />);

    // healthy state has dot with bg-success
    const dot = container.querySelector('.bg-success');
    expect(dot).toBeInTheDocument();
  });

  it('shows correct state dot color for not-configured state', () => {
    const { container } = render(<IntelligenceCard {...baseProps} state="not-configured" />);

    // not-configured has dot with bg-muted
    const dot = container.querySelector('.bg-muted');
    expect(dot).toBeInTheDocument();
  });

  it('shows correct state dot color for needs-attention state', () => {
    const { container } = render(<IntelligenceCard {...baseProps} state="needs-attention" />);

    const dot = container.querySelector('.bg-warning');
    expect(dot).toBeInTheDocument();
  });

  it('shows correct state dot color for error state', () => {
    const { container } = render(<IntelligenceCard {...baseProps} state="error" />);

    const dot = container.querySelector('.bg-error');
    expect(dot).toBeInTheDocument();
  });

  it('shows stats when state !== not-configured', () => {
    render(
      <IntelligenceCard {...baseProps} state="healthy" stats={[{ label: 'Stages', value: 4 }]} />,
    );

    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Stages')).toBeInTheDocument();
  });

  it('hides stats when state === not-configured', () => {
    render(
      <IntelligenceCard
        {...baseProps}
        state="not-configured"
        stats={[{ label: 'Stages', value: 4 }]}
      />,
    );

    // Stats should NOT render when not-configured
    expect(screen.queryByText('Stages')).not.toBeInTheDocument();
  });

  it('shows attention message in needs-attention state', () => {
    render(
      <IntelligenceCard
        {...baseProps}
        state="needs-attention"
        attentionMessage="3 fields need review"
      />,
    );

    expect(screen.getByText('3 fields need review')).toBeInTheDocument();
  });

  it('shows error message in error state', () => {
    render(
      <IntelligenceCard {...baseProps} state="error" errorMessage="Embedding model unavailable" />,
    );

    expect(screen.getByText('Embedding model unavailable')).toBeInTheDocument();
  });

  it('loading state shows shimmer skeleton', () => {
    const { container } = render(<IntelligenceCard {...baseProps} isLoading />);

    const skeleton = container.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('isError state shows "Failed to load status" message', () => {
    render(<IntelligenceCard {...baseProps} isError />);

    expect(screen.getByText('Failed to load status')).toBeInTheDocument();
  });

  it('action button text changes based on state', () => {
    const { rerender } = render(
      <IntelligenceCard {...baseProps} state="not-configured" actionLabel="Set up Pipeline" />,
    );

    expect(screen.getByText('Set up Pipeline')).toBeInTheDocument();

    rerender(<IntelligenceCard {...baseProps} state="healthy" actionLabel="Configure" />);

    expect(screen.getByText('Configure')).toBeInTheDocument();
  });

  it('action button calls onAction when clicked', () => {
    const onAction = vi.fn();
    render(<IntelligenceCard {...baseProps} onAction={onAction} />);

    fireEvent.click(screen.getByText('Configure'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// IntelligenceHub
// ===========================================================================

describe('IntelligenceHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders all 5 cards (Pipeline, Fields, Vocabulary, Knowledge Graph, LLM Models)', () => {
    render(<IntelligenceHub indexId="idx-1" knowledgeBaseId="kb-1" />);

    // Each card renders its title text
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
    expect(screen.getByText('Fields')).toBeInTheDocument();
    expect(screen.getByText('Vocabulary')).toBeInTheDocument();
    expect(screen.getByText('Knowledge Graph')).toBeInTheDocument();
    expect(screen.getByText('LLM Models')).toBeInTheDocument();
  });

  it('renders the Intelligence heading and description', () => {
    render(<IntelligenceHub indexId="idx-1" knowledgeBaseId="kb-1" />);

    expect(screen.getByText('Intelligence')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Configure how your knowledge base processes, structures, and enriches content.',
      ),
    ).toBeInTheDocument();
  });
});
