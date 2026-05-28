/**
 * IntegrationAuthTab Component Tests
 *
 * Tests for the Integrations catalog tab — grid rendering, search filtering,
 * category filtering, and loading/empty/error states.
 *
 * NOTE: This is a UNIT test for a component whose name happens to contain
 * "integration". vi.mock() is appropriate here — we mock SWR and child
 * components, not codebase services.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

const mockUseSWR = vi.fn();
vi.mock('swr', () => ({
  default: (...args: unknown[]) => mockUseSWR(...args),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values) return `${key}:${JSON.stringify(values)}`;
    return key;
  },
}));

vi.mock('@/api/auth-profiles', () => ({
  fetchIntegrationProviders: vi.fn(),
  fetchWorkspaceIntegrationProviders: vi.fn(),
}));

vi.mock('@/components/auth-profiles/IntegrationCard', () => ({
  IntegrationCard: ({ provider }: { provider: { connectorName: string; displayName: string } }) => (
    <div data-testid={`card-${provider.connectorName}`}>{provider.displayName}</div>
  ),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { IntegrationAuthTab } from '@/components/auth-profiles/IntegrationAuthTab';

// =============================================================================
// TEST DATA
// =============================================================================

function makeProvider(
  name: string,
  displayName: string,
  category: string,
  authTypes: string[] = ['oauth2'],
) {
  return {
    connectorName: name,
    displayName,
    description: `${displayName} connector`,
    category,
    availableAuthTypes: authTypes,
    profileCount: 0,
    profiles: [],
  };
}

const GMAIL = makeProvider('gmail', 'Gmail', 'communication');
const STRIPE = makeProvider('stripe', 'Stripe', 'crm', ['api_key']);
const SLACK = makeProvider('slack', 'Slack', 'communication');

// =============================================================================
// TESTS
// =============================================================================

describe('IntegrationAuthTab', () => {
  const defaultProps = {
    scope: 'project' as const,
    projectId: 'proj-1',
    onCreateProfile: vi.fn(),
    onEditProfile: vi.fn(),
    onAuthorizeProfile: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({ data: null, error: null, isLoading: false });
  });

  it('renders catalog grid with connector cards when data loads', () => {
    mockUseSWR.mockReturnValue({
      data: { success: true, data: [GMAIL, STRIPE, SLACK] },
      error: null,
      isLoading: false,
    });

    render(<IntegrationAuthTab {...defaultProps} />);

    expect(screen.getByTestId('card-gmail')).toBeInTheDocument();
    expect(screen.getByTestId('card-stripe')).toBeInTheDocument();
    expect(screen.getByTestId('card-slack')).toBeInTheDocument();
  });

  it('filters providers by displayName when typing in search', () => {
    mockUseSWR.mockReturnValue({
      data: { success: true, data: [GMAIL, STRIPE, SLACK] },
      error: null,
      isLoading: false,
    });

    render(<IntegrationAuthTab {...defaultProps} />);

    const searchInput = screen.getByRole('textbox');
    fireEvent.change(searchInput, { target: { value: 'gmail' } });

    expect(screen.getByTestId('card-gmail')).toBeInTheDocument();
    expect(screen.queryByTestId('card-stripe')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-slack')).not.toBeInTheDocument();
  });

  it('filters providers by connector category when selecting from dropdown', () => {
    mockUseSWR.mockReturnValue({
      data: { success: true, data: [GMAIL, STRIPE, SLACK] },
      error: null,
      isLoading: false,
    });

    render(<IntegrationAuthTab {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /integrations\.category_all/i }));
    fireEvent.click(screen.getByRole('button', { name: /CRM & Sales/i }));

    expect(screen.queryByTestId('card-gmail')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-stripe')).toBeInTheDocument();
    expect(screen.queryByTestId('card-slack')).not.toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    mockUseSWR.mockReturnValue({ data: null, error: null, isLoading: true });

    render(<IntegrationAuthTab {...defaultProps} />);

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(screen.queryByTestId('card-gmail')).not.toBeInTheDocument();
  });

  it('shows empty state when no providers match search', () => {
    mockUseSWR.mockReturnValue({
      data: { success: true, data: [GMAIL] },
      error: null,
      isLoading: false,
    });

    render(<IntegrationAuthTab {...defaultProps} />);

    const searchInput = screen.getByRole('textbox');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    expect(screen.getByText('integrations.empty_state_title')).toBeInTheDocument();
    expect(screen.queryByTestId('card-gmail')).not.toBeInTheDocument();
  });

  it('shows error state on fetch failure', () => {
    mockUseSWR.mockReturnValue({
      data: null,
      error: new Error('Network error'),
      isLoading: false,
    });

    render(<IntegrationAuthTab {...defaultProps} />);

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });
});
