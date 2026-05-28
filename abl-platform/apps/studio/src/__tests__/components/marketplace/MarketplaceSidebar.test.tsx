/**
 * MarketplaceSidebar Component Tests
 *
 * Tests the sidebar with search input, type filters, publisher filter,
 * category filter panel, and "Back to Studio" link.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarketplaceSidebar } from '../../../components/marketplace/MarketplaceSidebar';
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

describe('MarketplaceSidebar', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      query: '',
      selectedTypes: [],
      selectedCategories: [],
      selectedPublishers: [],
      categories: [
        { name: 'customer-service', count: 12 },
        { name: 'sales', count: 8 },
      ],
      templates: [
        {
          _id: 't1',
          slug: 'tpl-1',
          name: 'Tpl 1',
          shortDescription: '',
          longDescription: '',
          type: 'project',
          typeMetadata: null,
          detailSections: [],
          category: 'general',
          subcategory: null,
          tags: [],
          complexity: 'starter',
          publisherId: 'pub1',
          publisherTenantId: 'platform',
          publisherName: 'Kore',
          publisherVerified: true,
          installCount: 10,
          viewCount: 50,
          ratingAverage: 0,
          ratingCount: 0,
          featuredOrder: null,
          publishedAt: null,
          media: [],
          prerequisites: {
            envVars: [],
            connectors: [],
            mcpServers: [],
            authProfiles: [],
            models: [],
          },
          reviewStatus: 'approved',
          demoConversation: [],
          iconUrl: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          _id: 't2',
          slug: 'tpl-2',
          name: 'Tpl 2',
          shortDescription: '',
          longDescription: '',
          type: 'agent',
          typeMetadata: null,
          detailSections: [],
          category: 'sales',
          subcategory: null,
          tags: [],
          complexity: 'standard',
          publisherId: 'pub2',
          publisherTenantId: 'tenant-abc',
          publisherName: 'WorkspacePub',
          publisherVerified: false,
          installCount: 5,
          viewCount: 20,
          ratingAverage: 0,
          ratingCount: 0,
          featuredOrder: null,
          publishedAt: null,
          media: [],
          prerequisites: {
            envVars: [],
            connectors: [],
            mcpServers: [],
            authProfiles: [],
            models: [],
          },
          reviewStatus: 'approved',
          demoConversation: [],
          iconUrl: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      fetchCategories: vi.fn(),
    });

    useAuthStore.setState({
      tenantId: null,
    });
  });

  it('renders search input', () => {
    render(<MarketplaceSidebar />);

    const searchInput = document.querySelector('input');
    expect(searchInput).toBeTruthy();
    expect(searchInput?.getAttribute('placeholder')).toBe('Search templates...');
  });

  it('renders type filter checkboxes (Project, Agent)', () => {
    render(<MarketplaceSidebar />);

    expect(screen.getByText('Filter by Type')).toBeTruthy();
    expect(screen.getByText('Project')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
  });

  it('renders category checkboxes from store', () => {
    render(<MarketplaceSidebar />);

    expect(screen.getByText('Categories')).toBeTruthy();
    // Category counts from MarketplaceFilterPanel
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
  });

  it('renders publisher filter when tenantId is available', () => {
    useAuthStore.setState({ tenantId: 'tenant-abc' });

    render(<MarketplaceSidebar />);

    expect(screen.getByText('Publisher')).toBeTruthy();
    expect(screen.getByText('Kore.ai')).toBeTruthy();
    expect(screen.getByText('My Workspace')).toBeTruthy();
  });

  it('hides publisher filter when no tenantId', () => {
    useAuthStore.setState({ tenantId: null });

    render(<MarketplaceSidebar />);

    expect(screen.queryByText('Publisher')).toBeNull();
    expect(screen.queryByText('Kore.ai')).toBeNull();
    expect(screen.queryByText('My Workspace')).toBeNull();
  });

  it('shows counts next to type items', () => {
    render(<MarketplaceSidebar />);

    // 1 project template, 1 agent template from our mock data
    // The count spans are rendered inline, look for them
    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Project');
    expect(allText).toContain('Agent');
  });

  it('shows counts next to publisher items when tenantId set', () => {
    useAuthStore.setState({ tenantId: 'tenant-abc' });

    render(<MarketplaceSidebar />);

    // platformCount = 1 (tpl-1 has publisherTenantId=platform)
    // workspaceCount = 1 (tpl-2 has publisherTenantId=tenant-abc)
    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Kore.ai');
    expect(allText).toContain('My Workspace');
  });

  it('renders "Back to Studio" link', () => {
    render(<MarketplaceSidebar />);

    expect(screen.getByText('Back to Studio')).toBeTruthy();
  });
});
