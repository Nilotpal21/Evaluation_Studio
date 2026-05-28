/**
 * MarketplaceFilterPanel Component Tests
 *
 * Tests the category filter panel with checkbox list, show more/less,
 * and toggle callback.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarketplaceFilterPanel } from '../../../components/marketplace/MarketplaceFilterPanel';

const makeCategories = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `cat-${i + 1}`,
    count: (i + 1) * 10,
  }));

describe('MarketplaceFilterPanel', () => {
  it('renders first 5 categories with checkboxes', () => {
    const categories = makeCategories(5);
    const onToggle = vi.fn();

    render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={[]}
        onToggle={onToggle}
      />,
    );

    // All 5 categories should be visible
    for (const cat of categories) {
      expect(screen.getByText(String(cat.count))).toBeTruthy();
    }
  });

  it('shows "Show more" when more than 5 categories', () => {
    const categories = makeCategories(8);
    const onToggle = vi.fn();

    render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={[]}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText('Show more')).toBeTruthy();
    // The 6th category count should NOT be visible initially
    expect(screen.queryByText('60')).toBeNull();
  });

  it('expands all categories when "Show more" clicked', () => {
    const categories = makeCategories(8);
    const onToggle = vi.fn();

    render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={[]}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByText('Show more'));

    // Now all 8 categories should be visible
    expect(screen.getByText('80')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
  });

  it('collapses back when "Show less" clicked', () => {
    const categories = makeCategories(8);
    const onToggle = vi.fn();

    render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={[]}
        onToggle={onToggle}
      />,
    );

    // Expand
    fireEvent.click(screen.getByText('Show more'));
    expect(screen.getByText('Show less')).toBeTruthy();

    // Collapse
    fireEvent.click(screen.getByText('Show less'));
    expect(screen.getByText('Show more')).toBeTruthy();
    expect(screen.queryByText('80')).toBeNull();
  });

  it('calls onToggle when a checkbox is clicked', () => {
    const categories = makeCategories(3);
    const onToggle = vi.fn();

    render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={[]}
        onToggle={onToggle}
      />,
    );

    // Click the label wrapping the first category (the label element wraps checkbox + text)
    // The count "10" is unique to the first category
    const firstLabel = screen.getByText('10').closest('label');
    expect(firstLabel).toBeTruthy();
    fireEvent.click(firstLabel!);

    expect(onToggle).toHaveBeenCalledWith('cat-1');
  });

  it('shows checked state for selected categories', () => {
    const categories = makeCategories(3);
    const onToggle = vi.fn();

    const { container } = render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={['cat-2']}
        onToggle={onToggle}
      />,
    );

    // Radix Checkbox sets data-state="checked" when checked
    const checkboxes = container.querySelectorAll('[role="checkbox"]');
    expect(checkboxes).toHaveLength(3);

    // Second checkbox should be checked
    expect(checkboxes[1].getAttribute('data-state')).toBe('checked');
    // First and third should be unchecked
    expect(checkboxes[0].getAttribute('data-state')).toBe('unchecked');
    expect(checkboxes[2].getAttribute('data-state')).toBe('unchecked');
  });

  it('shows count badge for each category', () => {
    const categories = [
      { name: 'sales', count: 42 },
      { name: 'hr', count: 7 },
    ];
    const onToggle = vi.fn();

    render(
      <MarketplaceFilterPanel
        categories={categories}
        selectedCategories={[]}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });
});
