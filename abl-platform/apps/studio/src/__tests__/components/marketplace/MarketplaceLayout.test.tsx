/**
 * MarketplaceLayout Component Tests
 *
 * Tests the layout shell: top bar branding, sidebar rendering,
 * and children content area.
 *
 * The auth store is pre-set with an accessToken so the useEffect
 * that calls refreshAccessToken is skipped entirely.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketplaceLayout } from '../../../components/marketplace/MarketplaceLayout';
import { useMarketplaceStore } from '../../../store/marketplace-store';
import { useAuthStore } from '../../../store/auth-store';

// Mock apiFetch — external API boundary
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

// Mock the template-install API — external API boundary
vi.mock('@/api/template-install', () => ({
  installProjectTemplate: vi.fn(),
  previewAgentInstall: vi.fn(),
  applyAgentInstall: vi.fn(),
}));

describe('MarketplaceLayout', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      query: '',
      selectedTypes: [],
      selectedCategories: [],
      selectedPublishers: [],
      categories: [],
      templates: [],
      fetchCategories: vi.fn(),
    });

    // Set accessToken so the useEffect that calls refreshAccessToken is skipped
    useAuthStore.setState({
      accessToken: 'test-token',
      tenantId: null,
    });
  });

  it('renders top bar with "Agent Platform" and "Template Store"', () => {
    render(
      <MarketplaceLayout>
        <div>Test content</div>
      </MarketplaceLayout>,
    );

    expect(screen.getByText('Agent Platform')).toBeTruthy();
    expect(screen.getByText('Template Store')).toBeTruthy();
  });

  it('renders clickable Agent Platform logo linking to "/"', () => {
    render(
      <MarketplaceLayout>
        <div>Content</div>
      </MarketplaceLayout>,
    );

    const logoLink = screen.getByText('Agent Platform').closest('a');
    expect(logoLink).toBeTruthy();
    expect(logoLink?.getAttribute('href')).toBe('/');
  });

  it('renders MarketplaceSidebar', () => {
    render(
      <MarketplaceLayout>
        <div>Content</div>
      </MarketplaceLayout>,
    );

    // Sidebar renders the search input and type filter section
    expect(screen.getByText('Filter by Type')).toBeTruthy();
    expect(screen.getByText('Back to Studio')).toBeTruthy();
  });

  it('renders children in main content area', () => {
    render(
      <MarketplaceLayout>
        <div data-testid="child-content">Hello from children</div>
      </MarketplaceLayout>,
    );

    expect(screen.getByTestId('child-content')).toBeTruthy();
    expect(screen.getByText('Hello from children')).toBeTruthy();
  });
});
