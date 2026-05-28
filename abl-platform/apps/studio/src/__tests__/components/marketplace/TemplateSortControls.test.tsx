/**
 * TemplateSortControls Component Tests
 *
 * Tests the combined sort dropdown (field + direction in one select).
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TemplateSortControls } from '../../../components/marketplace/TemplateSortControls';
import { useMarketplaceStore } from '../../../store/marketplace-store';

// Mock apiFetch — external API boundary
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

describe('TemplateSortControls', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      sortField: 'installCount',
      sortDirection: 'desc',
    });
  });

  it('renders combined sort dropdown with current selection', () => {
    render(<TemplateSortControls />);

    // Combined dropdown shows "Downloads (Most First)" for installCount:desc
    expect(screen.getByText(/Downloads.*Most First/)).toBeTruthy();
  });

  it('displays views sort option when sortField is viewCount', () => {
    useMarketplaceStore.setState({ sortField: 'viewCount', sortDirection: 'desc' });

    render(<TemplateSortControls />);

    expect(screen.getByText(/Views.*Most First/)).toBeTruthy();
  });

  it('displays ascending direction', () => {
    useMarketplaceStore.setState({ sortField: 'name', sortDirection: 'asc' });

    render(<TemplateSortControls />);

    expect(screen.getByText(/Name.*A → Z/)).toBeTruthy();
  });
});
