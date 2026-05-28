/**
 * TemplateManagerPage Component Tests
 *
 * Tests the admin template manager page: header, loading state, empty state,
 * template table rendering. Uses SWR mock to control data fetching state.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TemplateManagerPage } from '../../../components/admin/TemplateManagerPage';
import { useAuthStore } from '../../../store/auth-store';

// Mock SWR — external third-party package (controls data fetching state)
const mockMutate = vi.fn();
let mockSwrReturn: {
  data: { templates: Array<Record<string, unknown>> } | undefined;
  error: Error | undefined;
  isLoading: boolean;
  mutate: typeof mockMutate;
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// Mock sonner — external third-party package
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe('TemplateManagerPage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      tenantId: 'tenant-1',
    });
    mockSwrReturn = {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    };
  });

  it('renders page header with "Upload Template" button', () => {
    mockSwrReturn.data = {
      templates: [
        {
          id: 't1',
          slug: 'placeholder',
          name: 'Placeholder',
          type: 'project',
          category: 'general',
          status: 'published',
          installCount: 0,
          createdAt: '2026-01-01T00:00:00Z',
          version: '1.0.0',
        },
      ],
    };

    render(<TemplateManagerPage />);

    // Page header and table section both show "Templates Manager"
    expect(screen.getAllByText('Templates Manager').length).toBeGreaterThanOrEqual(1);
    // With templates present, only the header "Upload Template" button renders (no empty state)
    expect(screen.getByText('Upload Template')).toBeTruthy();
  });

  it('shows loading state', () => {
    mockSwrReturn.isLoading = true;

    render(<TemplateManagerPage />);

    // Loading spinner is rendered as a Loader2 icon
    expect(document.querySelector('[data-testid="icon-loader2"]')).toBeTruthy();
  });

  it('shows empty state when no templates', () => {
    mockSwrReturn.data = { templates: [] };
    mockSwrReturn.isLoading = false;

    render(<TemplateManagerPage />);

    expect(screen.getByText('No templates yet')).toBeTruthy();
    expect(screen.getByText('Upload a project export to create your first template')).toBeTruthy();
  });

  it('renders template table with columns', () => {
    mockSwrReturn.data = {
      templates: [
        {
          id: 't1',
          slug: 'customer-service-bot',
          name: 'Customer Service Bot',
          type: 'project',
          category: 'customer-service',
          status: 'published',
          installCount: 42,
          createdAt: '2026-03-15T00:00:00Z',
          version: '1.0.0',
          shortDescription: 'A customer service template',
        },
        {
          id: 't2',
          slug: 'hr-helper',
          name: 'HR Helper',
          type: 'agent',
          category: 'hr',
          status: 'draft',
          installCount: 7,
          createdAt: '2026-04-01T00:00:00Z',
          version: '1.0.0',
        },
      ],
    };
    mockSwrReturn.isLoading = false;

    render(<TemplateManagerPage />);

    // Column headers
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.getByText('Category')).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Installs')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Actions')).toBeTruthy();

    // Template data
    expect(screen.getByText('Customer Service Bot')).toBeTruthy();
    expect(screen.getByText('A customer service template')).toBeTruthy();
    expect(screen.getByText('HR Helper')).toBeTruthy();

    expect(screen.getByText('Showing 1-2 of 2')).toBeTruthy();
  });

  it('renders table row with template details', () => {
    mockSwrReturn.data = {
      templates: [
        {
          id: 't1',
          slug: 'sales-agent',
          name: 'Sales Agent',
          type: 'agent',
          category: 'sales',
          status: 'published',
          installCount: 100,
          createdAt: '2026-01-15T00:00:00Z',
          version: '1.0.0',
        },
      ],
    };
    mockSwrReturn.isLoading = false;

    render(<TemplateManagerPage />);

    expect(screen.getByText('Sales Agent')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
  });
});
