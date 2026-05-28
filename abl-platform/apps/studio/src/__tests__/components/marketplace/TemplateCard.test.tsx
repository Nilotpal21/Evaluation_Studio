/**
 * TemplateCard Component Tests
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateCard } from '../../../components/marketplace/TemplateCard';
import type { MarketplaceTemplate } from '@/store/marketplace-store';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

function createTemplate(overrides: Partial<MarketplaceTemplate> = {}): MarketplaceTemplate {
  return {
    _id: 'tmpl-1',
    slug: 'test-template',
    name: 'Test Template',
    shortDescription: 'A test template description',
    longDescription: 'Long description',
    type: 'agent',
    typeMetadata: null,
    detailSections: [],
    category: 'customer-service',
    subcategory: null,
    tags: ['test'],
    complexity: 'starter',
    publisherId: 'pub-1',
    publisherName: 'Publisher',
    publisherVerified: true,
    installCount: 1500,
    viewCount: 3000,
    ratingAverage: 4.5,
    ratingCount: 20,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TemplateCard', () => {
  it('renders template name and description', () => {
    render(<TemplateCard template={createTemplate()} />);
    expect(screen.getByText('Test Template')).toBeTruthy();
    expect(screen.getByText('A test template description')).toBeTruthy();
  });

  it('renders type badge', () => {
    render(<TemplateCard template={createTemplate({ type: 'project' })} />);
    expect(screen.getByText('Project')).toBeTruthy();
  });

  it('renders install count formatted', () => {
    render(<TemplateCard template={createTemplate({ installCount: 1500 })} />);
    expect(screen.getByText('1.5k')).toBeTruthy();
  });

  it('navigates to detail page on click', () => {
    mockPush.mockClear();
    render(<TemplateCard template={createTemplate({ slug: 'my-template' })} />);
    const card = screen.getByText('Test Template').closest('[class*="animate"]');
    if (card) fireEvent.click(card);
    expect(mockPush).toHaveBeenCalledWith('/marketplace/templates/my-template');
  });

  it('renders rating when > 0', () => {
    render(<TemplateCard template={createTemplate({ ratingAverage: 4.5 })} />);
    expect(screen.getByText('4.5')).toBeTruthy();
  });

  it('hides rating when 0', () => {
    render(<TemplateCard template={createTemplate({ ratingAverage: 0 })} />);
    expect(screen.queryByText('0.0')).toBeNull();
  });
});
