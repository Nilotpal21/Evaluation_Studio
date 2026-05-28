/**
 * Tests for AttributeTable component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttributeRegistryItem } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Override lucide-react mock — the Proxy-based global mock from setup.tsx
// hangs when resolving DataTable's barrel import. Provide explicit icons.
// (Same pattern as intelligence-hub.test.tsx)
// ---------------------------------------------------------------------------
vi.mock('lucide-react', () => {
  const icon = (props: Record<string, unknown>) => <svg data-testid="icon-mock" {...props} />;
  return {
    ChevronUp: icon,
    ChevronDown: icon,
    ChevronsUpDown: icon,
  };
});

import { AttributeTable } from '../../components/search-ai/attributes/AttributeTable';

function makeAttribute(overrides: Partial<AttributeRegistryItem> = {}): AttributeRegistryItem {
  return {
    _id: 'attr-1',
    tenantId: 'tenant-1',
    indexId: 'idx-1',
    attributeId: 'price',
    productScope: 'search',
    tier: 'approved',
    displayName: 'Price',
    dataType: 'number',
    aliases: [],
    definition: 'Product price',
    confidence: 0.85,
    documentCount: 120,
    exampleValues: ['9.99', '19.99'],
    sourceConnectors: ['shopify'],
    mergeHistory: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-15T00:00:00Z',
    ...overrides,
  } as AttributeRegistryItem;
}

const mockAttributes: AttributeRegistryItem[] = [
  makeAttribute({ _id: 'attr-1', attributeId: 'price', displayName: 'Price' }),
  makeAttribute({
    _id: 'attr-2',
    attributeId: 'category',
    displayName: 'Category',
    tier: 'beta',
    dataType: 'string',
    documentCount: 450,
    confidence: 0.72,
  }),
  makeAttribute({
    _id: 'attr-3',
    attributeId: 'brand',
    displayName: 'Brand',
    tier: 'permanent',
    dataType: 'string',
    documentCount: 300,
    confidence: 0.95,
  }),
];

describe('AttributeTable', () => {
  const onSelect = vi.fn();
  const onToggleSelect = vi.fn();
  const onToggleSelectAll = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders column headers', () => {
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    expect(screen.getByText('Attribute')).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Tier')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Docs')).toBeInTheDocument();
    expect(screen.getByText('Confidence')).toBeInTheDocument();
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('renders attribute rows with data', () => {
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    expect(screen.getByText('Price')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Brand')).toBeInTheDocument();
  });

  it('shows empty state when no attributes', () => {
    render(
      <AttributeTable
        attributes={[]}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    // DataTable renders emptyMessage when data is empty
    const emptyEl = screen.getByText(/no.*attributes|No attributes found/i);
    expect(emptyEl).toBeInTheDocument();
  });

  it('calls onToggleSelect when row checkbox is clicked', async () => {
    const user = userEvent.setup();
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    // First checkbox is select-all, rest are row checkboxes
    await user.click(checkboxes[1]);
    expect(onToggleSelect).toHaveBeenCalledWith('attr-1');
  });

  it('calls onSelect when row is clicked', async () => {
    const user = userEvent.setup();
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    await user.click(screen.getByText('Category'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ _id: 'attr-2' }));
  });

  it('shows selected count in header when items are selected', () => {
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set(['attr-1', 'attr-3'])}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('shows total count in header when no items are selected', () => {
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    expect(screen.getByText('3 attributes')).toBeInTheDocument();
  });

  it('calls onToggleSelectAll when select-all checkbox is clicked', async () => {
    const user = userEvent.setup();
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);
    expect(onToggleSelectAll).toHaveBeenCalled();
  });

  it('marks select-all checkbox as checked when all items are selected', () => {
    render(
      <AttributeTable
        attributes={mockAttributes}
        onSelect={onSelect}
        selectedIds={new Set(['attr-1', 'attr-2', 'attr-3'])}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    // First is select-all
    expect(checkboxes[0]).toBeChecked();
  });
});
