/**
 * Tests for Intelligence Hub card components:
 * FieldsCard, KnowledgeGraphCard, LLMModelsCard, PipelineCard, VocabularyCard
 *
 * Each card uses SWR to fetch data and renders via IntelligenceCard.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (barrel import hangs under happy-dom)
// Must override the Proxy-based mock from setup.tsx with a plain object
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Database: n,
    Sparkles: n,
    Activity: n,
    Brain: n,
    Layers: n,
    BookOpen: n,
    Zap: n,
    Settings: n,
    ChevronRight: n,
    Loader2: n,
    AlertCircle: n,
    CheckCircle: n,
    FileText: n,
    Globe: n,
    Plug: n,
    Network: n,
    Tag: n,
    Wand2: n,
    Info: n,
    ExternalLink: n,
    TableProperties: n,
    Share2: n,
    Cpu: n,
    Workflow: n,
  };
});

// ---------------------------------------------------------------------------
// Mock SWR
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

const { mockKGConfigurationStatus, mockKGTaxonomy, mockKGReviewQueue } = vi.hoisted(() => ({
  mockKGConfigurationStatus: {
    status: null as Record<string, unknown> | null,
    isLoading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
  mockKGTaxonomy: {
    taxonomy: null as Record<string, unknown> | null,
    isLoading: false,
    error: null as string | null,
    isNotFound: true,
    refresh: vi.fn(),
  },
  mockKGReviewQueue: {
    mergeConflicts: [],
    placementReview: [],
    typeConflicts: [],
    total: 0,
    isLoading: false,
    error: null as string | null,
    mutate: vi.fn(),
  },
}));

vi.mock('../../hooks/useKnowledgeGraph', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useKnowledgeGraph')>(
    '../../hooks/useKnowledgeGraph',
  );
  return {
    ...actual,
    useKGConfigurationStatus: () => mockKGConfigurationStatus,
    useKGTaxonomy: () => mockKGTaxonomy,
  };
});

vi.mock('../../hooks/useAttributes', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useAttributes')>(
    '../../hooks/useAttributes',
  );
  return {
    ...actual,
    useReviewQueue: () => mockKGReviewQueue,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { FieldsCard } from '../../components/search-ai/intelligence/cards/FieldsCard';
import { KnowledgeGraphCard } from '../../components/search-ai/intelligence/cards/KnowledgeGraphCard';
import { LLMModelsCard } from '../../components/search-ai/intelligence/cards/LLMModelsCard';
import { PipelineCard } from '../../components/search-ai/intelligence/cards/PipelineCard';
import { VocabularyCard } from '../../components/search-ai/intelligence/cards/VocabularyCard';

// ===========================================================================
// FieldsCard
// ===========================================================================

describe('FieldsCard', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders card title', () => {
    render(<FieldsCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // fields_title = "Fields"
    expect(screen.getByText('Fields')).toBeInTheDocument();
  });

  it('shows "Set up Fields" action when not configured', () => {
    render(<FieldsCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // fields_action_setup = "Set up Fields"
    expect(screen.getByText('Set up Fields')).toBeInTheDocument();
  });

  it('shows confirmed/suggested stats when data is loaded', () => {
    Object.assign(mockSwrReturn, {
      data: { confirmedCount: 5, suggestedCount: 2, unmappedCount: 1, totalFields: 8 },
    });

    render(<FieldsCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // fields_stat_confirmed = "Confirmed", fields_stat_suggested = "Suggested"
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows attention message when suggestions exist', () => {
    Object.assign(mockSwrReturn, {
      data: { confirmedCount: 3, suggestedCount: 4 },
    });

    render(<FieldsCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // fields_suggested_review = "{count} suggested fields to review"
    expect(screen.getByText('4 suggested fields to review')).toBeInTheDocument();
  });

  it('shows "Manage Fields" when fields are configured', () => {
    Object.assign(mockSwrReturn, {
      data: { confirmedCount: 5, suggestedCount: 0 },
    });

    render(<FieldsCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // fields_action_manage = "Manage Fields"
    expect(screen.getByText('Manage Fields')).toBeInTheDocument();
  });

  it('calls onNavigate when action button is clicked', () => {
    render(<FieldsCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText('Set up Fields'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// KnowledgeGraphCard
// ===========================================================================

describe('KnowledgeGraphCard', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockKGConfigurationStatus, {
      status: null,
      isLoading: false,
      error: null,
    });
    Object.assign(mockKGTaxonomy, {
      taxonomy: null,
      isLoading: false,
      error: null,
      isNotFound: true,
    });
    Object.assign(mockKGReviewQueue, {
      mergeConflicts: [],
      placementReview: [],
      typeConflicts: [],
      total: 0,
      isLoading: false,
      error: null,
    });
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders card title', () => {
    render(<KnowledgeGraphCard indexId="idx-1" onNavigate={onNavigate} />);

    // kg_title = "Knowledge Graph"
    expect(screen.getByText('Knowledge Graph')).toBeInTheDocument();
  });

  it('shows "Set up Knowledge Graph" when not configured', () => {
    render(<KnowledgeGraphCard indexId="idx-1" onNavigate={onNavigate} />);

    expect(screen.getByText('Set Up KG')).toBeInTheDocument();
  });

  it('shows healthy state when KG is configured', () => {
    Object.assign(mockKGConfigurationStatus, {
      status: {
        environment: { available: true, reason: null },
        configurationLevel: 'workspace',
        workspace: { hasKGConfigured: true, configuredIndexes: ['idx-1', 'idx-2'] },
      },
    });
    Object.assign(mockKGTaxonomy, {
      taxonomy: { id: 'taxonomy-1' },
      isNotFound: false,
    });

    const { container } = render(<KnowledgeGraphCard indexId="idx-1" onNavigate={onNavigate} />);

    // healthy state has success dot
    expect(container.querySelector('.bg-success')).toBeInTheDocument();
    // kg_action_manage = "Manage Graph"
    expect(screen.getByText('Manage Graph')).toBeInTheDocument();
  });

  it('shows "Learn More" when KG infrastructure is unavailable', () => {
    Object.assign(mockKGConfigurationStatus, {
      status: {
        environment: { available: false, reason: 'neo4j_unavailable' },
        configurationLevel: 'workspace',
        workspace: { hasKGConfigured: true, configuredIndexes: ['idx-1', 'idx-2'] },
      },
    });

    render(<KnowledgeGraphCard indexId="idx-1" onNavigate={onNavigate} />);

    expect(screen.getByText('Learn More')).toBeInTheDocument();
    expect(screen.getByText('Requires Neo4j. Contact your admin.')).toBeInTheDocument();
  });
});

// ===========================================================================
// LLMModelsCard
// ===========================================================================

describe('LLMModelsCard', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders card title', () => {
    render(<LLMModelsCard indexId="idx-1" onNavigate={onNavigate} />);

    // llm_title = "LLM Models"
    expect(screen.getByText('LLM Models')).toBeInTheDocument();
  });

  it('shows "Set up LLM Models" when not configured', () => {
    render(<LLMModelsCard indexId="idx-1" onNavigate={onNavigate} />);

    expect(screen.getByText('Set up LLM Models')).toBeInTheDocument();
  });

  it('shows active use case stats when enabled', () => {
    Object.assign(mockSwrReturn, {
      data: {
        enhancedConfig: {
          useCases: {
            answerGeneration: { enabled: true, status: 'active' },
            summarization: { enabled: true, status: 'active' },
            enrichment: { enabled: false, status: 'disabled' },
          },
        },
      },
    });

    render(<LLMModelsCard indexId="idx-1" onNavigate={onNavigate} />);

    // llm_stat_active_use_cases = "Active Use Cases"
    expect(screen.getByText('Active Use Cases')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
    // llm_action_configure = "Configure Models"
    expect(screen.getByText('Configure Models')).toBeInTheDocument();
  });

  it('shows needs-attention when use cases exist but none enabled', () => {
    Object.assign(mockSwrReturn, {
      data: {
        enhancedConfig: {
          useCases: {
            answerGeneration: { enabled: false },
          },
        },
      },
    });

    const { container } = render(<LLMModelsCard indexId="idx-1" onNavigate={onNavigate} />);

    // needs-attention state has warning dot
    expect(container.querySelector('.bg-warning')).toBeInTheDocument();
  });
});

// ===========================================================================
// PipelineCard
// ===========================================================================

describe('PipelineCard', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders card title', () => {
    render(<PipelineCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // pipeline_title = "Pipeline"
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
  });

  it('shows "Set up Pipeline" when not configured', () => {
    render(<PipelineCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    expect(screen.getByText('Set up Pipeline')).toBeInTheDocument();
  });

  it('shows healthy state when KB is active', () => {
    Object.assign(mockSwrReturn, {
      data: { knowledgeBase: { status: 'active' } },
    });

    const { container } = render(<PipelineCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // healthy state has success dot
    expect(container.querySelector('.bg-success')).toBeInTheDocument();
    // pipeline_stat_status = "Status", pipeline_stat_active = "Active"
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // pipeline_action_configure = "Configure"
    expect(screen.getByText('Configure')).toBeInTheDocument();
  });

  it('shows loading skeleton', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { container } = render(<PipelineCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows error state when SWR fetch fails', () => {
    Object.assign(mockSwrReturn, { error: new Error('Server error') });

    render(<PipelineCard knowledgeBaseId="kb-1" onNavigate={onNavigate} />);

    // load_status_error = "Failed to load status"
    expect(screen.getByText('Failed to load status')).toBeInTheDocument();
  });
});

// ===========================================================================
// VocabularyCard
// ===========================================================================

describe('VocabularyCard', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('renders card title', () => {
    render(<VocabularyCard indexId="idx-1" onNavigate={onNavigate} />);

    // vocabulary_title = "Vocabulary"
    expect(screen.getByText('Vocabulary')).toBeInTheDocument();
  });

  it('shows "Set up Vocabulary" when not configured', () => {
    render(<VocabularyCard indexId="idx-1" onNavigate={onNavigate} />);

    expect(screen.getByText('Set up Vocabulary')).toBeInTheDocument();
  });

  it('shows term and synonym stats when data exists', () => {
    Object.assign(mockSwrReturn, {
      data: {
        entries: [
          { id: '1', term: 'alpha', enabled: true, aliases: ['a'] },
          { id: '2', term: 'beta', enabled: true, aliases: [] },
        ],
        total: 2,
      },
    });

    render(<VocabularyCard indexId="idx-1" onNavigate={onNavigate} />);

    // vocabulary_stat_terms = "Terms", vocabulary_stat_synonyms = "Synonyms"
    expect(screen.getByText('Terms')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Synonyms')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    // vocabulary_action_manage = "Manage Vocabulary"
    expect(screen.getByText('Manage Vocabulary')).toBeInTheDocument();
  });

  it('calls onNavigate when action button is clicked', () => {
    render(<VocabularyCard indexId="idx-1" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText('Set up Vocabulary'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
