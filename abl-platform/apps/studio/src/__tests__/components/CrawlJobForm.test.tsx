/**
 * CrawlJobForm Component Tests
 *
 * Tests the progressive disclosure crawl job submission form:
 * - URL input rendering
 * - Form submission with correct payload
 * - Error handling on submission failure
 * - Callback to onJobSubmitted on success
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';

// =============================================================================
// MOCKS
// =============================================================================

const mockSubmitBatchCrawl = vi.fn().mockResolvedValue({
  success: true,
  needsUserInput: false,
  jobId: 'test-job-123',
});

const mockProfileSite = vi.fn().mockResolvedValue({
  success: true,
  domain: 'example.com',
  siteType: 'static',
  estimatedSize: 100,
  hasSitemap: true,
  jsRequired: false,
  avgResponseTime: 200,
  metadata: { title: 'Example', description: 'Test site', favicon: '' },
});

vi.mock('@/api/crawl', () => ({
  profileSite: (...args: unknown[]) => mockProfileSite(...args),
  submitBatchCrawl: (...args: unknown[]) => mockSubmitBatchCrawl(...args),
  respondToQuestions: vi.fn(),
  previewUrls: vi.fn().mockResolvedValue({ success: true, urls: [], source: 'none', total: 0 }),
}));

vi.mock('@/hooks/useCrawlPreferences', () => ({
  useCrawlPreferences: vi.fn(() => ({
    preferences: [],
    matchingPreference: null,
    isLoading: false,
  })),
}));

vi.mock('@/lib/error-messages', () => ({
  getFriendlyError: vi.fn((err: unknown) => ({
    title: 'Error',
    message: err instanceof Error ? err.message : String(err),
  })),
}));

// Mock child components that are not under test
vi.mock('@/components/search-ai/QuestionPrompt', () => ({
  QuestionPrompt: () => <div data-testid="question-prompt" />,
}));

vi.mock('@/components/search-ai/SavePreferenceDialog', () => ({
  SavePreferenceDialog: () => <div data-testid="save-preference-dialog" />,
}));

vi.mock('@/components/search-ai/UrlPreviewDialog', () => ({
  UrlPreviewDialog: () => <div data-testid="url-preview-dialog" />,
}));

// =============================================================================
// IMPORT COMPONENT (after mocks)
// =============================================================================

import { CrawlJobForm } from '@/components/search-ai/CrawlJobForm';

// =============================================================================
// TESTS
// =============================================================================

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>,
  );
}

describe('CrawlJobForm', () => {
  const defaultProps = {
    indexId: 'idx-1',
    sourceId: 'src-1',
    onJobSubmitted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders URL input with placeholder', () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);
    expect(screen.getByPlaceholderText('https://example.com')).toBeInTheDocument();
  });

  test('renders submit button', () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);
    expect(screen.getByRole('button', { name: /analyze & crawl/i })).toBeInTheDocument();
  });

  test('submits crawl with correct payload', async () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);

    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com' },
    });

    const submitButton = screen.getByRole('button', { name: /analyze & crawl/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockSubmitBatchCrawl).toHaveBeenCalledWith(
        expect.objectContaining({
          urls: ['https://example.com'],
          indexId: 'idx-1',
          sourceId: 'src-1',
        }),
      );
    });
  });

  test('calls onJobSubmitted when job is created', async () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);

    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com' },
    });

    const submitButton = screen.getByRole('button', { name: /analyze & crawl/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(defaultProps.onJobSubmitted).toHaveBeenCalledWith('test-job-123');
    });
  });

  test('handles submission failure gracefully', async () => {
    mockSubmitBatchCrawl.mockRejectedValueOnce(new Error('Network error'));

    renderWithProviders(<CrawlJobForm {...defaultProps} />);

    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com' },
    });

    const submitButton = screen.getByRole('button', { name: /analyze & crawl/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      // After a failed submission, onJobSubmitted should NOT be called
      expect(defaultProps.onJobSubmitted).not.toHaveBeenCalled();
    });
  });

  test('calls profileSite on URL blur', async () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);

    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com' },
    });
    fireEvent.blur(urlInput);

    await waitFor(() => {
      expect(mockProfileSite).toHaveBeenCalledWith('https://example.com');
    });
  });

  test('renders scope selector cards after profiling', async () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);

    // Scope cards only appear after profile is loaded
    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com' },
    });
    fireEvent.blur(urlInput);

    // Wait for profiling to complete and scope cards to appear
    await waitFor(() => {
      expect(screen.getByText(/just this page/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/entire site/i)).toBeInTheDocument();
  });

  test('shows strategy dropdown when entire site selected', async () => {
    renderWithProviders(<CrawlJobForm {...defaultProps} />);

    // Profile the URL first so scope cards appear
    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, {
      target: { value: 'https://example.com' },
    });
    fireEvent.blur(urlInput);

    // Wait for scope cards
    await waitFor(() => {
      expect(screen.getByText(/entire site/i)).toBeInTheDocument();
    });

    // Click "Entire site" scope button
    fireEvent.click(screen.getByText(/entire site/i));

    // The Crawl Strategy select should now be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/crawl strategy/i)).toBeInTheDocument();
    });
  });
});
