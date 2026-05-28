/**
 * FilterSelect Component Tests
 *
 * Tests for the custom dropdown select used in toolbar/filter bars.
 * Mocks createPortal to render inline so tests can query the menu.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// =============================================================================
// MOCKS
// =============================================================================

// Mock createPortal to render children inline instead of into document.body
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { FilterSelect } from '../../components/ui/FilterSelect';

// =============================================================================
// TEST DATA
// =============================================================================

const options = [
  { value: 'all', label: 'All Items' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

// =============================================================================
// TESTS
// =============================================================================

describe('FilterSelect', () => {
  const defaultProps = {
    options,
    value: 'all',
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders trigger button with selected label', () => {
    render(<FilterSelect {...defaultProps} />);
    expect(screen.getByRole('button', { name: /All Items/i })).toBeInTheDocument();
  });

  it('dropdown is closed by default', () => {
    render(<FilterSelect {...defaultProps} />);
    // Option buttons should not be visible when dropdown is closed
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('opens dropdown on click', () => {
    render(<FilterSelect {...defaultProps} />);
    const trigger = screen.getByRole('button', { name: /All Items/i });
    fireEvent.click(trigger);

    // All option labels should now be visible
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('shows all options in dropdown', () => {
    render(<FilterSelect {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));

    // There should be one button per option inside the menu, plus the trigger
    const buttons = screen.getAllByRole('button');
    // 1 trigger + 3 option buttons = 4
    expect(buttons.length).toBe(4);
  });

  it('shows check icon on selected option', () => {
    const { container } = render(<FilterSelect {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));

    // Lucide-react icons render with class "lucide lucide-check"
    const checkIcons = container.querySelectorAll('.lucide-check');
    expect(checkIcons.length).toBe(1);
  });

  it('calls onChange with value when option clicked', () => {
    const onChange = vi.fn();
    render(<FilterSelect {...defaultProps} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));

    // Click the "Active" option
    const optionButtons = screen.getAllByRole('button');
    const activeOption = optionButtons.find((btn) => btn.textContent?.includes('Active'));
    expect(activeOption).toBeDefined();
    fireEvent.click(activeOption!);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('active');
  });

  it('closes dropdown after selection', () => {
    const onChange = vi.fn();
    render(<FilterSelect {...defaultProps} onChange={onChange} />);

    // Open
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));
    expect(screen.getByText('Active')).toBeInTheDocument();

    // Select an option
    const optionButtons = screen.getAllByRole('button');
    const activeOption = optionButtons.find((btn) => btn.textContent?.includes('Active'));
    fireEvent.click(activeOption!);

    // Menu should be closed — "Archived" (non-selected, non-trigger option) should disappear
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('closes dropdown on Escape key', () => {
    render(<FilterSelect {...defaultProps} />);

    // Open
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));
    expect(screen.getByText('Active')).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    // Menu should be closed
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('chevron rotates when open', () => {
    const { container } = render(<FilterSelect {...defaultProps} />);

    // Lucide-react icons render with class "lucide lucide-chevron-down"
    const chevron = container.querySelector('.lucide-chevron-down') as Element;
    expect(chevron).toBeTruthy();

    // Closed state — should not have rotate-180
    expect(chevron.className).not.toContain('rotate-180');

    // Open
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));

    // Open state — chevron should have rotate-180 class
    const chevronOpen = container.querySelector('.lucide-chevron-down') as Element;
    expect(chevronOpen.className).toContain('rotate-180');
  });

  it('trigger has shrink-0 and whitespace-nowrap classes', () => {
    render(<FilterSelect {...defaultProps} />);
    const trigger = screen.getByRole('button', { name: /All Items/i });
    expect(trigger.className).toContain('whitespace-nowrap');

    // The container div should have shrink-0
    const container = trigger.parentElement;
    expect(container?.className).toContain('shrink-0');
  });

  it('multiple FilterSelects work independently', () => {
    const onChange1 = vi.fn();
    const onChange2 = vi.fn();

    const options2 = [
      { value: 'asc', label: 'Ascending' },
      { value: 'desc', label: 'Descending' },
    ];

    render(
      <>
        <FilterSelect options={options} value="all" onChange={onChange1} />
        <FilterSelect options={options2} value="asc" onChange={onChange2} />
      </>,
    );

    // Both triggers should render their selected labels
    expect(screen.getByRole('button', { name: /All Items/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ascending/i })).toBeInTheDocument();

    // Open first dropdown
    fireEvent.click(screen.getByRole('button', { name: /All Items/i }));
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Second dropdown options should not appear
    expect(screen.queryByText('Descending')).not.toBeInTheDocument();

    // Select from first dropdown
    const optionButtons = screen.getAllByRole('button');
    const archivedOption = optionButtons.find((btn) => btn.textContent?.includes('Archived'));
    fireEvent.click(archivedOption!);

    expect(onChange1).toHaveBeenCalledWith('archived');
    expect(onChange2).not.toHaveBeenCalled();

    // Now open second dropdown
    fireEvent.click(screen.getByRole('button', { name: /Ascending/i }));
    expect(screen.getByText('Descending')).toBeInTheDocument();
    // First dropdown options should not appear
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });
});
